#!/usr/bin/env node
'use strict';

/*
 * Antigravity API — превращает аккаунт Antigravity (IDE) в полноценный
 * OpenAI-совместимый API-сервер с моделями твоего аккаунта:
 *   Gemini 3.x (Pro/Flash), Claude Opus/Sonnet 4.6, GPT-OSS 120B и др.
 *
 *   GET  /v1/models                    — список моделей (OpenAI-формат)
 *   POST /v1/chat/completions          — чат (OpenAI-формат, стрим и нет)
 *   GET  /v1beta/models                — список моделей (Gemini-формат)
 *   POST /v1beta/models/{m}:generateContent            — Gemini-формат
 *   POST /v1beta/models/{m}:streamGenerateContent      — Gemini-формат (SSE)
 *   POST /v1beta/models/{m}:countTokens
 *   GET  /_health, /_status, /         — статус
 *
 * Авторизация: свой API-ключ (apikey.txt), заголовок Authorization: Bearer <ключ>.
 * Апстрим: daily-cloudcode-pa.googleapis.com (бэкенд Antigravity, Cloud Code v1internal JSON).
 *
 * Без зависимостей. Node.js >= 18.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { TokenManager, startInteractiveOAuth, getOAuthStatus } = require('./lib/auth');
const { ModelCatalog } = require('./lib/models');
const { openAIToGeminiRequest, geminiToOpenAIResponse, GeminiStreamToOpenAI, sanitizeGeminiTools } = require('./lib/translate');
const { Guard, parseResetMs } = require('./lib/guard');
const { GeminiWebBridge } = require('./lib/web_bridge');
const { fetchWithFallback, netWhy } = require('./lib/fetch_fallback');
const { NetworkManager } = require('./lib/net');
const { requestError, parseRequestBody, validateOpenAI, validateGemini, sseData, parseUpstreamData, upstreamErrorBody, sendApiError } = require('./lib/http_helpers');
const { diagnosticError, normalizeDiagnosticError, executeDiagnosticChat } = require('./lib/diagnostics');
const agent = require('./lib/agent');
const providers = require('./lib/providers');
const planner = require('./lib/planner');
const { stripBom, readJsonFile, writeFileAtomic, backupFile, restoreLatestBackup } = require('./lib/safe_files');
const configLib = require('./lib/config');
const { applyThinkingConfig } = require('./lib/thinking');
const anthropic = require('./lib/anthropic');
const { autoExtract } = require('./lib/token_extract');
const { detectProxies } = require('./lib/proxy_detect');
const installsLib = require('./lib/installs');
const cdpCookies = require('./lib/cdp_cookies');
const shortcuts = require('./scripts/shortcuts');
const updater = require('./scripts/update');
const { resolvePublicAsset, normalizeIconTheme } = require('./lib/theme_icons');
const { resolveDataDir, migrateLegacyStateFiles } = require('./lib/data_dir');
const { FreeTunnelManager, convertTelegramSocksLink } = require('./lib/free_tunnel');

const ROOT = __dirname; // код
// На Windows по умолчанию мутабельные файлы живут в %LOCALAPPDATA%\AntigravityAPI,
// чтобы Controlled Folder Access (защита папки «Документы») никогда не блокировал node.exe.
const DATA_DIR = resolveDataDir({ rootDir: ROOT });

// AG_NO_CLOUD=1 — режим «только веб-модели»: контейнеру без auth.json не нужен
// OAuth-токен Antigravity. cloud/* отвечают понятной ошибкой, /v1/models
// показывает только web/*.
const CLOUD_DISABLED = /^(1|true|yes)$/i.test(String(process.env.AG_NO_CLOUD || '').trim());

// Версия приложения: панель и дашборд показывают её пользователю.
const APP_VERSION = (() => {
  try { return String(require('./package.json').version || '0.0.0'); } catch { return '0.0.0'; }
})();

// Запас к max_tokens клиента на размышления (config.outputHeadroomTokens / AG_OUTPUT_HEADROOM).
const OUTPUT_HEADROOM_DEFAULT = 256;
let OUTPUT_HEADROOM = OUTPUT_HEADROOM_DEFAULT;
const ADMIN_KEY_FILE = 'admin.key';

// Единственный источник истины по дефолтам — lib/config/defaults.js.
const DEFAULT_CONFIG = configLib.DEFAULTS;

// Санитизация текстов ошибок перед отправкой клиенту: прячем всё, что похоже
// на токен/ключ (20+ символов букв/цифр) — в сообщениях апстрима могут быть
// access_token, api-ключи и SID-куки.
function redactSecrets(text) {
  return String(text).replace(/[A-Za-z0-9+/=_-]{20,}/g, (m) => (
    /[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m
  ));
}

const isPlainObject = configLib.isPlainObject;

function newApiKey() {
  return 'agk_' + crypto.randomBytes(24).toString('hex');
}

function newAdminKey() {
  return 'agadm_' + crypto.randomBytes(24).toString('hex');
}

function readKeyFile(file) {
  try {
    const key = stripBom(fs.readFileSync(file, 'utf8')).trim();
    return /^\S+$/.test(key) ? key : '';
  } catch {
    return '';
  }
}

// Два секрета с разными правами:
//   apiKey   — то, что получает клиент моделей (Cursor/Cline/скрипты). Только /v1*.
//   adminKey — то, что защищает /_* и HTML-дашборд. Клиентам НЕ выдаётся:
//              иначе один ключ позволяет переписать proxy/config (а через proxy
//              увести OAuth-токен Google для cloud-пути).
function writePrivateFileAtomic(file, content) {
  backupFile(file);
  writeFileAtomic(file, content);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch {}
  }
}

function ensureAdminKey(root, config) {
  const file = path.join(root, ADMIN_KEY_FILE);
  const kept = readKeyFile(file);
  if (!config.adminKey) config.adminKey = kept.length >= 16 ? kept : newAdminKey();
  if (kept !== config.adminKey) {
    writePrivateFileAtomic(file, config.adminKey + '\n');
  }
  return config;
}

function persistConfig(file, config) {
  writePrivateFileAtomic(file, JSON.stringify(config, null, 2));
}

// Порт/адрес из окружения действуют только на текущий запуск и НЕ попадают в
// config.json: иначе том «залипает» на 0.0.0.0 после первого docker compose up.
function envListen(config) {
  const rawPort = process.env.AG_PORT;
  const envPort = Number(rawPort);
  const port = rawPort && Number.isFinite(envPort) && envPort > 0 && envPort < 65536
    ? Math.round(envPort) : config.port;
  const host = (process.env.AG_HOST || '').trim() || config.host;
  return { port, host };
}

// config.json — источник истины для ключа; apikey.txt — его копия для людей и панели.
function loadConfig(root = DATA_DIR) {
  // Автомиграция конфигов из старой папки проекта в %LOCALAPPDATA%\AntigravityAPI (только чтение из ROOT).
  if (root === DATA_DIR) {
    try { migrateLegacyStateFiles({ rootDir: ROOT, dataDir: DATA_DIR }); } catch {}
  }
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  const file = path.join(root, 'config.json');
  const keyFile = path.join(root, 'apikey.txt');
  if (!fs.existsSync(file)) {
    // apikey.txt пережил удаление config.json — оставляем ключ, чтобы клиенты не сломались.
    const kept = readKeyFile(keyFile);
    const { config } = configLib.normalize({ apiKey: kept.length >= 16 ? kept : newApiKey() });
    ensureAdminKey(root, config);
    writePrivateFileAtomic(file, JSON.stringify(config, null, 2));
    if (kept !== config.apiKey) {
      writePrivateFileAtomic(keyFile, config.apiKey + '\n');
    }
    return { config, created: true, warnings: [] };
  }
  let raw;
  try {
    raw = readJsonFile(file);
    if (!isPlainObject(raw)) throw new Error('ожидается JSON-объект');
  } catch (e) {
    const restored = restoreLatestBackup(file, { validate: isPlainObject });
    if (!restored) {
      throw new Error(`config.json повреждён (${e.message}), а в backups/ нет целой копии — исправьте файл вручную.`);
    }
    console.warn(`  ! config.json был повреждён (${e.message}) — восстановлен из backups/${path.basename(restored.from)}`);
    raw = restored.data;
  }

  const { config, warnings } = configLib.normalize(raw);
  let dirty = warnings.length > 0 || Number(raw.configVersion) !== configLib.CONFIG_VERSION;

  if (!config.apiKey) {
    const kept = readKeyFile(keyFile);
    config.apiKey = kept.length >= 16 ? kept : newApiKey();
    dirty = true;
  }
  const keptAdmin = readKeyFile(path.join(root, ADMIN_KEY_FILE));
  if (!config.adminKey) {
    config.adminKey = keptAdmin.length >= 16 ? keptAdmin : newAdminKey();
    dirty = true;
  }
  ensureAdminKey(root, config);

  // Миграции/докидывание ключа сохраняем сразу: иначе каждый старт будет
  // повторять одну и ту же миграцию на старом файле.
  if (dirty) persistConfig(file, config);

  if (readKeyFile(keyFile) !== config.apiKey) {
    writePrivateFileAtomic(keyFile, config.apiKey + '\n');
  }
  return { config, created: false, warnings };
}

const CLOUD_CODE_CL = '1003475615';
const DEFAULT_IDE_VERSION = '2.29.0';

function officialUserAgent(version = DEFAULT_IDE_VERSION) {
  const osType = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return `antigravity/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${CLOUD_CODE_CL})`;
}

// Google отдаёт группу Gemini Models (gemini-weekly/gemini-5h) только
// официальной подписи клиента; старый antigravity/1.x получал урезанную сводку.
function resolveCloudCodeUserAgent(configured) {
  const raw = String(configured || '').trim();
  if (!raw) return officialUserAgent();
  if (/aidev_client/i.test(raw)) return raw;
  const m = raw.match(/^antigravity\/([0-9][0-9.]*)/i);
  if (!m) return raw;
  const version = m[1].startsWith('1.') ? DEFAULT_IDE_VERSION : m[1].replace(/\.$/, '');
  return officialUserAgent(version);
}

function sendJson(res, status, obj) {  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- вызов апстрима ----------

class Upstream {
  constructor(config, tokens, catalog, network = null) {
    this.config = config;
    this.tokens = tokens;
    this.catalog = catalog;
    this.network = network;
    this.refreshCount = 0;
    this.requestCount = 0;
  }

  // fetch к апстриму с фолбэком daily -> prod при СЕТЕВОЙ ошибке
  async upFetch(path, opts = {}) {
    // Первый запрос ждёт однократный поиск локального relay-DNS (AGUnlocker).
    if (this.network && this.network.autoDetect) await this.network.autoDetect();
    try {
      return await fetchWithFallback(
        this.config.upstreamHost,
        this.config.upstreamFallbackHost,
        path,
        opts,
        this.network ? (url, fetchOpts) => this.network.fetch(url, fetchOpts, 'upstream') : fetch,
      );
    } catch (error) {
      const status = error?.name === 'TimeoutError' || opts.signal?.reason?.name === 'TimeoutError' ? 504 : 502;
      throw requestError(`Antigravity upstream: ${netWhy(error)}`, status);
    }
  }

  headers(token) {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': this.config.userAgent,
    };
  }

  async generateContent(model, requestObj, { signal } = {}) {
    if (requestObj && requestObj.tools) {
      requestObj.tools = sanitizeGeminiTools(requestObj.tools);
    }
    const payload = { model, request: requestObj };
    if (this.tokens.projectId) payload.project = this.tokens.projectId;
    const token = await this.tokens.getAccessToken();
    this.requestCount++;
    return this.upFetch('/v1internal:generateContent?alt=sse', {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(this.config.requestTimeoutMs),
    });
  }

  async countTokens(model, requestObj) {
    // v1internal:countTokens принимает только request.model/contents —
    // внешние model/project/userAgent и safetySettings дают 400 Unknown name.
    const inner = { model: `models/${model}` };
    if (requestObj && requestObj.contents) inner.contents = requestObj.contents;
    const sys = requestObj && (requestObj.systemInstruction || requestObj.system_instruction);
    if (sys) inner.systemInstruction = sys;
    const payload = { request: inner };
    const token = await this.tokens.getAccessToken();
    this.requestCount++;
    return this.upFetch('/v1internal:countTokens', {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
  }

  // Генерация с одним повтором после обновления токена.
  // Повторяем только «токенные» 401/403: у постоянного 403 (нет доступа к
  // модели/проекту) второй запрос ничего не даст, только удвоит расход.
  async generateWithRetry(model, requestObj, { signal } = {}) {
    const res = await this.generateContent(model, requestObj, { signal });
    if (res.status !== 401 && res.status !== 403) return res;

    let body = '';
    try { body = await res.text(); } catch {}
    const tokenIssue = res.status === 401
      || /invalid_grant|access_token|token.*expired|expired.*token|unauthenticated|invalid credentials|login required/i.test(body);
    if (!tokenIssue) {
      // Тело уже прочитано — отдаём обёртку со скопированным status/ok/headers
      // (нативный fetch Response держит их на прототипе, Object.assign их терял).
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText || '',
        headers: res.headers,
        body: res.body,
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    }

    // Один refresh на всех: параллельные запросы не должны дёргать OAuth каждый сам.
    if (!this._refreshPromise) {
      this._refreshPromise = (async () => {
        this.tokens.accessToken = '';
        this.tokens.expiresAt = 0;
        this.refreshCount++;
        try {
          await this.tokens.getAccessToken();
        } finally {
          this._refreshPromise = null;
        }
      })();
    }
    await this._refreshPromise;
    return this.generateContent(model, requestObj, { signal });
  }

  // Информация об аккаунте (tier/проект/регион/email) — кэш 5 минут, best-effort.
  async getAccountInfo({ force = false } = {}) {
    if (!force && this._accInfo && Date.now() - this._accInfoAt < 300000) return this._accInfo;
    try {
      const token = await this.tokens.getAccessToken();
      const emailP = typeof this.tokens.ensureEmail === 'function'
        ? this.tokens.ensureEmail().catch(() => this.tokens.email || '')
        : Promise.resolve(this.tokens.email || '');
      const meta = {
        metadata: {
          ideType: 'ANTIGRAVITY',
          ideName: 'antigravity',
          ideVersion: (String(this.config.userAgent || '').match(/antigravity\/([0-9.]+)/i) || [])[1] || DEFAULT_IDE_VERSION,
        },
        cloudaicompanionProject: this.tokens.projectId || '',
      };
      const [tierRes, userRes, email] = await Promise.all([
        this.upFetch('/v1internal:loadCodeAssist', {
          method: 'POST', headers: this.headers(token), body: JSON.stringify(meta), signal: AbortSignal.timeout(15000),
        }),
        this.upFetch('/v1internal:fetchUserInfo', {
          method: 'POST', headers: this.headers(token), body: '{}', signal: AbortSignal.timeout(15000),
        }),
        emailP,
      ]);
      const tier = tierRes.ok ? await tierRes.json().catch(() => null) : null;
      const user = userRes.ok ? await userRes.json().catch(() => null) : null;
      this._accInfo = {
        tier: tier?.currentTier?.name ?? null,
        tierId: tier?.currentTier?.id ?? null,
        paidTier: tier?.paidTier?.name ?? null,
        paidTierId: tier?.paidTier?.id ?? null,
        project: tier?.cloudaicompanionProject ?? null,
        region: user?.regionCode ?? null,
        email: email || this.tokens.email || null,
        authSource: this.tokens.authSource || null,
        fetchedAt: new Date().toISOString(),
      };
      if (this._accInfo.project && !this.tokens.projectId && this.catalog) {
        this.catalog.project = this._accInfo.project;
      }
      this._accInfoAt = Date.now();
      return this._accInfo;
    } catch (e) {
      return { error: netWhy(e), fetchedAt: new Date().toISOString() };
    }
  }

  // Реальная сводка официальных квот Google Cloud Code (retrieveUserQuotaSummary) — кэш 30 сек
  async getQuotaSummary({ force = false } = {}) {
    if (!force && this._quotaSummary && Date.now() - this._quotaSummaryAt < 30000) return this._quotaSummary;
    try {
      const token = await this.tokens.getAccessToken();
      const proj = this.tokens.projectId || this._accInfo?.project || '';
      const bodyStr = proj ? JSON.stringify({ project: proj }) : '{}';
      const res = await this.upFetch('/v1internal:retrieveUserQuotaSummary', {
        method: 'POST',
        headers: this.headers(token),
        body: bodyStr,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { error: `HTTP ${res.status}: ${text.slice(0, 100)}`, fetchedAt: new Date().toISOString() };
      }
      const data = await res.json();
      const groups = (data.groups || []).map((g) => ({
        name: g.group || '',
        displayName: g.displayName || g.group || '',
        description: g.description || '',
        buckets: (g.buckets || []).map((b) => ({
          bucketId: b.bucketId || '',
          displayName: b.displayName || '',
          window: b.window || '',
          remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
          remainingPercent: typeof b.remainingFraction === 'number' ? Math.floor(b.remainingFraction * 1000) / 10 : null,
          resetTime: b.resetTime || null,
          description: b.description || '',
          disabled: !!b.disabled,
        })),
      }));
      this._quotaSummary = {
        raw: data,
        groups,
        description: data.description || '',
        fetchedAt: new Date().toISOString(),
      };
      this._quotaSummaryAt = Date.now();
      return this._quotaSummary;
    } catch (e) {
      return { error: netWhy(e), fetchedAt: new Date().toISOString() };
    }
  }
}

// ---------- обработчики ----------

function syncOutputHeadroom(cfg) {
  const envHead = process.env.AG_OUTPUT_HEADROOM;
  const headRaw = envHead != null && envHead !== '' ? Number(envHead) : Number(cfg && cfg.outputHeadroomTokens);
  OUTPUT_HEADROOM = Number.isFinite(headRaw)
    ? Math.max(0, Math.min(8192, Math.round(headRaw))) : OUTPUT_HEADROOM_DEFAULT;
}

function start(config) {
  config.userAgent = resolveCloudCodeUserAgent(config.userAgent);
  syncOutputHeadroom(config);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch (e) {
    console.error(`\n  ! Каталог данных ${DATA_DIR} недоступен для записи: ${e.message}`);
    console.error('    В Docker: chown -R 1000:1000 ./data (или user: "1000:1000" в compose).\n');
    process.exit(1);
  }
  const freeTunnel = new FreeTunnelManager(DATA_DIR);
  const buildEffectiveRuntimeConfig = () => {
    const ftEnabled = !!(config.geminiWeb && config.geminiWeb.freeTunnel && config.geminiWeb.freeTunnel.enabled);
    const ftProxy = ftEnabled ? freeTunnel.getActiveProxyUrlSync() : '';
    const effectiveWebProxy = (config.geminiWeb && config.geminiWeb.proxy) || ftProxy || '';
    return {
      ...config,
      geminiWeb: {
        ...(config.geminiWeb || {}),
        proxy: effectiveWebProxy,
      },
    };
  };

  const network = new NetworkManager(buildEffectiveRuntimeConfig());
  if (network.autoDetect) network.autoDetect();
  const authFile = process.env.AG_AUTH_FILE || path.join(DATA_DIR, 'auth.json');
  let tokens;
  if (CLOUD_DISABLED) {
    const cloudOff = () => {
      const e = new Error('cloud-модели отключены (AG_NO_CLOUD=1). Работают только web/* модели.');
      e.status = 503;
      e.code = 'cloud_disabled';
      return e;
    };
    tokens = {
      projectId: '',
      email: '',
      hasCredentials: () => false,
      reloadFromDisk: () => false,
      getAccessToken: async () => { throw cloudOff(); },
      summary: () => ({ configured: false, email: '', projectId: '', accessTokenValidForSec: 0, hasRefreshToken: false }),
    };
  } else {
    tokens = new TokenManager(authFile, { network, allowMissing: true });
    if (!tokens.hasCredentials()) {
      console.log(`\n  i ${path.basename(authFile)} не найден — сервер запущен в режиме Web-Only (web/* модели).`);
      console.log('    Подключите токен Antigravity в веб-панели или командой: npm run extract-token\n');
    }
  }
  const catalog = new ModelCatalog(config.upstreamHost, {
    project: tokens.projectId,
    userAgent: config.userAgent,
    fallbackHost: config.upstreamFallbackHost,
    network,
    registryFile: path.join(DATA_DIR, 'known_models.json'),
  });
  const upstream = new Upstream(config, tokens, catalog, network);
  const guard = new Guard(config.safeMode || {}, process.env.AG_USAGE_FILE || path.join(DATA_DIR, 'usage.json'));

  function persistRotatedCookie(cookie, accountName = '') {
    try {
      const ws = config.geminiWeb || {};
      if (accountName && Array.isArray(ws.accounts)) {
        const acc = ws.accounts.find((a) => a && a.name === accountName);
        if (acc) {
          if (acc.cookie_file && !acc.cookie) {
            const file = path.isAbsolute(acc.cookie_file) ? acc.cookie_file : path.join(DATA_DIR, acc.cookie_file);
            backupFile(file);
            writeFileAtomic(file, cookie + '\n');
            return;
          }
          acc.cookie = cookie;
        }
      } else if (ws.cookie_file) {
        const file = path.isAbsolute(ws.cookie_file) ? ws.cookie_file : path.join(DATA_DIR, ws.cookie_file);
        backupFile(file);
        writeFileAtomic(file, cookie + '\n');
        return;
      } else {
        config.geminiWeb = { ...ws, cookie };
      }
      if (config.persistConfig !== false) {
        const cfgPath = path.join(DATA_DIR, 'config.json');
        backupFile(cfgPath);
        writeFileAtomic(cfgPath, JSON.stringify(config, null, 2));
      }
    } catch {}
  }

  function persistActiveAccount(name) {
    try {
      config.geminiWeb = { ...(config.geminiWeb || {}), activeAccount: name };
      if (config.persistConfig !== false) {
        const cfgPath = path.join(DATA_DIR, 'config.json');
        backupFile(cfgPath);
        writeFileAtomic(cfgPath, JSON.stringify(config, null, 2));
      }
    } catch {}
  }

  const webBridge = new GeminiWebBridge({
    ...(buildEffectiveRuntimeConfig().geminiWeb || {}), network,
    catalogCacheFile: path.join(DATA_DIR, 'web_models.json'),
    onCookieRotated: persistRotatedCookie,
    onAccountSwitch: persistActiveAccount,
  });
  const syncRuntimeTunnelToBridge = () => {
    const eff = buildEffectiveRuntimeConfig();
    network.updateConfig(eff);
    webBridge.updateConfig(eff.geminiWeb);
  };
  // Строго opt-in: запускаем авто-туннель только если пользователь сам включил его ранее.
  if (config.geminiWeb && config.geminiWeb.freeTunnel && config.geminiWeb.freeTunnel.enabled === true) {
    freeTunnel.start({ customSource: config.geminiWeb.freeTunnel.customSource || '' })
      .then(() => {
        syncRuntimeTunnelToBridge();
        webBridge.refreshModels().catch(() => {});
      })
      .catch(() => {});
  } else if (webBridge.enabled && (webBridge.getLoadedCookie().cookieStr || network.summary().proxy)) {
    webBridge.refreshModels().catch(() => {});
  }
  webBridge.ensureBlFresh(true).catch(() => {});
  const netSummary = network.summary();
  if (netSummary.active) {
    const dnsLabel = netSummary.dnsMode === 'doh' ? `DoH ${netSummary.dohHost}`
      : netSummary.dnsMode === 'custom' ? `DNS ${netSummary.dnsServers.join(', ')}`
        : 'system DNS';
    console.log(`  Network: ${netSummary.proxy ? 'proxy ' + netSummary.proxy : 'direct'} · ${dnsLabel}`);
  }
  const log = [];
  const stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, blocked: 0 };
  let lastCatalogError = '';
  const waitNetworkReady = async () => {
    if (network && typeof network.autoDetect === 'function') {
      try {
        await Promise.race([network.autoDetect(), new Promise((r) => setTimeout(r, 1500))]);
      } catch {}
    }
  };
  const eventClients = new Set();

  const broadcastEvent = (type, payload) => {
    if (!eventClients.size) return;
    const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of eventClients) {
      try {
        if (!client.writableEnded && !client.destroyed) client.write(msg);
      } catch {}
    }
  };

  const pushLog = (e) => {
    stats.requests++;
    if (e.error) stats.errors++;
    const safeEntry = {
      ts: new Date().toISOString(),
      ...e,
      ...(typeof e.error === 'string' ? { error: redactSecrets(e.error) } : {}),
    };
    log.push(safeEntry);
    if (log.length > 200) log.shift();
    console.log(
      `  [${safeEntry.kind}] ${safeEntry.model || ''} ${safeEntry.status ?? ''} ${safeEntry.ms ?? ''}ms ${safeEntry.error ? 'ERR ' + safeEntry.error : 'OK'} ${safeEntry.quota ? '(' + safeEntry.quota + ')' : ''}`.trimEnd()
    );
    broadcastEvent('log', { entry: safeEntry, stats: { ...stats, uptime: Math.floor(process.uptime()) } });
  };

  const withRetry429 = async (fn) => {
    let attempt = 0;
    // 429 не ретраим мгновенно (квота) — только 5xx
    let res = await fn();
    while ([500, 502, 503, 504].includes(res.status) && attempt < config.retries) {
      attempt++;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      // Отброшенный ответ надо опустошить, иначе keep-alive соединение и сокет
      // висят, пока не истечёт таймаут.
      await discardBody(res);
      res = await fn();
    }
    return res;
  };

  async function discardBody(res) {
    if (!res || !res.body) return;
    try { await res.body.cancel?.(); } catch {}
    try { res.body.destroy?.(); } catch {}
  }

  // Модели вроде gemini-4-hydrogen-sonar тратят ~160 токенов на размышления даже
  // на «2+2», а max_tokens клиента ограничивает ОБЩИЙ бюджет. При max_tokens=64
  // видимого текста не остаётся: приходит пустой ответ с finish=length.
  // Диагностика не ставит лимит, поэтому там всё работает. Добавляем запас на
  // размышления и один повтор, если его всё равно не хватило.
  function applyOutputHeadroom(requestObj) {
    const gc = requestObj && requestObj.generationConfig;
    if (!gc || !Number.isFinite(gc.maxOutputTokens)) return requestObj;
    const want = Math.round(gc.maxOutputTokens);
    if (want <= 0 || OUTPUT_HEADROOM <= 0) return requestObj;
    gc.maxOutputTokens = Math.min(65536, want + OUTPUT_HEADROOM);
    return requestObj;
  }

  function retryRequestWithBudget(requestObj, extra = 2048) {
    if (OUTPUT_HEADROOM <= 0) return null;
    let clone;
    try { clone = JSON.parse(JSON.stringify(requestObj)); } catch { return null; }
    const gc = clone.generationConfig = { ...(clone.generationConfig || {}) };
    const cur = Number(gc.maxOutputTokens) || 0;
    if (!cur) return null;
    const next = Math.min(65536, cur + extra);
    if (next <= cur) return null;
    gc.maxOutputTokens = next;
    return clone;
  }

  function openAIAnswerEmpty(out) {
    const choice = out && out.choices && out.choices[0];
    return !!choice && !String(choice.message?.content || '').trim() && choice.finish_reason === 'length';
  }

  function geminiAnswerEmpty(merged) {
    const cand = merged && merged.candidates && merged.candidates[0];
    if (!cand || cand.finishReason !== 'MAX_TOKENS') return false;
    const parts = cand.content?.parts || [];
    return !parts.some((p) => !p.thought && typeof p.text === 'string' && p.text.trim());
  }

  function anthropicAnswerEmpty(out) {
    if (!out || out.stop_reason !== 'max_tokens') return false;
    return !(out.content || []).some((b) => b.type === 'text' && String(b.text || '').trim());
  }

  // Клиент ушёл (закрыл чат/вкладку) — незачем держать запрос к Google.
  // 'close' на res приходит и после нормального res.end(); отменяем только
  // незавершённый ответ.
  function clientGone(res) {
    return res.destroyed || (res.socket ? res.socket.destroyed : false) || (res.closed === true && !res.writableEnded);
  }

  function abortedError() {
    const e = new Error('client disconnected');
    e.code = 'client_disconnected';
    return e;
  }

  // Тело, привязанное к жизни клиента: закрытие ответа обрывает чтение апстрима.
  async function* bodyWhileConnected(res, body) {
    if (!body) return;
    let closed = false;
    const onClose = () => { closed = true; };
    res.once('close', onClose);
    try {
      for await (const chunk of body) {
        if (closed || clientGone(res)) throw abortedError();
        yield chunk;
      }
    } finally {
      res.removeListener('close', onClose);
    }
  }

  // Обёртка «безопасного режима»: проверка лимитов → пауза → слот → работа → отчёт.
  async function guarded(res, model, kind, fn) {    const ticket = await guard.acquire(model);
    if (!ticket.ok) {
      stats.blocked++;
      pushLog({ kind: 'guard', model, status: 429, error: ticket.reason.slice(0, 140) });
      res.writeHead(429, {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(ticket.retryAfterSec || 30),
      });
      res.end(JSON.stringify({ error: { message: ticket.reason, type: 'rate_limit_error', code: 429 } }));
      return null;
    }
    try {
      return await fn();
    } finally {
      ticket.release();
    }
  }

  const extractQuotaInfo = (text) => {
    try {
      const j = JSON.parse(text);
      const d = j.error?.details ?? [];
      for (const x of d) {
        const q = x.quotaResetDelay ?? x.retryDelay;
        if (q) return 'reset ' + q;
      }
      const m = j.error?.message?.match(/Resets in ([^."]+)/);
      if (m) return 'reset ' + m[1];
    } catch {}
    return '';
  };

  // 16 МБ достаточно для чата с base64-картинками; 64 МБ давали пик памяти
  // ~128 МБ на запрос (Buffer.concat + toString) и не приносили пользы.
  const MAX_BODY_BYTES = Number(process.env.AG_MAX_BODY_BYTES) > 0
    ? Number(process.env.AG_MAX_BODY_BYTES) : 16 * 1024 * 1024;
  const MB = (n) => `${Math.round(n / (1024 * 1024))} МБ`;

  function bodyTooLargeError() {
    const err = new Error(`Тело запроса больше ${MB(MAX_BODY_BYTES)}`);
    err.status = 413;
    err.code = 'body_too_large';
    return err;
  }

  // Сбросить остаток отклонённого тела, не убивая сокет мгновенно.
  // Если оборвать соединение с непрочитанными входящими данными, ядро отвечает
  // RST и уже отправленный 413 может потеряться на стороне клиента.
  // Поэтому дочитываем и выбрасываем — но только до потолка и с таймаутом.
  function drainRejectedBody(req) {
    const cap = MAX_BODY_BYTES * 2;
    let extra = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      try { req.destroy(); } catch {}
    };
    const onData = (chunk) => {
      extra += chunk.length;
      if (extra > cap) finish();
    };
    const timer = setTimeout(finish, 2000);
    if (timer.unref) timer.unref();
    req.on('data', onData);
    req.once('end', finish);
    req.once('error', finish);
    req.resume();
  }

  async function readBody(req) {
    // Content-Length известен заранее — нет повода прочитать 16 МБ ради отказа.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw bodyTooLargeError();

    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Никакого req.destroy() здесь: он убивает сокет и клиент получает RST
        // вместо диагностики. Оборвёт соединение readBodyOrRespond после ответа.
        req.pause();
        throw bodyTooLargeError();
      }
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // Чтение тела с ответом клиенту: 413 при превышении лимита, 400 при обрыве.
  // 413 уходит ДО закрытия сокета, поэтому клиент видит JSON, а не «socket hang up».
  async function readBodyOrRespond(req, res) {
    try {
      return { ok: true, raw: await readBody(req) };
    } catch (err) {
      const tooLarge = err && err.status === 413;
      const status = tooLarge ? 413 : 400;
      const payload = JSON.stringify({ error: {
        message: tooLarge
          ? `Тело запроса больше ${MB(MAX_BODY_BYTES)}. Сократите сообщение или вложения.`
          : 'Не удалось прочитать тело запроса (соединение оборвано).',
        type: 'invalid_request_error',
        code: tooLarge ? 'body_too_large' : 'body_read_failed',
      } });
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          ...(tooLarge ? { connection: 'close' } : {}),
        });
        res.end(payload);
        if (tooLarge) drainRejectedBody(req);
      }
      return { ok: false };
    }
  }

  // Сравнение ключей без тайминг-утечки (длина + timingSafeEqual).
  function keyEquals(given, expected) {
    if (!expected) return false;
    const a = Buffer.from(String(given || ''), 'utf8');
    const b = Buffer.from(String(expected), 'utf8');
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch { return false; }
  }

  function presentedKeys(req) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let query = '';
    try { query = new URL(req.url, 'http://localhost').searchParams.get('key') || ''; } catch {}
    return [bearer, req.headers['x-goog-api-key'], req.headers['x-api-key'], req.headers['x-admin-key'], query];
  }

  // ---- админ-сессии и одноразовые launch-токены ----
  const adminSessions = new Map(); // sid -> expiresAt
  const launchNonces = new Map(); // nonce -> expiresAt
  if (process.env.AG_LAUNCH_NONCE) {
    launchNonces.set(String(process.env.AG_LAUNCH_NONCE), Date.now() + 180_000);
  }

  function parseCookies(req) {
    const out = {};
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }

  function isSameOriginAsHost(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser CLI/test or same-origin GET
    if (origin === 'null') return false;
    try {
      const u = new URL(String(origin).trim());
      return u.host.toLowerCase() === String(req.headers.host || '').trim().toLowerCase();
    } catch {
      return false;
    }
  }

  function sessionOk(req) {
    const sid = parseCookies(req).ag_admin_session;
    if (!sid) return false;
    // Block cross-origin / cross-port CSRF against session cookies
    if (!isSameOriginAsHost(req)) return false;
    const exp = adminSessions.get(sid);
    if (!exp) return false;
    if (exp < Date.now()) {
      adminSessions.delete(sid);
      return false;
    }
    return true;
  }

  function issueSessionCookie(res) {
    const now = Date.now();
    for (const [k, v] of adminSessions) {
      if (v < now) adminSessions.delete(k);
    }
    while (adminSessions.size >= 100) {
      adminSessions.delete(adminSessions.keys().next().value);
    }
    const sid = crypto.randomBytes(24).toString('hex');
    adminSessions.set(sid, now + 24 * 3600 * 1000);
    res.setHeader('set-cookie', `ag_admin_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    return sid;
  }

  function mintLaunchNonce() {
    const now = Date.now();
    for (const [k, v] of launchNonces) {
      if (v < now) launchNonces.delete(k);
    }
    const nonce = crypto.randomBytes(24).toString('hex');
    launchNonces.set(nonce, now + 120_000);
    return nonce;
  }

  function consumeLaunchNonce(nonce) {
    if (!nonce) return false;
    const exp = launchNonces.get(nonce);
    launchNonces.delete(nonce);
    return !!exp && exp >= Date.now();
  }

  // Ключ клиентов моделей: только /v1*.
  function authOk(req) {
    return presentedKeys(req).some((k) => keyEquals(k, config.apiKey));
  }

  // Админский ключ: /_* и веб-панель. В тестах/кастомных запусках adminKey
  // может отсутствовать — тогда допускаем apiKey (так работают фикстуры).
  function adminOk(req) {
    const expected = config.adminKey || config.apiKey;
    return presentedKeys(req).some((k) => keyEquals(k, expected)) || sessionOk(req);
  }

  // Чтение состояния: доступно обоим ключам (не даёт менять конфиг).
  function statusOk(req) {
    return adminOk(req) || authOk(req);
  }

  // Сохранение config.json: нормализованный объект целиком, с бэкапом.
  // Путь — DATA_DIR: в Docker /app только для чтения.
  function saveConfigFile() {
    if (config.persistConfig === false) return null;
    try {
      const cfgPath = path.join(DATA_DIR, 'config.json');
      backupFile(cfgPath);
      writeFileAtomic(cfgPath, JSON.stringify(config, null, 2));
      return null;
    } catch (e) {
      console.error('Failed to save config.json:', e);
      return e;
    }
  }

  // Мутация списка веб-аккаунтов: add | update | remove | activate.
  // Секреты наружу не отдаём, в ответе только имена, статусы и предупреждения.
  async function handleWebAccountAction(res, body) {
    const action = String(body.action || 'add').toLowerCase();
    const name = String(body.name || '').trim().slice(0, 80);
    if (!['add', 'update', 'remove', 'activate'].includes(action)) {
      return sendJson(res, 400, { error: { message: 'action: add | update | remove | activate', type: 'invalid_request_error' } });
    }
    if (!name) {
      return sendJson(res, 400, { error: { message: 'name: обязательное поле', type: 'invalid_request_error' } });
    }

    const list = (config.geminiWeb.accounts || []).map((a) => ({ ...a }));
    const idx = list.findIndex((a) => a.name.toLowerCase() === name.toLowerCase());
    const warnings = [];

    if (action === 'remove' || action === 'activate') {
      if (idx < 0) {
        return sendJson(res, 404, { error: { message: `Аккаунт "${name}" не найден`, type: 'not_found_error' } });
      }
      if (action === 'remove') list.splice(idx, 1);
    } else {
      const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
      const cookieFile = typeof body.cookie_file === 'string' ? body.cookie_file.trim()
        : (typeof body.cookieFile === 'string' ? body.cookieFile.trim() : '');
      if (action === 'add' && idx >= 0) {
        return sendJson(res, 409, { error: { message: `Аккаунт "${name}" уже есть (action=update)`, type: 'invalid_request_error' } });
      }
      if (action === 'update' && idx < 0) {
        return sendJson(res, 404, { error: { message: `Аккаунт "${name}" не найден`, type: 'not_found_error' } });
      }
      const prev = idx >= 0 ? list[idx] : { name };
      // Пустая cookie при update означает «не менять», а не «стереть».
      const nextCookie = cookie || prev.cookie || '';
      const nextCookieFile = cookieFile || prev.cookie_file || '';
      if (!nextCookie && !nextCookieFile) {
        return sendJson(res, 400, { error: {
          message: 'Нужна cookie или cookie_file: без них аккаунт бесполезен',
          type: 'invalid_request_error',
        } });
      }
      if (cookie && !/SAPISID|__Secure-1PSID|__Secure-3PSID/.test(cookie)) {
        warnings.push('в cookie нет SAPISID/__Secure-1PSID — веб-запросы, скорее всего, вернут 401/403');
      }
      const next = {
        name,
        cookie: nextCookie,
        cookie_file: nextCookieFile,
        proxy: typeof body.proxy === 'string' ? body.proxy.trim() : (prev.proxy || ''),
        authUser: Number.isInteger(body.authUser) ? body.authUser : (prev.authUser ?? null),
        label: typeof body.label === 'string' ? body.label.trim().slice(0, 80) : (prev.label || ''),
        thinkMode: body.thinkMode === 'extended' || body.thinkMode === 'default' ? body.thinkMode : (prev.thinkMode ?? null),
        temporaryChats: typeof body.temporaryChats === 'boolean' ? body.temporaryChats : (prev.temporaryChats === true),
      };
      if (idx >= 0) list[idx] = next; else list.push(next);
    }

    let activeAccount = config.geminiWeb.activeAccount || '';
    if (action === 'activate') activeAccount = name;
    if (action === 'remove' && activeAccount.toLowerCase() === name.toLowerCase()) activeAccount = '';

    const patch = configLib.patchConfig(config, { geminiWeb: { accounts: list, activeAccount } });
    Object.assign(config, patch.config);
    webBridge.updateConfig(config.geminiWeb);
    const saveErr = saveConfigFile();
    if (saveErr) {
      return sendJson(res, 500, { error: { message: `Не удалось записать config.json: ${saveErr.message}`, type: 'internal_error' } });
    }
    const ws = webBridge.summary ? webBridge.summary() : {};
    return sendJson(res, 200, {
      ok: true,
      action,
      activeAccount: config.geminiWeb.activeAccount || '',
      accounts: ws.accounts || [],
      warnings: [...warnings, ...patch.warnings],
    });
  }

  // ---- защита от перебора ключа ----
  // Ключ короткий и лежит в файле, но шлюз слушает localhost и по нему ходят
  // скрипты: без счётчика ошибок любой локальный процесс мог бы перебирать
  // ключ со скоростью тысяч попыток в секунду.
  const AUTH_FAIL = { maxFailures: 20, windowMs: 60_000, blockMs: 300_000 };
  const authFails = new Map(); // ip -> { count, firstAt, blockedUntil }

  function clientIp(req) {
    const raw = (req.socket && req.socket.remoteAddress) || 'unknown';
    return raw.replace(/^::ffff:/, '');
  }

  function authBlocked(req) {
    const st = authFails.get(clientIp(req));
    if (!st) return 0;
    const now = Date.now();
    if (st.blockedUntil > now) return st.blockedUntil;
    if (now - st.firstAt > AUTH_FAIL.windowMs) authFails.delete(clientIp(req));
    return 0;
  }

  function noteAuthFailure(req) {
    const ip = clientIp(req);
    const now = Date.now();
    let st = authFails.get(ip);
    if (!st || now - st.firstAt > AUTH_FAIL.windowMs) st = { count: 0, firstAt: now, blockedUntil: 0 };
    st.count += 1;
    if (st.count >= AUTH_FAIL.maxFailures) {
      st.blockedUntil = now + AUTH_FAIL.blockMs;
      st.count = 0;
      st.firstAt = now;
      pushLog({ kind: 'security', status: 429, error: `auth brute-force from ${ip}, blocked ${AUTH_FAIL.blockMs / 1000}s` });
    }
    authFails.set(ip, st);
    // Чистим старые записи, чтобы Map не рос бесконечно.
    if (authFails.size > 512) {
      for (const [key, v] of authFails) {
        if (v.blockedUntil < now && now - v.firstAt > AUTH_FAIL.windowMs) authFails.delete(key);
      }
    }
  }

  function unauthorized(res, blockedUntil = 0) {
    if (blockedUntil) {
      res.writeHead(429, {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))),
      });
      res.end(JSON.stringify({ error: {
        message: 'Слишком много неверных ключей с этого адреса. Повторите позже.',
        type: 'rate_limit_error',
        code: 'too_many_auth_failures',
      } }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: { message: 'Неверный API-ключ. Возьми его из apikey.txt', type: 'invalid_request_error' } }));
  }

  function forbidden(res, code, message) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message, type: 'permission_error', code } }));
  }

  async function upstreamErrorToClient(res, upRes) {
    const text = (await upRes.text().catch(() => '')) || '';
    const quota = extractQuotaInfo(text);
    if (quota) pushLog({ kind: 'info', status: upRes.status, error: 'quota', quota });
    sendJson(res, upRes.status, upstreamErrorBody(upRes.status, text));
  }

  // Diagnostics has its own error boundary: never let upstream messages reach
  // the generic error responder or logs, even for invalid JSON/authentication.
  async function handleDiagnosticChat(req, res) {
    const t0 = Date.now();
    let streamingSse = false;
    const ac = new AbortController();
    const onClose = () => { if (!res.writableEnded) ac.abort(); };
    res.once('close', onClose);
    try {
      const blockedUntil = authBlocked(req);
      if (blockedUntil) {
        res.setHeader('retry-after', String(Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))));
        throw diagnosticError(429, 'too_many_auth_failures', 'Слишком много неверных попыток авторизации. Подождите немного и повторите.', 'auth');
      }
      if (!statusOk(req)) {
        noteAuthFailure(req);
        throw diagnosticError(401, 'invalid_api_key', 'Неверный или отсутствующий ключ приложения. Проверьте Authorization: Bearer и актуальный ключ в apikey.txt.', 'auth');
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw diagnosticError(405, 'method_not_allowed', 'Для диагностического чата используйте POST /api/diagnostics/chat с JSON-полями model, message и bridge.', 'validation');
      }
      let raw;
      try { raw = await readBody(req); }
      catch {
        throw diagnosticError(413, 'body_read_failed', `Не удалось прочитать тело запроса или превышен лимит ${MB(MAX_BODY_BYTES)}. Сократите сообщение и отправьте JSON повторно.`, 'validation');
      }
      let body;
      try { body = JSON.parse(raw); }
      catch {
        throw diagnosticError(400, 'invalid_json', 'Не удалось разобрать JSON. Проверьте кавычки, запятые и поля model, message, bridge.', 'validation');
      }
      if (body && typeof body === 'object' && body.stream === true) {
        streamingSse = true;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const out = await executeDiagnosticChat(body, {
          catalog, tokens, upstream, webBridge, guard, cloudDisabled: CLOUD_DISABLED,
        }, {
          signal: ac.signal,
          onDelta: (delta) => {
            if (!res.writableEnded && !res.destroyed) {
              res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
            }
          },
        });
        pushLog({ kind: 'diagnostics', status: 200, ms: Date.now() - t0 });
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify({ type: 'done', ...out })}\n\n`);
          res.end();
        }
        return;
      }
      const out = await executeDiagnosticChat(body, {
        catalog, tokens, upstream, webBridge, guard, cloudDisabled: CLOUD_DISABLED,
      }, { signal: ac.signal });
      pushLog({ kind: 'diagnostics', status: 200, ms: Date.now() - t0 });
      return sendJson(res, 200, out);
    } catch (err) {
      if (err && err.code === 'client_disconnected') {
        pushLog({ kind: 'diagnostics', status: 499, ms: Date.now() - t0, error: 'client disconnected' });
        return;
      }
      const safe = normalizeDiagnosticError(err);
      pushLog({ kind: 'diagnostics', status: safe.status, ms: Date.now() - t0, error: safe.error.code });
      if (streamingSse && !res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: 'error', ok: false, error: safe.error })}\n\n`);
        res.end();
        return;
      }
      return sendJson(res, safe.status, { ok: false, error: safe.error });
    } finally {
      res.removeListener('close', onClose);
      if (clientGone(res) && !ac.signal.aborted) ac.abort();
    }
  }

  // ---- Anthropic Messages API: /v1/messages ----

  function anthropicError(res, status, type, message) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  }

  async function readAnthropicBody(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      const tooLarge = err && err.status === 413;
      const status = tooLarge ? 413 : 400;
      anthropicError(res, status, tooLarge ? 'request_too_large' : 'invalid_request_error',
        tooLarge ? `Тело запроса больше ${MB(MAX_BODY_BYTES)}.` : 'Не удалось прочитать тело запроса.');
      if (tooLarge) drainRejectedBody(req);
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        anthropicError(res, 400, 'invalid_request_error', 'Тело запроса должно быть JSON-объектом.');
        return null;
      }
      return parsed;
    } catch {
      anthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body');
      return null;
    }
  }

  async function handleAnthropicCountTokens(req, res) {
    const body = await readAnthropicBody(req, res);
    if (!body) return;
    return sendJson(res, 200, { input_tokens: anthropic.estimateTokens(body) });
  }

  async function handleAnthropicMessages(req, res) {
    const t0 = Date.now();
    const body = await readAnthropicBody(req, res);
    if (!body) return;

    const modelName = String(body.model || '').trim() || String(config.defaultModel || '').trim();
    if (!modelName) return anthropicError(res, 400, 'invalid_request_error', 'model: обязательное поле');
    if (!Number.isFinite(body.max_tokens) || body.max_tokens <= 0) {
      return anthropicError(res, 400, 'invalid_request_error', 'max_tokens: обязательное поле (> 0)');
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return anthropicError(res, 400, 'invalid_request_error', 'messages: обязательное поле');
    }

    const mapped = anthropic.mapModel(modelName);
    let parsed = parseRequestModel(mapped);
    if (!parsed.ok) parsed = (await resolveFlatModel(mapped)) || parsed;
    if (!parsed.ok) {
      return anthropicError(res, 404, 'not_found_error', `model: неизвестная модель "${modelName}". Список: GET /v1/models`);
    }
    if (CLOUD_DISABLED) {
      return anthropicError(res, 400, 'invalid_request_error',
        'Anthropic /v1/messages работает только через cloud-модели, а они отключены (AG_NO_CLOUD=1).');
    }
    if (parsed.namespace === providers.WEB) {
      return anthropicError(res, 400, 'invalid_request_error',
        'web-модели не поддерживают /v1/messages — используйте /v1/chat/completions с теми же моделями');
    }

    let requestObj;
    try {
      ({ requestObj } = anthropic.anthropicToGeminiRequest(body, {
        mapReasoningEffort: !!(config.thinking && config.thinking.mapReasoningEffort),
      }));
      applyOutputHeadroom(requestObj);
    } catch (e) {
      return anthropicError(res, e.status || 400, 'invalid_request_error', e.message);
    }
    applyThinkingConfig(requestObj, body, { ...config.thinking, includeThoughts: !!config.includeThoughts });

    const stream = body.stream === true;

    return guarded(res, parsed.baseId, 'anthropic', async () => {
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.once('close', onClose);
      try {
        if (clientGone(res)) throw abortedError();
        const upRes = await withRetry429(() => upstream.generateWithRetry(parsed.baseId, requestObj, { signal: ac.signal }));
        if (!upRes.ok) {
          const text = (await upRes.text().catch(() => '')) || '';
          if (upRes.status === 429) guard.report429(parsed.baseId, parseResetMs(text));
          const quota = extractQuotaInfo(text);
          pushLog({ kind: 'anthropic', model: parsed.displayId, status: upRes.status, ms: Date.now() - t0, error: redactSecrets(text).slice(0, 160), quota, provider: providers.CLOUD });
          const message = redactSecrets(text).replace(/\s+/g, ' ').slice(0, 400) || `upstream ${upRes.status}`;
          const type = upRes.status === 429 ? 'rate_limit_error'
            : upRes.status === 401 || upRes.status === 403 ? 'authentication_error'
              : upRes.status === 404 ? 'not_found_error' : 'api_error';
          return anthropicError(res, upRes.status, type, message);
        }

        if (!stream) {
          const saw = [];
          for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
            if (!data || data === '[DONE]') continue;
            saw.push(parseUpstreamData(data));
          }
          let out = anthropic.geminiToAnthropicResponse({ response: mergeGeminiResponse(saw) }, modelName, { includeThoughts: !!config.includeThoughts });
          if (anthropicAnswerEmpty(out)) {
            const retryObj = retryRequestWithBudget(requestObj);
            if (retryObj) {
              const again = await withRetry429(() => upstream.generateWithRetry(parsed.baseId, retryObj, { signal: ac.signal }));
              if (again.ok) {
                const saw2 = [];
                for await (const data of sseData(bodyWhileConnected(res, again.body))) {
                  if (!data || data === '[DONE]') continue;
                  saw2.push(parseUpstreamData(data));
                }
                const out2 = anthropic.geminiToAnthropicResponse({ response: mergeGeminiResponse(saw2) }, modelName, { includeThoughts: !!config.includeThoughts });
                if (!anthropicAnswerEmpty(out2)) {
                  out = out2;
                  pushLog({ kind: 'anthropic', model: parsed.displayId, status: 200, ms: Date.now() - t0, retry: 'max_tokens', provider: providers.CLOUD });
                }
              }
            }
          }
          guard.reportUsage(out.usage.input_tokens + out.usage.output_tokens);
          pushLog({ kind: 'anthropic', model: parsed.displayId, status: 200, ms: Date.now() - t0, provider: providers.CLOUD });
          return sendJson(res, 200, out);
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const conv = new anthropic.AnthropicStream(modelName, { includeThinking: !!config.includeThoughts });
        for (const evt of conv.startMessage()) res.write(anthropic.formatSse(evt));
        let anyText = false;
        try {
          for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
            if (!data || data === '[DONE]') continue;
            const resp = parseUpstreamData(data);
            for (const p of (resp.response ?? resp).candidates?.[0]?.content?.parts || []) {
              if ((!p.thought && typeof p.text === 'string' && p.text) || (p.functionCall && p.functionCall.name)) {
                anyText = true;
              }
            }
            for (const evt of conv.push(resp.response ?? resp)) res.write(anthropic.formatSse(evt));
          }
        } catch (e) {
          if (clientGone(res) || (e && (e.name === 'AbortError' || ac.signal.aborted))) throw abortedError();
          pushLog({ kind: 'anthropic', model: parsed.displayId, status: 502, ms: Date.now() - t0, error: 'stream: ' + e.message, provider: providers.CLOUD });
          for (const evt of conv.finish()) res.write(anthropic.formatSse(evt));
          res.end();
          return;
        }
        for (const evt of conv.finish()) res.write(anthropic.formatSse(evt));
        if (!anyText) {
          res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: {
            type: 'api_error',
            message: 'Модель израсходовала max_tokens на размышления и не вернула текст. Увеличьте max_tokens и повторите.',
          } }) + '\n\n');
        }
        res.end();
        guard.reportUsage(conv.usageTokens);
        pushLog({ kind: 'anthropic', model: parsed.displayId, status: 200, ms: Date.now() - t0, stream: true, provider: providers.CLOUD });
      } catch (err) {
        if (err && err.code === 'client_disconnected') {
          pushLog({ kind: 'anthropic', model: parsed.displayId, status: 499, ms: Date.now() - t0, error: 'client disconnected', provider: providers.CLOUD });
          return;
        }
        throw err;
      } finally {
        res.removeListener('close', onClose);
        if (clientGone(res) && !ac.signal.aborted) ac.abort();
      }
    });
  }
  // ---- OpenAI: /v1/chat/completions ----

  // Модели жёстко неймспейснуты: cloud/<id> | web/<alias>.
  function parseRequestModel(raw) {
    return providers.parseModel(raw, {
      isWebAlias: (id) => webBridge.isWebModelName(id),
      webAliases: () => webBridge.getModelIds(),
    });
  }

  function sendNamespaceError(res, parsed) {
    return sendJson(res, 400, {
      error: {
        message: parsed.message,
        type: 'invalid_request_error',
        code: parsed.code,
        ...(parsed.hint ? { hint: parsed.hint } : {}),
      },
    });
  }

  // Совместимость со старыми клиентами: точное имя без namespace
  // (например, gemini-3.8-flash-tiered) резолвим в cloud/<id>, если оно есть
  // в каталоге аккаунта, или в web/<alias>. Неизвестные имена по-прежнему 400.
  async function resolveFlatModel(raw) {
    const name = String(raw || '').trim();
    if (!name) return null;
    const direct = parseRequestModel(name);
    if (direct.ok || direct.code !== 'model_namespace_required') return null;
    let base = name;
    let agent = false;
    if (base.endsWith('-agent') && base.length > '-agent'.length) {
      agent = true;
      base = base.slice(0, -'-agent'.length);
    }
    try {
      const models = await catalog.list(() => tokens.getAccessToken());
      if (models.has(base)) {
        return parseRequestModel(providers.formatModel(providers.CLOUD, base, { agent }));
      }
    } catch {}
    if (webBridge.isWebModelName(base)) {
      return parseRequestModel(providers.formatModel(providers.WEB, base, { agent }));
    }
    return null;
  }

  function webBridgeDisabledError() {
    return {
      error: {
        message: 'Web-модели доступны только через Gemini Web bridge. Включите его: Settings -> Gemini Web -> Enable.',
        type: 'invalid_request_error',
        code: 'web_bridge_disabled',
      },
    };
  }

  function cloudDisabledError() {
    return {
      error: {
        message: 'cloud-модели отключены (AG_NO_CLOUD=1). Используйте web/<alias> модели или уберите AG_NO_CLOUD.',
        type: 'invalid_request_error',
        code: 'cloud_disabled',
      },
    };
  }

  function webAgentDisabledError() {
    return {
      error: {
        message: 'Gemini Web agent mode is VERY unreliable (length-capped text-protocol emulation) and is disabled by default. Use cloud/<model>-agent for reliable agent work, or set agent.allowWebAgent=true in config.json.',
        type: 'invalid_request_error',
        code: 'web_agent_disabled',
      },
    };
  }

  // ---- Агентный режим: серверные файловые инструменты (lib/agent.js) ----

  // Триггеры: флаг "agent": true / "builtin_tools": true / "tools": "builtin"
  // (нормализуется до валидации) или алиас модели с суффиксом "-agent"
  // (например cloud/gemini-3-flash-agent -> cloud/gemini-3-flash).
  function resolveAgentRequest(body, parsed) {
    if (!parsed || !parsed.ok) return null;
    const explicit = body.agent === true
      || (body.agent && typeof body.agent === 'object')
      || body.builtin_tools === true;
    if (explicit || parsed.agentRequested) {
      return { parsed, viaAlias: parsed.agentRequested };
    }
    return null;
  }

  // Конфиг агента для конкретного запроса: DEFAULTS < config.json < body.agent.
  // Опасные флаги (allowDelete/allowShell/allowWebAgent) задаются ТОЛЬКО в
  // config.json — из тела запроса их включить нельзя.
  function agentConfigFor(body) {
    const req = body && body.agent && typeof body.agent === 'object' ? body.agent : {};
    const cfg = { ...agent.DEFAULTS, ...(config.agent || {}) };
    // auditFile/auditRotateBytes и опасные флаги НЕ принимаются из тела запроса:
    // путь журнала из запроса — это запись в произвольный файл в обход песочницы.
    const reqWorkspace = typeof req.workspaceRoot === 'string' && req.workspaceRoot.trim();
    if (reqWorkspace) cfg.workspaceRoot = req.workspaceRoot.trim();
    if (req.maxIterations !== undefined) cfg.maxIterations = configLib.clampNumber(req.maxIterations, 1, 24, cfg.maxIterations);
    if (req.maxReadBytes !== undefined) cfg.maxReadBytes = configLib.clampNumber(req.maxReadBytes, 1024, 1024 * 1024, cfg.maxReadBytes);
    if (req.maxWriteBytes !== undefined) cfg.maxWriteBytes = configLib.clampNumber(req.maxWriteBytes, 1024, 8 * 1024 * 1024, cfg.maxWriteBytes);
    if (req.maxListEntries !== undefined) cfg.maxListEntries = configLib.clampNumber(req.maxListEntries, 1, 5000, cfg.maxListEntries);
    if (req.shellTimeoutMs !== undefined) cfg.shellTimeoutMs = configLib.clampNumber(req.shellTimeoutMs, 1000, 600000, cfg.shellTimeoutMs);
    cfg.allowDelete = !!(config.agent && config.agent.allowDelete);
    cfg.allowShell = !!(config.agent && config.agent.allowShell);
    cfg.allowAbsolutePaths = !!(config.agent && config.agent.allowAbsolutePaths);
    cfg.allowWebAgent = !!(config.agent && config.agent.allowWebAgent === true);
    cfg.planner = { ...planner.DEFAULT_SETTINGS, ...((config.agent && config.agent.planner) || {}) };
    cfg.enabled = !(config.agent && config.agent.enabled === false);
    // Не из тела запроса: база песочницы и каталог служебных файлов.
    cfg.dataDir = DATA_DIR;
    cfg.workspaceBase = process.env.AG_WORKSPACE_BASE ? path.resolve(process.env.AG_WORKSPACE_BASE) : DATA_DIR;
    // Проверяем только путь, пришедший из запроса: workspaceRoot из конфига
    // доверенный (иначе дефолтная папка в DATA_DIR сама себе противоречит).
    cfg.validateWorkspace = !!reqWorkspace;
    return cfg;
  }

  async function handleAgentChat(res, { body, parsed, stream, t0 }) {
    const model = parsed.baseId;
    const requestedModel = parsed.displayId;
    const useWeb = parsed.namespace === providers.WEB;
    if (!useWeb && CLOUD_DISABLED) return sendJson(res, 400, cloudDisabledError());

    // Web-модель при выключенном мосте — та же ошибка, что и в обычном пути.
    if (useWeb && !webBridge.isWebModel(model)) {
      return sendJson(res, 400, webBridgeDisabledError());
    }

    const acfg = agentConfigFor(body);
    let executor;
    try {
      executor = agent.createExecutor(acfg, ROOT);
    } catch (err) {
      return sendJson(res, 400, {
        error: { message: err.message, type: 'invalid_request_error', code: 'workspace_denied' },
      });
    }

    // Гибридный консультант доступен только cloud-циклу: исполнитель надёжный,
    // веб-модель только советует. Веб-циклу planner не предлагается.
    const plannerTool = useWeb ? null : planner.createPlanner({ bridge: webBridge, settings: acfg.planner });
    const plannerActive = !!(plannerTool && plannerTool.available());
    const toolsForLoop = plannerActive ? [...agent.TOOL_SPECS, planner.PLANNER_TOOL_SPEC] : agent.TOOL_SPECS;
    const loopExecutor = plannerActive ? {
      workspace: executor.workspace,
      toolNames: [...executor.toolNames, 'ask_planner'],
      execute: async (name, args) => (
        agent.canonicalTool(name) === 'ask_planner'
          ? plannerTool.call(args)
          : executor.execute(name, args)
      ),
    } : executor;

    const systemPrompt = agent.buildSystemPrompt({
      workspace: executor.workspace,
      toolNames: loopExecutor.toolNames,
      allowDelete: !!executor.cfg.allowDelete,
      allowShell: !!executor.cfg.allowShell,
      allowAbsolutePaths: !!executor.cfg.allowAbsolutePaths,
      extraTools: plannerActive ? ['ask_planner'] : [],
    });

    // Клиент мог закрыть вкладку: без сигнала веб-агент продолжает генерировать
    // и жечь лимит аккаунта до таймаута.
    const webAc = new AbortController();
    const onWebClose = () => { if (!res.writableEnded) webAc.abort(); };
    res.once('close', onWebClose);

    // Web-мост: каждая итерация — один веб-запрос с полным transcript'ом.
    // Такая эмуляция протокола текстом — VERY unreliable (лимит длины ответа).
    const chatWeb = async (msgs) => {
      if (webAc.signal.aborted) throw Object.assign(new Error('client disconnected'), { code: 'client_disconnected' });
      const out = await webBridge.handleOpenAIChat(
        { model, messages: msgs, tools: agent.TOOL_SPECS }, false, null, { signal: webAc.signal });
      const m = out.choices?.[0]?.message || {};
      return { content: m.content || '', tool_calls: m.tool_calls || [], usage: out.usage, upstream_model: out.upstream_model };
    };

    // Cloud: нативный Gemini function calling — сообщения (включая
    // assistant.tool_calls и role:"tool") транслируются в functionCall/
    // functionResponse с thought signatures. Никакой текстовой склейки.
    const chatCloud = async (msgs) => {
      const requestObj = applyOutputHeadroom(openAIToGeminiRequest({ messages: msgs, tools: toolsForLoop }));
      applyThinkingConfig(requestObj, body, { ...config.thinking, includeThoughts: !!config.includeThoughts });
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.once('close', onClose);
      try {
        if (clientGone(res)) throw abortedError();
        const upRes = await withRetry429(() => upstream.generateWithRetry(model, requestObj, { signal: ac.signal }));
        if (!upRes.ok) {
          const text = (await upRes.text().catch(() => '')) || '';
          if (upRes.status === 429) guard.report429(model, parseResetMs(text));
          const e = new Error(`Antigravity upstream HTTP ${upRes.status}: ${text.slice(0, 200)}`);
          e.status = upRes.status;
          throw e;
        }
        const saw = [];
        for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
          if (!data || data === '[DONE]') continue;
          saw.push(parseUpstreamData(data));
        }
        const merged = mergeGeminiResponse(saw);
        const out = geminiToOpenAIResponse({ response: merged }, model, { includeThoughts: !!config.includeThoughts });
        const m = out.choices?.[0]?.message || {};
        return { content: m.content || '', tool_calls: m.tool_calls || [], usage: out.usage, upstream_model: out.upstream_model };
      } finally {
        res.removeListener('close', onClose);
        if (clientGone(res) && !ac.signal.aborted) ac.abort();
      }
    };

    const chat = useWeb ? chatWeb : chatCloud;

    // SSE открывается ДО цикла: иначе клиент минуту видит пустоту (агент ходит
    // в апстрим несколько раз), а прокси рвут соединение по таймауту.
    let sseBase = null;
    let pingTimer = null;
    const openSse = () => {
      if (sseBase || !stream) return;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sseBase = {
        id: 'chatcmpl-' + crypto.randomUUID(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
      };
      res.write(`data: ${JSON.stringify({ ...sseBase, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      pingTimer = setInterval(() => {
        if (res.writableEnded) return;
        res.write(': keep-alive\n\n'); // SSE-комментарий, клиенты его игнорируют
      }, 10000);
      if (pingTimer.unref) pingTimer.unref();
    };
    const stopSse = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    };
    const onAgentEvent = (evt) => {
      if (!sseBase || res.writableEnded) return;
      const payload = evt.type === 'iteration' ? { type: 'iteration', iteration: evt.iteration }
        : evt.type === 'tool_start' ? { type: 'tool_start', tool: evt.tool }
          : { type: 'tool_end', tool: evt.tool, ok: evt.ok, ms: evt.ms };
      res.write(`data: ${JSON.stringify({ ...sseBase, agent_event: payload, choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`);
    };

    const run = async () => {
      openSse();
      res.once('close', stopSse);
      try {
        const result = await agent.runAgentLoop({
          chat,
          messages: body.messages || [],
          executor: loopExecutor,
          maxIterations: acfg.maxIterations,
          systemPrompt,
          onEvent: onAgentEvent,
        });
        if (result.usage && result.usage.total_tokens) guard.reportUsage(result.usage.total_tokens);
        pushLog({ kind: 'openai', model: requestedModel, status: 200, ms: Date.now() - t0, agentActions: result.trace.length, provider: parsed.namespace });
        return result;
      } finally {
        stopSse();
        res.removeListener('close', stopSse);
      }
    };

    const agentMeta = () => useWeb
      ? { provider: providers.WEB, reliability: 'very-low', warning: '[VERY unreliable] Gemini Web agent mode is VERY unreliable (length-capped, text-protocol emulation). Short tasks only.' }
      : { provider: providers.CLOUD, reliability: 'high' };

    const emit = (result) => {
      if (!stream) {
        return sendJson(res, 200, {
          id: 'chatcmpl-' + crypto.randomUUID(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          upstream_model: result.upstream_model || '',
          choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }],
          usage: result.usage,
          agent: {
            ...agentMeta(),
            workspace: result.workspace,
            iterations: result.iterations,
            completed: result.completed,
            actions: result.trace,
            ...(plannerTool ? { planner: plannerTool.stats() } : {}),
          },
        });
      }
      // Стрим уже открыт в openSse(): прогресс ушёл живыми событиями,
      // здесь только финальный контент и закрытие.
      stopSse();
      if (!sseBase) openSse();
      const base = sseBase;
      if (result.content) {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: result.content }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };

    if (useWeb) {
      try {
        return emit(await run());
      } catch (err) {
        if (err && err.code === 'client_disconnected') {
          pushLog({ kind: 'openai', status: 499, ms: Date.now() - t0, error: 'client disconnected', provider: providers.WEB });
          return;
        }
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
        const regional = err.code === 'region_not_supported';
        const type = regional ? 'invalid_request_error' : 'api_error';
        const code = regional ? 'region_not_supported' : status;
        const message = regional ? normalizeDiagnosticError(err, { bridge: 'web' }).error.message
          : `[VERY unreliable] Агентный запрос Gemini Web не удался: ${redactSecrets(err.message)}`;
        pushLog({ kind: 'openai', status, ms: Date.now() - t0, error: regional ? code : 'agent_web_request_failed', provider: providers.WEB });
        return sendApiError(res, status, { error: { message, type, code } }, stream);
      }
    }

    // Облачная модель — под защитой guard, как обычный облачный путь.
    try {
      const result = await guarded(res, model, 'openai', run);
      if (result === null) return; // guard отклонил: 429 уже отправлен
      return emit(result);
    } catch (err) {
      if (err && err.code === 'client_disconnected') {
        pushLog({ kind: 'openai', model: requestedModel, status: 499, ms: Date.now() - t0, error: 'client disconnected', provider: providers.CLOUD });
        return;
      }
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
      if (err.code === 'region_not_supported' || /User location is not supported|location is not supported/i.test(String(err && err.message || ''))) {
        pushLog({ kind: 'openai', model: requestedModel, status: 400, ms: Date.now() - t0, error: 'region_not_supported', provider: providers.CLOUD });
        return sendApiError(res, 400, { error: {
          message: 'Antigravity upstream: user location is not supported for this API. Use a supported Google region or configure a proxy.',
          type: 'invalid_request_error',
          code: 'region_not_supported',
        } }, stream);
      }
      pushLog({ kind: 'openai', model: requestedModel, status, ms: Date.now() - t0, error: 'agent_cloud_failed', provider: providers.CLOUD });
      return sendApiError(res, status, { error: { message: `Агентный запрос не удался: ${err.message}`, type: 'api_error', code: status } }, stream);
    }
  }

  async function handleOpenAIChat(req, res) {
    const t0 = Date.now();
    const read = await readBodyOrRespond(req, res);
    if (!read.ok) return;
    const body = parseRequestBody(read.raw);
    if (body.tools === 'builtin') {
      body.agent = true;
      body.tools = undefined;
    }
    if ((!body.model || !String(body.model).trim()) && config.defaultModel) {
      body.model = config.defaultModel;
    }
    validateOpenAI(body);
    let rawModel = body.model.trim();
    if (rawModel === 'web' && config.geminiWeb?.defaultModel) {
      rawModel = providers.formatModel(providers.WEB, config.geminiWeb.defaultModel.replace(/^web\//i, ''));
    }
    let parsed = parseRequestModel(rawModel);
    if (!parsed.ok) {
      parsed = (await resolveFlatModel(rawModel)) || parsed;
    }
    if (!parsed.ok && config.defaultModel && parsed.code === 'model_namespace_required') {
      const fb = parseRequestModel(config.defaultModel);
      if (fb.ok) parsed = fb;
      else parsed = (await resolveFlatModel(config.defaultModel)) || parsed;
    }
    if (!parsed.ok) return sendNamespaceError(res, parsed);
    if (parsed.namespace === providers.CLOUD && CLOUD_DISABLED) return sendJson(res, 400, cloudDisabledError());
    const stream = !!body.stream;

    const agentReq = resolveAgentRequest(body, parsed);
    if (agentReq) {
      if (config.agent && config.agent.enabled === false) {
        return sendJson(res, 400, {
          error: {
            message: 'Агентные файловые инструменты выключены (config.json -> agent.enabled=false).',
            type: 'invalid_request_error',
            code: 400,
          },
        });
      }
      if (parsed.namespace === providers.WEB && !(config.agent && config.agent.allowWebAgent === true)) {
        return sendJson(res, 400, webAgentDisabledError());
      }
      return await handleAgentChat(res, { body, parsed, stream, t0 });
    }

    if (parsed.namespace === providers.WEB) {
      if (!webBridge.isWebModel(parsed.baseId)) {
        return sendJson(res, 400, webBridgeDisabledError());
      }
      return guarded(res, parsed.baseId, 'openai', async () => {
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.once('close', onClose);
      try {
        const out = await webBridge.handleOpenAIChat(
          { ...body, model: parsed.baseId, tools: undefined },
          stream,
          res,
          { signal: ac.signal, onUsage: (u) => guard.reportUsage(u?.totalTokens) }
        );
        if (out) {
          guard.reportUsage(out.usage?.total_tokens);
          pushLog({ kind: 'openai', model: parsed.displayId, status: 200, ms: Date.now() - t0, stream, provider: providers.WEB });
          return sendJson(res, 200, out);
        }
        pushLog({ kind: 'openai', model: parsed.displayId, status: 200, ms: Date.now() - t0, stream, provider: providers.WEB });
        return;
      } catch (err) {
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
        const regional = err.code === 'region_not_supported';
        const type = regional ? 'invalid_request_error' : 'api_error';
        const code = regional ? 'region_not_supported' : status;
        const detail = redactSecrets(String(err && err.message || 'unknown error')).replace(/\s+/g, ' ').slice(0, 220);
        const message = regional ? normalizeDiagnosticError(err, { bridge: 'web' }).error.message
          : `Gemini Web request failed: ${detail} (проверьте прокси и свежесть куки; повторите попытку)`;
        if (status === 429) guard.report429(parsed.baseId, parseResetMs(detail));
        pushLog({ kind: 'openai', status, ms: Date.now() - t0, error: regional ? code : 'web: ' + detail.slice(0, 140), provider: providers.WEB });
        sendApiError(res, status, { error: { message, type, code } }, stream);
        return;
      } finally {
        res.removeListener('close', onClose);
        if (clientGone(res) && !ac.signal.aborted) ac.abort();
      }
      });
    }

    const model = parsed.baseId;
    const requestObj = applyOutputHeadroom(openAIToGeminiRequest(body));
    applyThinkingConfig(requestObj, body, { ...config.thinking, includeThoughts: !!config.includeThoughts });

    return guarded(res, model, 'openai', async () => {
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.once('close', onClose);
      try {
        if (clientGone(res)) throw abortedError();
        const upRes = await withRetry429(() => upstream.generateWithRetry(model, requestObj, { signal: ac.signal }));
        if (!upRes.ok) {
          const text = (await upRes.text().catch(() => '')) || '';
          if (upRes.status === 429) guard.report429(model, parseResetMs(text));
          const quota = extractQuotaInfo(text);
          pushLog({ kind: 'openai', model: parsed.displayId, status: upRes.status, ms: Date.now() - t0, error: redactSecrets(text).slice(0, 160), quota, provider: providers.CLOUD });
          return upstreamErrorToClient(res, { status: upRes.status, text: async () => text });
        }

        if (!stream) {
          const saw = [];
          for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
            if (!data || data === '[DONE]') continue;
            saw.push(parseUpstreamData(data));
          }
          let out = aggregateGeminiChunks(saw, parsed.displayId);
          if (openAIAnswerEmpty(out)) {
            const retryObj = retryRequestWithBudget(requestObj);
            if (retryObj) {
              const again = await withRetry429(() => upstream.generateWithRetry(model, retryObj, { signal: ac.signal }));
              if (again.ok) {
                const saw2 = [];
                for await (const data of sseData(bodyWhileConnected(res, again.body))) {
                  if (!data || data === '[DONE]') continue;
                  saw2.push(parseUpstreamData(data));
                }
                const out2 = aggregateGeminiChunks(saw2, parsed.displayId);
                if (!openAIAnswerEmpty(out2)) {
                  out = out2;
                  pushLog({ kind: 'openai', model: parsed.displayId, status: 200, ms: Date.now() - t0, retry: 'max_tokens', provider: providers.CLOUD });
                }
              }
            }
          }
          guard.reportUsage(out.usage?.total_tokens);
          pushLog({ kind: 'openai', model: parsed.displayId, status: 200, ms: Date.now() - t0, provider: providers.CLOUD });
          sendJson(res, 200, out);
          return;
        }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const conv = new GeminiStreamToOpenAI(parsed.displayId, { includeThoughts: !!config.includeThoughts });
        let anyContent = false;
        try {
          for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
            if (!data || data === '[DONE]') continue;
            parseUpstreamData(data);
            for (const chunk of conv.pushData(data)) {
              const delta = chunk.choices?.[0]?.delta;
              if (delta && (delta.content || (Array.isArray(delta.tool_calls) && delta.tool_calls.length))) {
                anyContent = true;
              }
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
          for (const chunk of conv.finishChunks()) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (!anyContent) {
            res.write(`data: ${JSON.stringify({ error: {
              message: 'Модель израсходовала max_tokens на размышления и не вернула текст. Увеличьте max_tokens (например, до 1024) и повторите.',
              type: 'api_error', code: 'empty_reasoning_budget',
            } })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
        } catch (e) {
          if (clientGone(res) || (e && (e.name === 'AbortError' || e.name === 'TimeoutError' || ac.signal.aborted))) throw abortedError();
          pushLog({ kind: 'openai', model: parsed.displayId, status: 502, ms: Date.now() - t0, error: 'stream: ' + e.message, provider: providers.CLOUD });
          sendApiError(res, 502, { error: { message: `Antigravity upstream stream: ${e.message}`, type: 'api_error', code: 502 } }, true);
          return;
        }
        res.end();
        guard.reportUsage(conv.getUsageTokens());
        pushLog({ kind: 'openai', model: parsed.displayId, status: 200, ms: Date.now() - t0, stream: true, provider: providers.CLOUD });
      } catch (err) {
        if (err && err.code === 'client_disconnected') {
          pushLog({ kind: 'openai', model: parsed.displayId, status: 499, ms: Date.now() - t0, error: 'client disconnected', provider: providers.CLOUD });
          return;
        }
        throw err;
      } finally {
        res.removeListener('close', onClose);
        if (clientGone(res) && !ac.signal.aborted) ac.abort();
      }
    });
  }

  function aggregateGeminiChunks(chunks, model) {
    const parts = [];
    let finish = null;
    let usage = null;
    let promptFeedback = null;
    let traceId;
    for (const c of chunks) {
      const resp = c.response ?? c;
      if (c.traceId) traceId = c.traceId;
      const cand = resp.candidates?.[0] ?? {};
      for (const p of cand.content?.parts ?? []) {
        const last = parts[parts.length - 1];
        if (typeof p.text === 'string' && last && typeof last.text === 'string' && !!last.thought === !!p.thought) {
          last.text += p.text;
        } else {
          parts.push({ ...p });
        }
      }
      if (cand.finishReason) finish = cand.finishReason;
      if (resp.usageMetadata) usage = resp.usageMetadata;
      if (resp.promptFeedback) promptFeedback = resp.promptFeedback;
    }
    const blocked = !!promptFeedback?.blockReason && !parts.length && !finish;
    const resp = {
      response: {
        candidates: blocked ? [] : [{ content: { parts, role: 'model' }, finishReason: finish ?? 'STOP', index: 0 }],
        usageMetadata: usage ?? {},
        modelVersion: model,
        ...(promptFeedback ? { promptFeedback } : {}),
      },
      traceId,
    };
    return geminiToOpenAIResponse(resp, model, { includeThoughts: !!config.includeThoughts });
  }

  // ---- Gemini-нативный API ----

  async function handleGeminiGenerate(req, res, rawModel, method) {
    const t0 = Date.now();
    const read = await readBodyOrRespond(req, res);
    if (!read.ok) return;
    const body = parseRequestBody(read.raw);
    const requestObj = body.request ?? body; // можно прислать и обёрнутый, и чистый GenerateContentRequest
    applyOutputHeadroom(requestObj);
    validateGemini(requestObj);

    let parsedModel = parseRequestModel(rawModel);
    if (!parsedModel.ok) {
      parsedModel = (await resolveFlatModel(rawModel)) || parsedModel;
    }
    if (!parsedModel.ok) return sendNamespaceError(res, parsedModel);
    const model = parsedModel.baseId;
    const displayModel = parsedModel.displayId;
    const isWeb = parsedModel.namespace === providers.WEB;
    if (!isWeb && CLOUD_DISABLED) return sendJson(res, 400, cloudDisabledError());

    if (method === 'countTokens') {
      if (isWeb) {
        const text = (requestObj.contents || []).flatMap(c => c.parts || []).map(p => p.text || '').join(' ');
        const totalTokens = Math.max(1, Math.round(text.length / 4));
        return sendJson(res, 200, { totalTokens });
      }
      const upRes = await upstream.countTokens(model, requestObj);
      if (!upRes.ok) return upstreamErrorToClient(res, upRes);
      const j = await upRes.json();
      const inner = j.response ?? j;
      pushLog({ kind: 'gemini', model: displayModel, status: 200, ms: Date.now() - t0, countTokens: true, provider: providers.CLOUD });
      return sendJson(res, 200, inner);
    }

    const stream = method === 'streamGenerateContent';

    if (isWeb) {
      if (!webBridge.isWebModel(model)) {
        return sendJson(res, 400, webBridgeDisabledError());
      }
      return guarded(res, model, 'gemini', async () => {
      // Уход клиента обязан рвать веб-запрос: ответ Gemini идёт 10-30 c,
      // и без отмены шлюз продолжает занимать квоту впустую.
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.once('close', onClose);
      try {
        const prompt = webBridge.contentsToPrompt(requestObj);
        const meta = webBridge.getModelMeta(model);
        const lang = webBridge.detectContentsLang(requestObj);

        if (stream) {
          const reqBody = webBridge.buildPayload(prompt, meta.modelId, meta.thinkMode, lang);
          const upRes = await webBridge.sendStreamRequestResilient(reqBody, meta, lang, { signal: ac.signal });
          const iterator = webBridge.streamResponse(upRes)[Symbol.asyncIterator]();
          const first = await iterator.next();
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          let outChars = 0;
          if (!first.done) {
            outChars += String(first.value || '').length;
            const firstChunk = { candidates: [{ content: { parts: [{ text: first.value }], role: 'model' }, finishReason: null, index: 0 }] };
            res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
              outChars += String(next.value || '').length;
              const chunk = { candidates: [{ content: { parts: [{ text: next.value }], role: 'model' }, finishReason: null, index: 0 }] };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }
          const endChunk = {
            candidates: [{
              content: { parts: [], role: 'model' },
              finishReason: 'STOP',
              index: 0,
            }],
          };
          res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
          res.end();
          guard.reportUsage(Math.max(2, Math.round((prompt.length + outChars) / 4)));
          pushLog({ kind: 'gemini', model: displayModel, status: 200, ms: Date.now() - t0, stream: true, provider: providers.WEB });
          return;
        }

        const text = await webBridge.generate(prompt, meta.modelId, meta.thinkMode, lang, { signal: ac.signal });
        const totalTokens = Math.max(2, Math.round((prompt.length + text.length) / 4));
        const out = {
          candidates: [{
            content: { parts: [{ text }], role: 'model' },
            finishReason: 'STOP',
            index: 0,
          }],
          usageMetadata: {
            promptTokenCount: Math.max(1, Math.round(prompt.length / 4)),
            candidatesTokenCount: Math.max(1, Math.round(text.length / 4)),
            totalTokenCount: totalTokens,
          },
          modelVersion: displayModel,
        };
        guard.reportUsage(totalTokens);
        pushLog({ kind: 'gemini', model: displayModel, status: 200, ms: Date.now() - t0, provider: providers.WEB });
        return sendJson(res, 200, out);
      } catch (err) {
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
        const regional = err.code === 'region_not_supported';
        const detail = redactSecrets(String(err && err.message || 'unknown error')).replace(/\s+/g, ' ').slice(0, 220);
        const message = regional ? normalizeDiagnosticError(err, { bridge: 'web' }).error.message
          : `Gemini Web request failed: ${detail} (проверьте VPN и свежесть куки; повторите попытку)`;
        pushLog({ kind: 'gemini', status, ms: Date.now() - t0, error: regional ? 'region_not_supported' : 'web: ' + detail.slice(0, 140), provider: providers.WEB });
        if (status === 429) guard.report429(model, parseResetMs(detail));
        return sendApiError(res, status, { error: {
          message,
          type: regional ? 'invalid_request_error' : 'api_error',
          code: regional ? 'region_not_supported' : status,
        } });
      } finally {
        res.removeListener('close', onClose);
        if (clientGone(res) && !ac.signal.aborted) ac.abort();
      }
      });
    }

    if (!isWeb) {
      applyThinkingConfig(requestObj, body, { ...config.thinking, includeThoughts: !!config.includeThoughts });
    }

    return guarded(res, model, 'gemini', async () => {
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.once('close', onClose);
      try {
        if (clientGone(res)) throw abortedError();
        const upRes = await withRetry429(() => upstream.generateWithRetry(model, requestObj, { signal: ac.signal }));
        if (!upRes.ok) {
          const text = (await upRes.text().catch(() => '')) || '';
          if (upRes.status === 429) guard.report429(model, parseResetMs(text));
          pushLog({ kind: 'gemini', model: displayModel, status: upRes.status, ms: Date.now() - t0, error: redactSecrets(text).slice(0, 160), quota: extractQuotaInfo(text), provider: providers.CLOUD });
          return upstreamErrorToClient(res, { status: upRes.status, text: async () => text });
        }

        if (!stream) {
          const seen = [];
          for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
            if (data && data !== '[DONE]') {
              seen.push(parseUpstreamData(data));
            }
          }
          let mergedResp = mergeGeminiResponse(seen);
          if (geminiAnswerEmpty(mergedResp)) {
            const retryObj = retryRequestWithBudget(requestObj);
            if (retryObj) {
              const again = await withRetry429(() => upstream.generateWithRetry(model, retryObj, { signal: ac.signal }));
              if (again.ok) {
                const seen2 = [];
                for await (const data of sseData(bodyWhileConnected(res, again.body))) {
                  if (data && data !== '[DONE]') seen2.push(parseUpstreamData(data));
                }
                const merged2 = mergeGeminiResponse(seen2);
                if (!geminiAnswerEmpty(merged2)) {
                  mergedResp = merged2;
                  pushLog({ kind: 'gemini', model: displayModel, status: 200, ms: Date.now() - t0, retry: 'max_tokens', provider: providers.CLOUD });
                }
              }
            }
          }
          guard.reportUsage(mergedResp.usageMetadata?.totalTokenCount);
          pushLog({ kind: 'gemini', model: displayModel, status: 200, ms: Date.now() - t0, provider: providers.CLOUD });
          return sendJson(res, 200, mergedResp);
        }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        let lastUsage = null;
        let anyText = false;
        for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
          if (!data || data === '[DONE]') continue;
          const j = parseUpstreamData(data);
          const inner = j.response ?? j;
          if (inner.usageMetadata) lastUsage = inner.usageMetadata;
          for (const p of inner.candidates?.[0]?.content?.parts || []) {
            if ((!p.thought && typeof p.text === 'string' && p.text) || (p.functionCall && p.functionCall.name)) {
              anyText = true;
            }
          }
          res.write(`data: ${JSON.stringify(inner)}\n\n`);
        }
        if (!anyText) {
          res.write(`data: ${JSON.stringify({ error: {
            message: 'Модель израсходовала maxOutputTokens на размышления и не вернула текст. Увеличьте лимит и повторите.',
            type: 'api_error', code: 'empty_reasoning_budget',
          } })}\n\n`);
        }
        res.end();
        guard.reportUsage(lastUsage ? lastUsage.totalTokenCount ?? ((lastUsage.promptTokenCount ?? 0) + (lastUsage.candidatesTokenCount ?? 0)) : undefined);
        pushLog({ kind: 'gemini', model: displayModel, status: 200, ms: Date.now() - t0, stream: true, provider: providers.CLOUD });
      } catch (err) {
        if (err && err.code === 'client_disconnected') {
          pushLog({ kind: 'gemini', model: displayModel, status: 499, ms: Date.now() - t0, error: 'client disconnected', provider: providers.CLOUD });
          return;
        }
        throw err;
      } finally {
        res.removeListener('close', onClose);
        if (clientGone(res) && !ac.signal.aborted) ac.abort();
      }
    });
  }

  function mergeGeminiResponse(chunks) {
    const parts = [];
    let finish = null;
    let usage = null;
    let promptFeedback = null;
    let safetyRatings = null;
    let modelVersion;
    for (const c of chunks) {
      const resp = c.response ?? c;
      const cand = resp.candidates?.[0] ?? {};
      modelVersion = resp.modelVersion ?? modelVersion;
      // Native-клиенты (Google SDK) ждут реальные rating-и, а не пустой массив.
      if (Array.isArray(cand.safetyRatings) && cand.safetyRatings.length) safetyRatings = cand.safetyRatings;
      for (const p of cand.content?.parts ?? []) {
        const last = parts[parts.length - 1];
        // Не приклеивать обычный текст к thought-части: агент и native-ответ
        // принимают её за reasoning и теряют финальный ответ.
        if (typeof p.text === 'string' && last && typeof last.text === 'string'
          && !!last.thought === !!p.thought) last.text += p.text;
        else parts.push(p);
      }
      if (cand.finishReason) finish = cand.finishReason;
      if (resp.usageMetadata) usage = resp.usageMetadata;
      if (resp.promptFeedback) promptFeedback = resp.promptFeedback;
    }
    const blocked = !!promptFeedback?.blockReason && !parts.length && !finish;
    return {
      candidates: blocked ? [] : [{ content: { parts, role: 'model' }, finishReason: finish ?? 'STOP', index: 0, safetyRatings: safetyRatings ?? [] }],
      usageMetadata: usage ?? {},
      modelVersion,
      ...(promptFeedback ? { promptFeedback } : {}),
    };
  }

  async function buildOpenAIModels({ force = false } = {}) {
    let data = [];
    const seenIds = new Set();
    if (!CLOUD_DISABLED) try {
      await waitNetworkReady();
      const models = await catalog.list(() => tokens.getAccessToken(), { force });
      lastCatalogError = '';
      data = [...models.entries()].map(([id, m]) => {
        seenIds.add(id);
        return {
          id: providers.formatModel(providers.CLOUD, id),
          provider: providers.CLOUD,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'antigravity',
          display_name: m.displayName,
          displayName: m.displayName,
          context_length: m.maxTokens ?? undefined,
          max_completion_tokens: m.maxOutputTokens ?? undefined,
          capabilities: providers.describeModel(providers.CLOUD),
        };
      });
    } catch (e) {
      lastCatalogError = redactSecrets(e.message || String(e));
      // каталог аккаунта недоступен — всё равно отдаём web-модели и пользовательские модели
      console.error('  [models] upstream каталог недоступен:', e.message);
    }
    if (!CLOUD_DISABLED && typeof catalog.getCustomModels === 'function') {
      for (const rec of catalog.getCustomModels()) {
        if (seenIds.has(rec.id)) continue;
        seenIds.add(rec.id);
        data.push({
          id: providers.formatModel(providers.CLOUD, rec.id),
          provider: providers.CLOUD,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'antigravity-custom',
          display_name: rec.displayName || rec.id,
          displayName: rec.displayName || rec.id,
          custom: true,
          capabilities: providers.describeModel(providers.CLOUD),
        });
      }
    }
    if (webBridge.enabled) {
      for (const m of webBridge.getModelsList()) {
        data.push({
          ...m,
          id: providers.formatModel(providers.WEB, m.id),
          provider: providers.WEB,
          capabilities: providers.describeModel(providers.WEB, { bridgeEnabled: true }),
        });
      }
    }
    return data;
  }

  async function listModelsOpenAI(res) {
    sendJson(res, 200, { object: 'list', data: await buildOpenAIModels() });
  }

  async function buildGeminiModels() {
    const models = [];
    if (!CLOUD_DISABLED) try {
      await waitNetworkReady();
      const upstreamModels = await catalog.list(() => tokens.getAccessToken());
      lastCatalogError = '';
      for (const [id, m] of upstreamModels.entries()) {
        models.push({
          name: `models/${providers.formatModel(providers.CLOUD, id)}`,
          displayName: m.displayName,
          description: `Cloud Code (Antigravity): ${m.displayName}`,
          provider: providers.CLOUD,
          inputTokenLimit: m.maxTokens ?? undefined,
          outputTokenLimit: m.maxOutputTokens ?? undefined,
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
        });
      }
    } catch (e) {
      lastCatalogError = redactSecrets(e.message || String(e));
      console.error('  [models] upstream каталог недоступен:', e.message);
    }
    if (webBridge.enabled) {
      for (const m of webBridge.getModelsList()) {
        models.push({
          name: `models/${providers.formatModel(providers.WEB, m.id)}`,
          displayName: m.displayName,
          description: `Gemini Web (VERY unreliable for agents): ${m.description || m.displayName}`,
          provider: providers.WEB,
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
        });
      }
    }
    return models;
  }

  async function listModelsGemini(res) {
    sendJson(res, 200, { models: await buildGeminiModels() });
  }

  // GET /v1/models/{id} и GET /v1beta/models/{model} — SDK проверяют модель перед запросом.
  async function getModel(res, api, rawName) {
    let name;
    try { name = decodeURIComponent(rawName); } catch {
      return sendJson(res, 400, { error: { message: 'Invalid model name encoding', type: 'invalid_request_error', code: 'invalid_model_name' } });
    }
    name = name.replace(/^\/+/, '');
    if (name.startsWith('models/')) name = name.slice('models/'.length);
    const notFound = () => sendJson(res, 404, {
      error: {
        message: `Model "${name}" not found. Use the ids from ${api === 'v1beta' ? '/v1beta/models' : '/v1/models'}.`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    });
    if (!name) return notFound();
    if (api === 'v1beta') {
      const models = await buildGeminiModels();
      const found = models.find((m) => m.name === `models/${name}`);
      if (!found) return notFound();
      return sendJson(res, 200, found);
    }
    const data = await buildOpenAIModels();
    const found = data.find((m) => m.id === name);
    if (!found) return notFound();
    return sendJson(res, 200, found);
  }

  // ---- статические ассеты веб-панели и вспомогательные ответы ----

  function servePublicAsset(res, pathname) {
    const asset = resolvePublicAsset(ROOT, pathname, { theme: normalizeIconTheme(config.theme) });
    if (!asset) return false;
    try {
      const data = asset.body || fs.readFileSync(asset.file);
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Control Panel UI files not found.');
    }
    return true;
  }

  function sanitizeConfigForClient() {
    const norm = configLib.normalize(config).config;
    const rawCookie = String(norm.geminiWeb?.cookie || '');
    const accounts = (norm.geminiWeb?.accounts || []).map((a) => ({
      name: a.name,
      label: a.label || '',
      proxy: a.proxy || '',
      authUser: a.authUser,
      thinkMode: a.thinkMode || null,
      temporaryChats: a.temporaryChats === true,
      cookie_file: a.cookie_file || '',
      hasCookie: !!a.cookie,
      hasCookieFile: !!a.cookie_file,
    }));
    return {
      ...norm,
      apiKey: undefined,
      adminKey: undefined,
      hasApiKey: !!config.apiKey,
      hasAdminKey: !!config.adminKey,
      geminiWeb: {
        ...norm.geminiWeb,
        cookie: undefined,
        atToken: undefined,
        cookieSet: !!(rawCookie || norm.geminiWeb?.cookie_file),
        cookieLength: rawCookie.length,
        cookieHasSapisid: /SAPISID=/.test(rawCookie),
        cookieHas1Psid: /__Secure-1PSID=/.test(rawCookie),
        hasAtToken: !!norm.geminiWeb?.atToken,
        accounts,
      },
    };
  }

  function buildStatusSnapshot() {
    const listen = envListen(config);
    return {
      version: APP_VERSION,
      startedAt: stats.startedAt,
      uptime: Math.floor(process.uptime()),
      port: listen.port,
      host: listen.host,
      platform: process.platform,
      nodeVersion: process.version,
      dataDir: DATA_DIR,
      supervised: process.env.AG_SUPERVISED === '1',
      cloudDisabled: CLOUD_DISABLED,
      cloudAuthReady: !CLOUD_DISABLED && (typeof tokens.hasCredentials === 'function' ? tokens.hasCredentials() : true),
      requests: stats.requests,
      errors: stats.errors,
      blocked: stats.blocked,
      tokenRefreshes: upstream.refreshCount,
      tokens: tokens.summary(),
      catalogError: lastCatalogError || null,
      network: network.summary(),
      geminiWeb: webBridge.summary ? webBridge.summary() : null,
      agent: {
        enabled: !(config.agent && config.agent.enabled === false),
        workspace: agent.resolveWorkspace({ ...(config.agent || {}), dataDir: DATA_DIR }, ROOT),
        tools: agent.TOOL_NAMES,
        allowDelete: !!(config.agent && config.agent.allowDelete),
        allowShell: !!(config.agent && config.agent.allowShell),
        allowWebAgent: !!(config.agent && config.agent.allowWebAgent === true),
        maxIterations: (config.agent && config.agent.maxIterations) || agent.DEFAULTS.maxIterations,
        planner: { ...planner.DEFAULT_SETTINGS, ...((config.agent && config.agent.planner) || {}) },
      },
    };
  }

  // ---- маршрутизация ----

  function isLoopbackOrigin(origin) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(origin || '').trim());
  }

  function isLoopbackHostHeader(hostHdr) {
    if (!hostHdr) return true;
    return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(hostHdr).trim());
  }

  function isBoundToLoopback() {
    const h = String(envListen(config).host || '127.0.0.1').trim().toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  }

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return;
    const corsCfg = (config && config.cors) || DEFAULT_CONFIG.cors;
    if (corsCfg.enabled === false) return;
    const normalized = String(origin).trim().replace(/\/+$/, '');
    const allowedList = Array.isArray(corsCfg.origins) ? corsCfg.origins : [];
    const inAllowList = allowedList.includes(normalized);
    const sameHost = isSameOriginAsHost(req);
    const loopbackAllowed = isLoopbackOrigin(normalized);

    if (sameHost || inAllowList) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-credentials', 'true');
    } else if (loopbackAllowed) {
      // Allow Bearer-token API clients on other localhost ports (Open WebUI, LibreChat),
      // WITHOUT exposing admin session cookies across ports.
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    } else if (corsCfg.allowAnyOrigin === true) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('vary', 'origin');
    } else {
      return;
    }
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', (req.headers['access-control-request-headers'] || 'authorization,content-type,x-api-key,x-goog-api-key,x-admin-key,x-ag-ui,anthropic-version,anthropic-beta').slice(0, 1024));
    res.setHeader('access-control-max-age', '600');
  }

  async function readJsonObj(req, res) {
    const read = await readBodyOrRespond(req, res);
    if (!read.ok) return null;
    try {
      return parseRequestBody(read.raw);
    } catch {
      sendJson(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
      return null;
    }
  }

  function scheduleProcessAction(action) {
    setTimeout(() => {
      for (const client of eventClients) {
        try { client.end(); } catch {}
      }
      eventClients.clear();
      try { guard.flush(); } catch {}
      try { webBridge.closeAllSockets?.(); } catch {}
      try { network.destroyAll?.(); } catch {}
      const exitCode = action === 'restart' && process.env.AG_SUPERVISED === '1' ? 75 : 0;
      const done = () => {
        if (action === 'restart' && process.env.AG_SUPERVISED !== '1') {
          try {
            const { spawn } = require('child_process');
            spawn(process.execPath, [path.join(ROOT, 'server.js')], {
              cwd: ROOT,
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            }).unref();
          } catch {}
        }
        process.exit(exitCode);
      };
      const hard = setTimeout(() => {
        try { server.closeAllConnections?.(); } catch {}
        done();
      }, 2000);
      if (hard.unref) hard.unref();
      try {
        server.close(() => { clearTimeout(hard); done(); });
        server.closeIdleConnections?.();
      } catch {
        clearTimeout(hard);
        done();
      }
    }, 80).unref?.();
  }

  async function handler(req, res) {
    let p = req.url;
    if (isBoundToLoopback() && !isLoopbackHostHeader(req.headers.host)) {
      return forbidden(res, 'invalid_host', 'Loopback gateway rejects non-local Host headers (DNS rebinding protection).');
    }
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      let u;
      try { u = new URL(req.url, 'http://localhost'); } catch {
        throw requestError('Invalid request URL');
      }
      p = u.pathname;
      if (p === '/_health') return sendJson(res, 200, { ok: true, uptime: process.uptime(), version: APP_VERSION });
      if (p === '/api/diagnostics/chat') return await handleDiagnosticChat(req, res);

      if (p === '/_auth/session') {
        if (req.method === 'GET') {
          return sendJson(res, 200, { authenticated: adminOk(req), supervised: process.env.AG_SUPERVISED === '1' });
        }
        if (req.method === 'POST') {
          const blockedUntil = authBlocked(req);
          if (blockedUntil) return unauthorized(res, blockedUntil);
          const body = await readJsonObj(req, res);
          if (!body) return;
          const expected = config.adminKey || config.apiKey;
          const candidate = String(body.adminKey || body.key || '').trim();
          if (!keyEquals(candidate, expected)) {
            noteAuthFailure(req);
            return unauthorized(res);
          }
          issueSessionCookie(res);
          return sendJson(res, 200, { ok: true });
        }
      }
      if (p === '/_auth/logout' && req.method === 'POST') {
        const sid = parseCookies(req).ag_admin_session;
        if (sid) adminSessions.delete(sid);
        res.setHeader('set-cookie', 'ag_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && p === '/') {
        const launch = u.searchParams.get('launch');
        if (launch) {
          if (consumeLaunchNonce(launch)) {
            issueSessionCookie(res);
          }
          res.writeHead(302, { location: '/' });
          return res.end();
        }
        if (authOk(req) && !adminOk(req)) {
          return forbidden(res, 'admin_key_required', 'Веб-панель доступна только с админским ключом (admin.key). Клиентский API-ключ не даёт доступа к панели.');
        }
        return servePublicAsset(res, '/');
      }

      if (req.method === 'GET' && p !== '/' && servePublicAsset(res, p)) {
        return;
      }

      const blockedUntil = authBlocked(req);
      if (blockedUntil) return unauthorized(res, blockedUntil);
      if (!statusOk(req)) {
        noteAuthFailure(req);
        return unauthorized(res);
      }

      if (p === '/_status') {
        return sendJson(res, 200, buildStatusSnapshot());
      }

      if (p === '/_limits' || p === '/_quota') {
        await waitNetworkReady();
        const force = u.searchParams.get('force') === '1';
        if (CLOUD_DISABLED || (typeof tokens.hasCredentials === 'function' && !tokens.hasCredentials())) {
          const reply = {
            local: guard.summary(),
            account: { error: CLOUD_DISABLED ? 'cloud_disabled' : 'auth_missing' },
            models: [],
            modelsError: CLOUD_DISABLED ? 'cloud-модели отключены (AG_NO_CLOUD=1)' : 'OAuth-токен Antigravity (auth.json) не найден',
            quotaFamilies: {},
            serverQuotas: null,
            config: { safeMode: guard.cfg },
            geminiWeb: webBridge.summary ? webBridge.summary() : null,
            network: network.summary(),
          };
          return sendJson(res, 200, p === '/_quota' ? { serverQuotas: null } : reply);
        }
        const quotaP = upstream.getQuotaSummary({ force });
        if (p === '/_quota') return sendJson(res, 200, await quotaP);

        let modelsError = null;
        const [serverQuotas, account] = await Promise.all([
          quotaP,
          upstream.getAccountInfo({ force }),
          (async () => {
            try {
              await catalog.list(() => tokens.getAccessToken(), { force });
              lastCatalogError = '';
            } catch (e) {
              modelsError = e.message;
              lastCatalogError = redactSecrets(e.message || String(e));
            }
          })(),
        ]);
        const models = catalog.cache
          ? [...catalog.cache.models.entries()].map(([id, m]) => ({
              id,
              displayName: m.displayName,
              maxTokens: m.maxTokens,
              maxOutputTokens: m.maxOutputTokens,
              quota: m.quota,
            }))
          : null;
        return sendJson(res, 200, {
          local: guard.summary(),
          account,
          models,
          modelsError,
          quotaFamilies: catalog.getQuotaSummary(),
          serverQuotas,
          config: { safeMode: guard.cfg },
          geminiWeb: webBridge.summary ? webBridge.summary() : null,
          network: network.summary(),
        });
      }

      // ---- Админские маршруты (только admin.key / сессия панели) ----
      const requireAdmin = () => {
        if (adminOk(req)) return true;
        forbidden(res, 'admin_key_required', 'Доступ разрешён только с админским ключом (admin.key) или через сессию веб-панели.');
        return false;
      };

      if (p === '/_auth/launch' && req.method === 'POST') {
        if (!requireAdmin()) return;
        return sendJson(res, 200, { ok: true, nonce: mintLaunchNonce() });
      }

      if (p === '/_keys' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return sendJson(res, 200, { apiKey: config.apiKey || '', adminKey: config.adminKey || '' });
      }

      if (p === '/_usage' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return sendJson(res, 200, {
          summary: guard.summary(),
          history: guard.history(30),
          stats: { ...stats, uptime: Math.floor(process.uptime()) },
        });
      }

      if (p === '/_logs' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return sendJson(res, 200, { logs: log.slice().reverse(), stats: { ...stats, uptime: Math.floor(process.uptime()) } });
      }

      if (p === '/_events' && req.method === 'GET') {
        if (!requireAdmin()) return;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        eventClients.add(res);
        res.write(`event: init\ndata: ${JSON.stringify({ status: buildStatusSnapshot(), logs: log.slice().reverse().slice(0, 60) })}\n\n`);
        const hb = setInterval(() => {
          if (res.writableEnded || res.destroyed) return;
          res.write(`event: heartbeat\ndata: ${JSON.stringify({ uptime: Math.floor(process.uptime()), requests: stats.requests, errors: stats.errors, blocked: stats.blocked })}\n\n`);
        }, 15000);
        if (hb.unref) hb.unref();
        req.on('close', () => {
          clearInterval(hb);
          eventClients.delete(res);
        });
        return;
      }

      if ((p === '/_auth/extract' || p === '/_auth/reload') && req.method === 'POST') {
        if (!requireAdmin()) return;
        if (CLOUD_DISABLED) {
          return sendJson(res, 400, { error: { message: 'Cloud режим отключён (AG_NO_CLOUD=1).', code: 'cloud_disabled' } });
        }
        try {
          let extracted = null;
          if (p === '/_auth/extract') {
            extracted = autoExtract({ force: true, outPath: authFile });
          }
          tokens.reloadFromDisk();
          catalog.project = tokens.projectId || '';
          catalog.invalidate();
          upstream._accInfo = null;
          upstream._quotaSummary = null;
          return sendJson(res, 200, {
            ok: true,
            dbSource: extracted?.data?.db_source || '',
            tokens: tokens.summary(),
          });
        } catch (e) {
          return sendJson(res, e.status || 500, {
            error: { message: e.message || 'Auth extract failed', code: e.code || 'auth_extract_failed' },
          });
        }
      }

      if (p === '/_web/accounts') {
        if (!requireAdmin()) return;
        if (req.method === 'GET') {
          const ws = webBridge.summary ? webBridge.summary() : {};
          return sendJson(res, 200, {
            activeAccount: config.geminiWeb.activeAccount || '',
            accounts: (config.geminiWeb.accounts || []).map((a) => ({
              name: a.name,
              label: a.label || '',
              proxy: a.proxy || '',
              authUser: a.authUser,
              thinkMode: a.thinkMode || null,
              temporaryChats: a.temporaryChats === true,
              cookie_file: a.cookie_file || '',
              hasCookie: !!a.cookie,
              hasCookieFile: !!a.cookie_file,
              stats: (ws.accounts || []).find((x) => x.name === a.name) || null,
            })),
          });
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'GET, POST');
          return sendJson(res, 405, { error: { message: 'Используйте GET или POST', type: 'invalid_request_error' } });
        }
        const acctBody = await readJsonObj(req, res);
        if (!acctBody) return;
        return await handleWebAccountAction(res, acctBody);
      }

      const resolveEffectiveWebProxy = (explicitProxy, targetAcc) => {
        if (explicitProxy !== undefined && String(explicitProxy).trim() !== '') {
          return convertTelegramSocksLink(explicitProxy);
        }
        const activeAcc = (config.geminiWeb.accounts || []).find((a) => a.name === config.geminiWeb.activeAccount);
        const ftEnabled = !!(config.geminiWeb && config.geminiWeb.freeTunnel && config.geminiWeb.freeTunnel.enabled);
        const ftProxy = ftEnabled ? freeTunnel.getActiveProxyUrlSync() : '';
        return String(
          (targetAcc && targetAcc.proxy)
          || (activeAcc && activeAcc.proxy)
          || config.geminiWeb.proxy
          || ftProxy
          || config.network.proxy
          || ''
        ).trim();
      };

      if (p === '/_web/free-tunnel/status' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const ftCfg = (config.geminiWeb && config.geminiWeb.freeTunnel) || { enabled: false, customSource: '' };
        const st = await freeTunnel.getStatus(ftCfg.customSource || '');
        return sendJson(res, 200, {
          ok: true,
          enabled: ftCfg.enabled === true,
          customSource: ftCfg.customSource || '',
          ...st,
        });
      }

      if (p === '/_web/free-tunnel' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readJsonObj(req, res);
        if (!body) return;
        const action = String(body.action || 'start').toLowerCase();
        const customSource = body.customSource !== undefined
          ? String(body.customSource || '').trim()
          : ((config.geminiWeb && config.geminiWeb.freeTunnel && config.geminiWeb.freeTunnel.customSource) || '');

        if (action === 'stop') {
          const patch = configLib.patchConfig(config, { geminiWeb: { freeTunnel: { enabled: false, customSource } } });
          Object.assign(config, patch.config);
          saveConfigFile();
          const st = await freeTunnel.stop();
          syncRuntimeTunnelToBridge();
          return sendJson(res, 200, { ok: true, enabled: false, customSource, ...st });
        }

        if (!['start', 'rotate', 'scan', 'select'].includes(action)) {
          return sendJson(res, 400, { error: { message: 'Unknown action (use start, stop, rotate, scan, or select)' } });
        }
        const selectKey = action === 'select' ? String(body.nodeKey || '').trim() : '';
        if (action === 'select' && !selectKey) {
          return sendJson(res, 400, { error: { message: 'nodeKey is required for select action' } });
        }

        const patch = configLib.patchConfig(config, { geminiWeb: { freeTunnel: { enabled: true, customSource } } });
        Object.assign(config, patch.config);
        saveConfigFile();

        const runPromise = freeTunnel.start({
          customSource,
          rotate: action === 'rotate',
          forceScan: action === 'scan',
          selectKey,
        }).then((st) => { syncRuntimeTunnelToBridge(); return st; });

        if (body.async === true) {
          runPromise.catch(() => {});
          const st = await freeTunnel.getStatus(customSource);
          return sendJson(res, 200, { ok: true, enabled: true, customSource, ...st });
        }

        try {
          const st = await runPromise;
          return sendJson(res, 200, { ok: true, enabled: true, customSource, ...st });
        } catch (e) {
          return sendJson(res, 502, { error: { message: e.message, code: 'free_tunnel_failed' } });
        }
      }

      if (p === '/_web/browser/open' && req.method === 'POST') {
        if (!requireAdmin()) return;
        let body = {};
        try {
          const raw = await readBody(req, 65536);
          if (raw && raw.trim()) body = JSON.parse(raw);
        } catch {}
        try {
          const targetAcc = body.accountName ? (config.geminiWeb.accounts || []).find((a) => a.name === body.accountName) : null;
          const rawProxy = resolveEffectiveWebProxy(body.proxy, targetAcc);
          const info = await cdpCookies.openGeminiLoginWindow(cdpCookies.GEMINI_URL, { proxy: rawProxy });
          return sendJson(res, 200, info);
        } catch (e) {
          return sendJson(res, (e.code === 'mtproto_unsupported' || e.code === 'browser_not_found') ? 400 : 500, { error: { message: e.message, code: e.code || 'browser_open_failed' } });
        }
      }

      if (p === '/_web/browser/import-cookies' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readJsonObj(req, res);
        if (!body) return;
        const targetAcc = body.accountName ? (config.geminiWeb.accounts || []).find((a) => a.name === body.accountName) : null;
        try {
          const rawProxy = resolveEffectiveWebProxy(body.proxy, targetAcc);
          const resCdp = await cdpCookies.importGeminiCookiesViaCdp({ extractAtToken: true, proxy: rawProxy });
          let saved = false;
          if (resCdp.cookie && body.saveTo === 'single') {
            const patch = configLib.patchConfig(config, {
              geminiWeb: {
                cookie: resCdp.cookie,
                cookie_file: '',
                ...(resCdp.atToken ? { atToken: resCdp.atToken } : {}),
              },
            });
            Object.assign(config, patch.config);
            webBridge.updateConfig(config.geminiWeb);
            saveConfigFile();
            saved = true;
          } else if (resCdp.cookie && body.saveTo === 'account' && body.accountName) {
            const name = String(body.accountName).trim();
            const exists = (config.geminiWeb.accounts || []).some((a) => a.name.toLowerCase() === name.toLowerCase());
            // Save into account via handleWebAccountAction logic directly
            const list = (config.geminiWeb.accounts || []).map((a) => ({ ...a }));
            if (exists) {
              const item = list.find((a) => a.name.toLowerCase() === name.toLowerCase());
              item.cookie = resCdp.cookie;
              item.cookie_file = '';
            } else {
              list.push({ name, cookie: resCdp.cookie, cookie_file: '', authUser: null, proxy: '', label: '', thinkMode: null, temporaryChats: false });
            }
            const patch = configLib.patchConfig(config, { geminiWeb: { accounts: list, activeAccount: name } });
            Object.assign(config, patch.config);
            webBridge.updateConfig(config.geminiWeb);
            saveConfigFile();
            saved = true;
          }
          return sendJson(res, 200, {
            ok: resCdp.ok,
            count: resCdp.count,
            hasSapisid: resCdp.hasSapisid,
            has1Psid: resCdp.has1Psid,
            domains: resCdp.domains,
            hasAtToken: !!resCdp.atToken,
            saved,
            ...(body.returnCookie ? { cookie: resCdp.cookie } : {}),
          });
        } catch (e) {
          return sendJson(res, 500, { error: { message: e.message, code: e.code || 'cdp_import_failed' } });
        }
      }

      if (p === '/_web/test' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readJsonObj(req, res);
        if (!body) return;
        let webProxy = '';
        try {
          webProxy = resolveEffectiveWebProxy(body.proxy, null);
        } catch (e) {
          return sendJson(res, 400, { error: { message: e.message, code: e.code || 'invalid_proxy' } });
        }
        const tmpNet = new NetworkManager({
          ...config,
          network: { ...config.network, proxy: webProxy },
        });
        try {
          const [geminiProbe, accountsProbe] = await Promise.all([
            tmpNet.probe('https://gemini.google.com/app', 'web', 6000),
            tmpNet.probe('https://accounts.google.com/', 'web', 6000),
          ]);
          const proxyCheck = webProxy ? await tmpNet.probeProxy(tmpNet.proxyForHost('web', 'gemini.google.com', webProxy), 5000) : null;
          return sendJson(res, 200, {
            ok: geminiProbe.ok && (!proxyCheck || proxyCheck.ok),
            proxy: webProxy || '',
            proxyCheck,
            gemini: geminiProbe,
            accounts: accountsProbe,
          });
        } finally {
          tmpNet.destroyAll();
        }
      }

      if (p === '/_config') {
        if (!requireAdmin()) return;
        if (req.method === 'GET') {
          return sendJson(res, 200, sanitizeConfigForClient());
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'GET, POST');
          return sendJson(res, 405, { error: { message: 'Используйте GET или POST', type: 'invalid_request_error' } });
        }
        const parsed = await readJsonObj(req, res);
        if (!parsed) return;

        try {
          if (parsed.network && typeof parsed.network.proxy === 'string' && parsed.network.proxy.trim()) {
            convertTelegramSocksLink(parsed.network.proxy);
          }
          if (parsed.geminiWeb && typeof parsed.geminiWeb.proxy === 'string' && parsed.geminiWeb.proxy.trim()) {
            convertTelegramSocksLink(parsed.geminiWeb.proxy);
          }
          if (parsed.geminiWeb && Array.isArray(parsed.geminiWeb.accounts)) {
            for (const acc of parsed.geminiWeb.accounts) {
              if (acc && typeof acc.proxy === 'string' && acc.proxy.trim()) {
                convertTelegramSocksLink(acc.proxy);
              }
            }
          }
        } catch (err) {
          return sendJson(res, 400, { error: { code: err.code || 'invalid_proxy', message: err.message, type: 'invalid_request_error' } });
        }

        const prevPort = config.port;
        const prevHost = config.host;
        const prevTheme = normalizeIconTheme(config.theme);
        const patch = configLib.patchConfig(config, parsed);
        Object.assign(config, patch.config);
        syncOutputHeadroom(config);

        guard.updateConfig(config.safeMode);
        syncRuntimeTunnelToBridge();
        if (typeof network.autoDetect === 'function') network.autoDetect();

        if (patch.applied.length) {
          const saveErr = saveConfigFile();
          if (saveErr) {
            return sendJson(res, 500, { error: { message: `Не удалось записать config.json: ${saveErr.message}`, type: 'internal_error' } });
          }
          const nextTheme = normalizeIconTheme(config.theme);
          if (prevTheme !== nextTheme) {
            shortcuts.clearAppFaviconCache(nextTheme);
          }
        }

        const restartRequired = patch.ignored.filter((k) => /allowDelete|allowShell|allowAbsolutePaths|auditFile/.test(k));
        if (config.port !== prevPort) restartRequired.push('port');
        if (config.host !== prevHost) restartRequired.push('host');

        const reply = {
          ok: true,
          applied: patch.applied,
          ignored: patch.ignored,
          warnings: patch.warnings,
          restartRequired,
          safeMode: guard.cfg,
          network: network.summary(),
        };
        if (webBridge.summary) reply.geminiWeb = webBridge.summary();
        return sendJson(res, 200, reply);
      }

      if (p === '/_network/detect-proxy' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const proxies = await detectProxies();
        return sendJson(res, 200, { ok: true, proxies });
      }

      if (p === '/_network/test') {
        if (req.method === 'GET') {
          const timeout = Math.max(2000, Math.min(15000, Number(u.searchParams.get('timeout')) || 5000));
          return sendJson(res, 200, await network.test(timeout));
        }
        if (req.method === 'POST') {
          if (!requireAdmin()) return;
          const body = await readJsonObj(req, res);
          if (!body) return;
          const timeout = Math.max(2000, Math.min(15000, Number(body.timeout) || 5000));
          const draftCfg = {
            ...config,
            ...(isPlainObject(body.network) ? { network: { ...config.network, ...body.network } } : {}),
            ...(isPlainObject(body.geminiWeb) ? { geminiWeb: { ...config.geminiWeb, ...body.geminiWeb } } : {}),
          };
          const tmpNet = new NetworkManager(draftCfg);
          try {
            return sendJson(res, 200, await tmpNet.test(timeout));
          } finally {
            tmpNet.destroyAll();
          }
        }
      }

      if (p === '/_installs') {
        if (!requireAdmin()) return;
        if (req.method === 'GET') {
          const force = u.searchParams.get('force') === '1';
          return sendJson(res, 200, installsLib.detectInstallations(DATA_DIR, { force }));
        }
        if (req.method === 'POST') {
          const body = await readJsonObj(req, res);
          if (!body) return;
          return sendJson(res, 200, installsLib.setInstallPath(DATA_DIR, body.key, body.path));
        }
      }
      if (p === '/_installs/open' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readJsonObj(req, res);
        if (!body) return;
        return sendJson(res, 200, installsLib.openInstallFolder(DATA_DIR, body.key));
      }

      if (p === '/_auth/oauth/start' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readJsonObj(req, res);
        if (!body) return;
        const started = await startInteractiveOAuth({
          authFile,
          network,
          openBrowser: body.openBrowser !== false,
          lang: body.lang || config.language || 'ru',
          theme: body.theme || config.theme || 'dark',
          onSuccess: async () => {
            tokens.reloadFromDisk();
            upstream._accInfo = null;
            upstream._quotaSummary = null;
            catalog.invalidate();
            catalog.project = tokens.projectId || '';
          },
        });
        return sendJson(res, 200, started);
      }

      if (p === '/_auth/oauth/status' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return sendJson(res, 200, getOAuthStatus());
      }

      if (p === '/_models/catalog' && req.method === 'GET') {
        if (!requireAdmin()) return;
        const force = u.searchParams.get('force') === '1';
        let fetchErr = '';
        if (!CLOUD_DISABLED && typeof tokens.hasCredentials === 'function' && tokens.hasCredentials()) {
          try {
            await waitNetworkReady();
            await catalog.list(() => tokens.getAccessToken(), { force });
            lastCatalogError = '';
          } catch (e) {
            fetchErr = redactSecrets(e.message || String(e));
            lastCatalogError = fetchErr;
          }
        }
        if (webBridge.enabled && (force || webBridge.getLoadedCookie().cookieStr || network.summary().proxy)) {
          try {
            await waitNetworkReady();
            await webBridge.refreshModels({ force, lang: config.language || 'ru', timeoutMs: 8000 });
          } catch {}
        }
        const snap = catalog.getCatalogSnapshot();
        const webModels = webBridge.enabled
          ? webBridge.getModelsList().map((m) => {
              const fullId = providers.formatModel(providers.WEB, m.id);
              return {
                id: fullId,
                rawId: m.id,
                provider: providers.WEB,
                displayName: m.display_name || m.displayName || m.id,
                description: m.description || '',
                inLiveCatalog: !!m.inLiveCatalog,
                isNew: !!m.isNew,
                legacyAlias: !!m.legacyAlias,
                lockedByPlan: !!m.lockedByPlan,
                planTag: m.planTag || '',
                supportsThinking: m.supportsThinking !== false,
                capabilities: providers.describeModel(providers.WEB, { bridgeEnabled: true }),
                health: catalog.getHealth(fullId),
              };
            })
          : [];
        return sendJson(res, 200, {
          ...snap,
          web: webModels,
          webCatalogMeta: webBridge.getLiveMeta(),
          catalogError: fetchErr || lastCatalogError || null,
          cloudDisabled: CLOUD_DISABLED,
        });
      }

      if (p === '/_models/custom' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readJsonObj(req, res);
        if (!body) return;
        const action = String(body.action || 'add').toLowerCase();
        const modelId = String(body.model || '').trim();
        if (action === 'remove') {
          const removed = catalog.removeCustomModel(modelId);
          return sendJson(res, 200, { ok: true, removed, snapshot: catalog.getCatalogSnapshot() });
        }
        try {
          const added = catalog.addCustomModel(modelId, body.displayName || '');
          return sendJson(res, 200, { ok: true, model: added, snapshot: catalog.getCatalogSnapshot() });
        } catch (err) {
          return sendJson(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
        }
      }

      if (p === '/_models/check' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const body = await readJsonObj(req, res);
        if (!body) return;
        await waitNetworkReady();

        const webBatchMap = new Map();
        const probeWebModel = async (rawId) => {
          const started = Date.now();
          if (!webBridge.enabled) {
            return { status: 'error', httpStatus: 503, ms: 0, error: 'Gemini Web мост выключен' };
          }
          const sum = webBridge.summary ? webBridge.summary() : {};
          const hasWebCreds = !!(
            sum.cookieSet
            || sum.hasCookie
            || sum.cookieConfigured
            || (Array.isArray(sum.accounts) && sum.accounts.some((a) => a && a.hasCookie))
            || (sum.accountsCount > 0)
          );
          if (!hasWebCreds) {
            return { status: 'forbidden', httpStatus: 401, ms: 0, error: 'Не заданы cookie для Gemini Web' };
          }
          const ac = new AbortController();
          const timer = setTimeout(() => { try { ac.abort(); } catch {} }, 35000);
          if (timer.unref) timer.unref();
          try {
            const meta = webBridge.getModelMeta(rawId);
            const build = () => webBridge.buildPayload('Reply with OK.', meta.modelId, meta.thinkMode, 'en');
            const initialPayload = build();
            const upRes = await webBridge.sendStreamRequestResilient(initialPayload, meta, 'en', {
              signal: ac.signal,
              rebuildPayload: build,
            });
            let gotDelta = false;
            try {
              for await (const delta of webBridge.streamResponse(upRes)) {
                if (String(delta || '').trim()) {
                  gotDelta = true;
                  break;
                }
              }
            } finally {
              try { ac.abort(); } catch {}
              try { if (upRes && typeof upRes.destroy === 'function') upRes.destroy(); } catch {}
              try { if (upRes && upRes.body && typeof upRes.body.destroy === 'function') upRes.body.destroy(); } catch {}
            }
            return {
              status: gotDelta ? 'working' : 'error',
              httpStatus: gotDelta ? 200 : 502,
              ms: Date.now() - started,
              error: gotDelta ? '' : 'Пустой ответ Gemini Web',
            };
          } catch (e) {
            const msg = String(e.message || e);
            let st = 'error';
            if (e.status === 429) st = 'rate_limited';
            else if (e.code === 'region_not_supported' || e.status === 451 || /region|location|country|1060/i.test(msg)) st = 'region_blocked';
            else if (e.status === 401 || e.status === 403 || e.code === 'auth_required') st = 'forbidden';
            return {
              status: st,
              httpStatus: e.status || (st === 'region_blocked' ? 400 : 502),
              ms: Date.now() - started,
              error: redactSecrets(msg),
            };
          } finally {
            clearTimeout(timer);
          }
        };

        const probeOne = async (fullId) => {
          const started = Date.now();
          const isWeb = /^web\//i.test(fullId);
          const rawId = fullId.replace(/^(?:cloud|web)\//i, '');
          if (isWeb) {
            if (!body.model) {
              let batchKey = rawId;
              try {
                const m = webBridge.getModelMeta(rawId);
                batchKey = `${m.modelId}:${m.thinkMode}`;
              } catch {}
              if (!webBatchMap.has(batchKey)) webBatchMap.set(batchKey, probeWebModel(rawId));
              const shared = await webBatchMap.get(batchKey);
              return catalog.recordHealth(fullId, shared);
            }
            return catalog.recordHealth(fullId, await probeWebModel(rawId));
          }

          if (CLOUD_DISABLED) {
            return catalog.recordHealth(fullId, { status: 'error', httpStatus: 503, ms: 0, error: 'AG_NO_CLOUD=1' });
          }
          try {
            const upRes = await upstream.generateContent(
              rawId,
              {
                contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                generationConfig: { maxOutputTokens: 1 },
              },
              { signal: AbortSignal.timeout(12000) }
            );
            const ms = Date.now() - started;
            const txt = await upRes.text().catch(() => '');
            if (upRes.ok) {
              return catalog.recordHealth(fullId, { status: 'working', httpStatus: upRes.status, ms, error: '' });
            }
            let st = 'error';
            let msg = `HTTP ${upRes.status}`;
            if (upRes.status === 404) { st = 'not_found'; msg = 'Удалена / не найдена (404)'; }
            else if (upRes.status === 403) { st = 'forbidden'; msg = 'Нет доступа по тарифу (403)'; }
            else if (upRes.status === 429) { st = 'rate_limited'; msg = 'Лимит исчерпан (429)'; }
            else if (upRes.status === 400 && /location|region|country/i.test(txt)) { st = 'region_blocked'; msg = 'Гео-ограничение (400)'; }
            else if (txt) { msg = redactSecrets(`HTTP ${upRes.status}: ${txt.slice(0, 120)}`); }
            return catalog.recordHealth(fullId, { status: st, httpStatus: upRes.status, ms, error: msg });
          } catch (e) {
            return catalog.recordHealth(fullId, {
              status: 'error',
              httpStatus: e.status || null,
              ms: Date.now() - started,
              error: redactSecrets(e.message || String(e)),
            });
          }
        };

        let targets = [];
        if (body.model) {
          targets = [String(body.model).trim()];
        } else {
          const scope = String(body.scope || 'all').toLowerCase();
          if (scope !== 'web' && !CLOUD_DISABLED) {
            try { await catalog.list(() => tokens.getAccessToken()); } catch {}
            const snap = catalog.getCatalogSnapshot();
            for (const m of [...snap.active, ...snap.custom, ...snap.removed]) targets.push(m.id);
          }
          if (scope !== 'cloud' && webBridge.enabled) {
            for (const m of webBridge.getModelsList()) targets.push(providers.formatModel(providers.WEB, m.id));
          }
          targets = [...new Set(targets)];
        }

        const results = {};
        const concurrency = 3;
        let idx = 0;
        const worker = async () => {
          while (idx < targets.length) {
            const id = targets[idx++];
            results[id] = await probeOne(id);
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker));
        return sendJson(res, 200, { ok: true, checked: Object.keys(results).length, results });
      }

      if (p === '/_startup') {
        if (!requireAdmin()) return;
        if (req.method === 'GET') {
          return sendJson(res, 200, shortcuts.getAutostartInfo({ rootDir: ROOT }));
        }
        if (req.method === 'POST') {
          const body = await readJsonObj(req, res);
          if (!body) return;
          return sendJson(res, 200, shortcuts.setAutostart(!!body.enabled, { rootDir: ROOT }));
        }
      }

      if (p === '/_backups' && req.method === 'GET') {
        if (!requireAdmin()) return;
        return sendJson(res, 200, { backups: updater.listBackups({ rootDir: ROOT, dataDir: DATA_DIR }) });
      }

      if (p === '/_datadir/open' && req.method === 'POST') {
        if (!requireAdmin()) return;
        fs.mkdirSync(DATA_DIR, { recursive: true });
        return sendJson(res, 200, installsLib.openFolderDirect(DATA_DIR));
      }

      if (p === '/_backup' && req.method === 'POST') {
        if (!requireAdmin()) return;
        const result = updater.createBackup({ rootDir: ROOT, dataDir: DATA_DIR, reason: 'panel' });
        return sendJson(res, 200, { ok: true, backup: result.manifest });
      }

      if (p === '/_server/restart' && req.method === 'POST') {
        if (!requireAdmin()) return;
        sendJson(res, 200, { ok: true, action: 'restart', port: config.port, supervised: process.env.AG_SUPERVISED === '1' });
        scheduleProcessAction('restart');
        return;
      }

      if (p === '/_server/shutdown' && req.method === 'POST') {
        if (!requireAdmin()) return;
        sendJson(res, 200, { ok: true, action: 'shutdown' });
        scheduleProcessAction('shutdown');
        return;
      }

      if (req.method === 'GET' && /^\/v1\/models\/?$/.test(p)) return await listModelsOpenAI(res);
      if (req.method === 'GET' && /^\/v1beta\/models\/?$/.test(p)) return await listModelsGemini(res);

      const getOne = p.match(/^\/(v1beta|v1)\/models\/(.+)$/);
      if (req.method === 'GET' && getOne) return await getModel(res, getOne[1], getOne[2]);

      const gm = p.match(/^\/(v1beta|v1)\/models\/(.+?)(?::(generateContent|streamGenerateContent|countTokens))?$/);
      if (req.method === 'POST' && gm) {
        let model;
        try { model = decodeURIComponent(gm[2]); } catch {
          return sendJson(res, 400, { error: { message: 'Invalid model name encoding', type: 'invalid_request_error', code: 'invalid_model_name' } });
        }
        const method = gm[3] ?? 'generateContent';
        return await handleGeminiGenerate(req, res, model, method);
      }

      if (req.method === 'POST' && p === '/v1/chat/completions') return await handleOpenAIChat(req, res);
      if (req.method === 'POST' && p === '/v1/messages') return await handleAnthropicMessages(req, res);
      if (req.method === 'POST' && p === '/v1/messages/count_tokens') return await handleAnthropicCountTokens(req, res);

      sendJson(res, 404, { error: { message: `Нет пути ${p}. Доступно: /v1/chat/completions, /v1/messages, /v1/messages/count_tokens, /v1/models, /v1/models/{id}, /v1beta/models, /v1beta/models/{m}:generateContent|streamGenerateContent|countTokens` } });
    } catch (e) {
      if (e && e.code === 'client_disconnected') {
        pushLog({ kind: 'http', status: 499, error: 'client disconnected' });
        return;
      }
      stats.errors++;
      const status = e.status >= 400 && e.status <= 599 ? e.status : 500;
      if (status >= 500) console.error('  [request error]', req.method, p, e);
      else console.error('  [request error]', req.method, p, e.message || e);
      sendApiError(res, status, { error: {
        message: e.message || 'Internal server error',
        type: status < 500 ? 'invalid_request_error' : 'api_error',
        code: status,
      } }, p === '/v1/chat/completions');
    }
  }

  const listen = envListen(config);
  const server = http.createServer(handler);
  server.on('error', (e) => {
    console.error(`  ! Порт ${listen.port}: ${e.message}`);
    if (e.code === 'EADDRINUSE') console.error('    Уже занят. Поменяй "port" в config.json или веб-панели.');
  });
  server.listen(listen.port, listen.host);

  return { server, tokens, catalog, upstream, config, network, guard, webBridge };
}

// ---------------------------------------------------------------- CLI

function main() {
  const cmd = process.argv[2];
  let loaded;
  try {
    loaded = loadConfig(DATA_DIR);
  } catch (e) {
    console.error(`\n  ! ${e.message}\n`);
    process.exit(1);
  }
  const { config, created } = loaded;
  config.userAgent = resolveCloudCodeUserAgent(config.userAgent);

  if (cmd === '--version' || cmd === '-v') {
    console.log(APP_VERSION);
    return;
  }

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log([
      `Antigravity API v${APP_VERSION}`,
      'Usage: node server.js [command]',
      '',
      'Commands:',
      '  start             Start HTTP API gateway and Control Panel (default)',
      '  key               Print client API key (apikey.txt)',
      '  admin-key         Print administrator key (admin.key)',
      '  models            List live Cloud Code models for configured account',
      '  --version, -v     Print version',
      '  --help, -h        Show this help',
    ].join('\n'));
    return;
  }

  if (cmd === 'key' || cmd === '--print-key') {
    console.log(config.apiKey);
    return;
  }

  if (cmd === 'admin-key' || cmd === '--print-admin-key') {
    console.log(config.adminKey);
    return;
  }

  if (cmd === 'models' || cmd === '--models') {
    const authFile = process.env.AG_AUTH_FILE || path.join(DATA_DIR, 'auth.json');
    const network = new NetworkManager(config);
    const run = async () => {
      if (network.autoDetect) await network.autoDetect();
      const tokens = new TokenManager(authFile, { network, allowMissing: false });
      const catalog = new ModelCatalog(config.upstreamHost, {
        project: tokens.projectId,
        userAgent: config.userAgent,
        fallbackHost: config.upstreamFallbackHost,
        network,
      });
      const models = await catalog.list(() => tokens.getAccessToken());
      for (const [id, m] of models) console.log(`  ${id.padEnd(32)} ${m.displayName}`);
      network.destroyAll();
    };
    run().catch((e) => {
      network.destroyAll();
      console.error(e.message);
      process.exit(1);
    });
    return;
  }

  if (cmd && cmd !== 'start') {
    console.log('Commands: start (default) | key (show API key) | models (list models)');
    return;
  }

  // 0.0.0.0 — это «слушать всё»; в подсказке должен быть реальный адрес.
  const eff = envListen(config);
  const bannerHost = !eff.host || eff.host === '0.0.0.0' || eff.host === '::' ? '127.0.0.1' : eff.host;
  console.log(`
  ANTIGRAVITY API — OpenAI & Gemini Compatible Gateway
  ────────────────────────────────────────────────────────────────────────
  Base URL (OpenAI):   http://${bannerHost}:${eff.port}/v1
  Base URL (Gemini):   http://${bannerHost}:${eff.port}/v1beta
  API Key File:        ${path.join(DATA_DIR, 'apikey.txt')}${config.apiKey ? '' : ' (не создан)'}
  Admin Key File:      ${path.join(DATA_DIR, ADMIN_KEY_FILE)} (панель, /_config, веб-аккаунты)
  Data Directory:      ${DATA_DIR}
  Upstream Gateway:    ${config.upstreamHost}
  Web Dashboard:       http://${bannerHost}:${eff.port}/
`);

  if (created) console.log('  Created config.json and apikey.txt (API key generated).\n');
  const runtime = start(config);

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`
  ${signal}: останавливаюсь, дожидаюсь текущих запросов…`);
    try { runtime.guard.flush(); } catch {}
    try { runtime.webBridge.closeAllSockets?.(); } catch {}
    const hard = setTimeout(() => {
      console.log('  Активные соединения не закрылись за 8 c — завершаю принудительно.');
      try { runtime.guard.flush(); } catch {}
      try { runtime.server.closeAllConnections(); } catch {}
      process.exit(0);
    }, 8000);
    if (hard.unref) hard.unref();
    runtime.server.close(() => {
      clearTimeout(hard);
      try { runtime.guard.flush(); } catch {}
      process.exit(0);
    });
    // новые соединения больше не принимаются, но keep-alive висящие сокеты
    // нужно закрыть сами — иначе close() не дождётся.
    setTimeout(() => { try { runtime.server.closeIdleConnections(); } catch {} }, 500).unref?.();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (require.main === module) main();
module.exports = { start, loadConfig, resolveCloudCodeUserAgent };

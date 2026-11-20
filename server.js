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

const { TokenManager } = require('./lib/auth');
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

const ROOT = __dirname;
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
function ensureAdminKey(root, config) {
  const file = path.join(root, ADMIN_KEY_FILE);
  const kept = readKeyFile(file);
  if (!config.adminKey) config.adminKey = kept.length >= 16 ? kept : newAdminKey();
  if (kept !== config.adminKey) {
    backupFile(file);
    writeFileAtomic(file, config.adminKey + '\n');
  }
  return config;
}

function persistConfig(file, config) {
  backupFile(file);
  writeFileAtomic(file, JSON.stringify(config, null, 2));
}

// config.json — источник истины для ключа; apikey.txt — его копия для людей и панели.
function loadConfig(root = ROOT) {
  const file = path.join(root, 'config.json');
  const keyFile = path.join(root, 'apikey.txt');
  if (!fs.existsSync(file)) {
    // apikey.txt пережил удаление config.json — оставляем ключ, чтобы клиенты не сломались.
    const kept = readKeyFile(keyFile);
    const { config } = configLib.normalize({ apiKey: kept.length >= 16 ? kept : newApiKey() });
    ensureAdminKey(root, config);
    writeFileAtomic(file, JSON.stringify(config, null, 2));
    if (kept !== config.apiKey) {
      backupFile(keyFile);
      writeFileAtomic(keyFile, config.apiKey + '\n');
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
    backupFile(keyFile);
    writeFileAtomic(keyFile, config.apiKey + '\n');
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

  // генерация с одним автоматическим retry после refresh (401/403/смена токена)
  async generateWithRetry(model, requestObj, { signal } = {}) {
    let res = await this.generateContent(model, requestObj, { signal });
    if (res.status === 401 || res.status === 403) {
      // токен мог отозваться — принудительно обновим и попробуем ещё раз
      this.tokens.accessToken = '';
      this.tokens.expiresAt = 0;
      this.refreshCount++;
      res = await this.generateContent(model, requestObj, { signal });
    }
    return res;
  }

  // Информация об аккаунте (tier/проект/регион) — кэш 5 минут, best-effort.
  async getAccountInfo() {
    if (this._accInfo && Date.now() - this._accInfoAt < 300000) return this._accInfo;
    try {
      const token = await this.tokens.getAccessToken();
      const meta = {
        metadata: {
          ideType: 'ANTIGRAVITY',
          ideName: 'antigravity',
          ideVersion: (String(this.config.userAgent || '').match(/antigravity\/([0-9.]+)/i) || [])[1] || DEFAULT_IDE_VERSION,
        },
        cloudaicompanionProject: this.tokens.projectId || '',
      };
      const [tierRes, userRes] = await Promise.all([
        this.upFetch('/v1internal:loadCodeAssist', {
          method: 'POST', headers: this.headers(token), body: JSON.stringify(meta), signal: AbortSignal.timeout(15000),
        }),
        this.upFetch('/v1internal:fetchUserInfo', {
          method: 'POST', headers: this.headers(token), body: '{}', signal: AbortSignal.timeout(15000),
        }),
      ]);
      const tier = tierRes.ok ? await tierRes.json().catch(() => null) : null;
      const user = userRes.ok ? await userRes.json().catch(() => null) : null;
      this._accInfo = {
        tier: tier?.currentTier?.name ?? null,
        tierId: tier?.currentTier?.id ?? null,
        project: tier?.cloudaicompanionProject ?? null,
        region: user?.regionCode ?? null,
        fetchedAt: new Date().toISOString(),
      };
      this._accInfoAt = Date.now();
      return this._accInfo;
    } catch (e) {
      return { error: netWhy(e), fetchedAt: new Date().toISOString() };
    }
  }

  // Реальная сводка официальных квот Google Cloud Code (retrieveUserQuotaSummary) — кэш 30 сек
  async getQuotaSummary() {
    if (this._quotaSummary && Date.now() - this._quotaSummaryAt < 30000) return this._quotaSummary;
    try {
      const token = await this.tokens.getAccessToken();
      const res = await this.upFetch('/v1internal:retrieveUserQuotaSummary', {
        method: 'POST',
        headers: this.headers(token),
        body: '{}',
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
          remainingPercent: typeof b.remainingFraction === 'number' ? Math.round(b.remainingFraction * 1000) / 10 : null,
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

function start(config) {
  config.userAgent = resolveCloudCodeUserAgent(config.userAgent);
  // dns.setServers affects dns.resolve*, not fetch()/getaddrinfo. The network
  // layer supplies a real lookup for proxied and custom-DNS transports.
  const network = new NetworkManager(config);
  // Ищем локальный relay (AGUnlocker) сразу, не дожидаясь первого cloud-запроса.
  if (network.autoDetect) network.autoDetect();
  const authFile = process.env.AG_AUTH_FILE || path.join(ROOT, 'auth.json');
  if (!fs.existsSync(authFile)) {
    console.log(`\n  ! Не найден ${authFile} — сначала: python scripts\\extract_token.py\n`);
    process.exit(1);
  }
  const tokens = new TokenManager(authFile, { network });
  const catalog = new ModelCatalog(config.upstreamHost, {
    project: tokens.projectId,
    userAgent: config.userAgent,
    fallbackHost: config.upstreamFallbackHost,
    network,
  });
  const upstream = new Upstream(config, tokens, catalog, network);
  const guard = new Guard(config.safeMode || {}, process.env.AG_USAGE_FILE || path.join(ROOT, 'usage.json'));
  const webBridge = new GeminiWebBridge({ ...(config.geminiWeb || {}), network });
  webBridge.ensureBlFresh(true).catch(() => {}); // фоновое обновление BL-версии, best-effort
  const netSummary = network.summary();
  if (netSummary.active) {
    const dnsLabel = netSummary.dnsMode === 'doh' ? `DoH ${netSummary.dohHost}`
      : netSummary.dnsMode === 'custom' ? `DNS ${netSummary.dnsServers.join(', ')}`
        : 'system DNS';
    console.log(`  Network: ${netSummary.proxy ? 'proxy ' + netSummary.proxy : 'direct'} · ${dnsLabel}`);
  }
  const log = [];
  const stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, blocked: 0 };

  const pushLog = (e) => {
    stats.requests++;
    if (e.error) stats.errors++;
    log.push({ ts: new Date().toISOString(), ...e });
    if (log.length > 200) log.shift();
    console.log(
      `  [${e.kind}] ${e.model || ''} ${e.status ?? ''} ${e.ms ?? ''}ms ${e.error ? 'ERR ' + e.error : 'OK'} ${e.quota ? '(' + e.quota + ')' : ''}`.trimEnd()
    );
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

  // Ключ клиентов моделей: только /v1*.
  function authOk(req) {
    // Authorization: Bearer <key> — основной способ (OpenAI-совместимость).
    // x-goog-api-key и ?key= — для Gemini SDK (google-generativeai и т.п.).
    return presentedKeys(req).some((k) => keyEquals(k, config.apiKey));
  }

  // Админский ключ: /_* и HTML-дашборд. В тестах/кастомных запусках adminKey
  // может отсутствовать — тогда допускаем apiKey (так работают фикстуры).
  function adminOk(req) {
    const expected = config.adminKey || config.apiKey;
    return presentedKeys(req).some((k) => keyEquals(k, expected));
  }

  // Чтение состояния: доступно обоим ключам (не даёт менять конфиг).
  function statusOk(req) {
    return adminOk(req) || authOk(req);
  }

  function unauthorized(res) {
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
    try {
      if (!statusOk(req)) {
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
      const out = await executeDiagnosticChat(body, { catalog, tokens, upstream, webBridge, guard });
      // Do not log request model/message: they are untrusted and may contain secrets.
      pushLog({ kind: 'diagnostics', status: 200, ms: Date.now() - t0 });
      return sendJson(res, 200, out);
    } catch (err) {
      const safe = normalizeDiagnosticError(err);
      pushLog({ kind: 'diagnostics', status: safe.status, ms: Date.now() - t0, error: safe.error.code });
      return sendJson(res, safe.status, { ok: false, error: safe.error });
    }
  }

  // ---- OpenAI: /v1/chat/completions ----

  // Модели жёстко неймспейснуты: cloud/<id> | web/<alias>.
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
    const direct = providers.parseModel(name);
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
        return providers.parseModel(providers.formatModel(providers.CLOUD, base, { agent }));
      }
    } catch {}
    if (webBridge.isWebModelName(base)) {
      return providers.parseModel(providers.formatModel(providers.WEB, base, { agent }));
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
    if (typeof req.workspaceRoot === 'string' && req.workspaceRoot.trim()) cfg.workspaceRoot = req.workspaceRoot.trim();
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
    return cfg;
  }

  async function handleAgentChat(res, { body, parsed, stream, t0 }) {
    const model = parsed.baseId;
    const requestedModel = parsed.displayId;
    const useWeb = parsed.namespace === providers.WEB;

    // Web-модель при выключенном мосте — та же ошибка, что и в обычном пути.
    if (useWeb && !webBridge.isWebModel(model)) {
      return sendJson(res, 400, webBridgeDisabledError());
    }

    const acfg = agentConfigFor(body);
    const executor = agent.createExecutor(acfg, ROOT);

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

    // Web-мост: каждая итерация — один веб-запрос с полным transcript'ом.
    // Такая эмуляция протокола текстом — VERY unreliable (лимит длины ответа).
    const chatWeb = async (msgs) => {
      const out = await webBridge.handleOpenAIChat(
        { model, messages: msgs, tools: agent.TOOL_SPECS }, false, null);
      const m = out.choices?.[0]?.message || {};
      return { content: m.content || '', tool_calls: m.tool_calls || [], usage: out.usage, upstream_model: out.upstream_model };
    };

    // Cloud: нативный Gemini function calling — сообщения (включая
    // assistant.tool_calls и role:"tool") транслируются в functionCall/
    // functionResponse с thought signatures. Никакой текстовой склейки.
    const chatCloud = async (msgs) => {
      const requestObj = openAIToGeminiRequest({ messages: msgs, tools: toolsForLoop });
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
        const out = geminiToOpenAIResponse({ response: merged }, model);
        const m = out.choices?.[0]?.message || {};
        return { content: m.content || '', tool_calls: m.tool_calls || [], usage: out.usage, upstream_model: out.upstream_model };
      } finally {
        res.removeListener('close', onClose);
        if (clientGone(res) && !ac.signal.aborted) ac.abort();
      }
    };

    const chat = useWeb ? chatWeb : chatCloud;

    const run = async () => {
      const result = await agent.runAgentLoop({
        chat,
        messages: body.messages || [],
        executor: loopExecutor,
        maxIterations: acfg.maxIterations,
        systemPrompt,
      });
      if (result.usage && result.usage.total_tokens) guard.reportUsage(result.usage.total_tokens);
      pushLog({ kind: 'openai', model: requestedModel, status: 200, ms: Date.now() - t0, agentActions: result.trace.length, provider: parsed.namespace });
      return result;
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
      // SSE: прогресс инструментов — события agent_event, затем контент одним дельта-чанком.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const base = {
        id: 'chatcmpl-' + crypto.randomUUID(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
      };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      for (const a of result.trace) {
        res.write(`data: ${JSON.stringify({ ...base, agent_event: { tool: a.tool, ok: a.ok }, choices: [{ index: 0, delta: {}, finish_reason: null }] })}\n\n`);
      }
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
    // "tools": "builtin" — синоним запроса серверных файловых инструментов.
    if (body.tools === 'builtin') {
      body.agent = true;
      body.tools = undefined;
    }
    validateOpenAI(body);
    let parsed = providers.parseModel(body.model.trim());
    if (!parsed.ok) {
      parsed = (await resolveFlatModel(body.model.trim())) || parsed;
    }
    if (!parsed.ok) return sendNamespaceError(res, parsed);
    const stream = !!body.stream;

    // Агентный режим — только явные триггеры: суффикс -agent у модели,
    // body.agent / body.builtin_tools. Обычный чат инструментов не получает.
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
      // Веб-агент — opt-in: только при явном agent.allowWebAgent=true.
      if (parsed.namespace === providers.WEB && !(config.agent && config.agent.allowWebAgent === true)) {
        return sendJson(res, 400, webAgentDisabledError());
      }
      return await handleAgentChat(res, { body, parsed, stream, t0 });
    }

    // web/* — чистый чат. У веб-канала нет нативного function calling,
    // поэтому tools от клиента игнорируются; агент — только web/<alias>-agent.
    if (parsed.namespace === providers.WEB) {
      if (!webBridge.isWebModel(parsed.baseId)) {
        return sendJson(res, 400, webBridgeDisabledError());
      }
      try {
        const out = await webBridge.handleOpenAIChat(
          { ...body, model: parsed.baseId, tools: undefined }, stream, res);
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
          : `Gemini Web request failed: ${detail} (проверьте VPN и свежесть куки; повторите попытку)`;
        pushLog({ kind: 'openai', status, ms: Date.now() - t0, error: regional ? code : 'web: ' + detail.slice(0, 140), provider: providers.WEB });
        sendApiError(res, status, { error: { message, type, code } }, stream);
        return;
      }
    }

    const model = parsed.baseId;
    const requestObj = openAIToGeminiRequest(body);

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
          pushLog({ kind: 'openai', model: parsed.displayId, status: upRes.status, ms: Date.now() - t0, error: text.slice(0, 160), quota, provider: providers.CLOUD });
          return upstreamErrorToClient(res, { status: upRes.status, text: async () => text });
        }

        if (!stream) {
          // агрегируем SSE-поток в один ответ
          const saw = [];
          for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
            if (!data || data === '[DONE]') continue;
            saw.push(parseUpstreamData(data));
          }
          const out = aggregateGeminiChunks(saw, parsed.displayId);
          guard.reportUsage(out.usage?.total_tokens);
          pushLog({ kind: 'openai', model: parsed.displayId, status: 200, ms: Date.now() - t0, provider: providers.CLOUD });
          sendJson(res, 200, out);
          return;
        }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const conv = new GeminiStreamToOpenAI(parsed.displayId, { includeThoughts: !!config.includeThoughts });
        try {
          for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
            if (!data || data === '[DONE]') continue;
            parseUpstreamData(data);
            for (const chunk of conv.pushData(data)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          for (const chunk of conv.finishChunks()) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch (e) {
          // Обрыв на нашей стороне — это уход клиента, а не сбой апстрима.
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
    // chunks: массив {response:{candidates:[{content:{parts},finishReason}],usageMetadata},traceId}
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
        if (p.thought) continue;
        const last = parts[parts.length - 1];
        if (typeof p.text === 'string' && last && typeof last.text === 'string') last.text += p.text;
        else parts.push(p);
      }
      if (cand.finishReason) finish = cand.finishReason;
      if (resp.usageMetadata) usage = resp.usageMetadata;
      if (resp.promptFeedback) promptFeedback = resp.promptFeedback;
    }
    // Заблокированный запрос приходит без кандидатов — сохраняем это для finish_reason.
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
    return geminiToOpenAIResponse(resp, model);
  }

  // ---- Gemini-нативный API ----

  async function handleGeminiGenerate(req, res, rawModel, method) {
    const t0 = Date.now();
    const read = await readBodyOrRespond(req, res);
    if (!read.ok) return;
    const body = parseRequestBody(read.raw);
    const requestObj = body.request ?? body; // можно прислать и обёрнутый, и чистый GenerateContentRequest
    validateGemini(requestObj);

    let parsedModel = providers.parseModel(rawModel);
    if (!parsedModel.ok) {
      parsedModel = (await resolveFlatModel(rawModel)) || parsedModel;
    }
    if (!parsedModel.ok) return sendNamespaceError(res, parsedModel);
    const model = parsedModel.baseId;
    const displayModel = parsedModel.displayId;
    const isWeb = parsedModel.namespace === providers.WEB;

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
      try {
        const prompt = webBridge.contentsToPrompt(requestObj);
        const meta = webBridge.getModelMeta(model);
        const lang = webBridge.detectContentsLang(requestObj);

        if (stream) {
          const reqBody = webBridge.buildPayload(prompt, meta.modelId, meta.thinkMode, lang);
          const upRes = await webBridge.sendStreamRequestResilient(reqBody, meta, lang);
          const iterator = webBridge.streamResponse(upRes)[Symbol.asyncIterator]();
          const first = await iterator.next();
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          if (!first.done) {
            const firstChunk = { candidates: [{ content: { parts: [{ text: first.value }], role: 'model' }, finishReason: null, index: 0 }] };
            res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
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
          pushLog({ kind: 'gemini', model: displayModel, status: 200, ms: Date.now() - t0, stream: true, provider: providers.WEB });
          return;
        }

        const text = await webBridge.generate(prompt, meta.modelId, meta.thinkMode, lang);
        const out = {
          candidates: [{
            content: { parts: [{ text }], role: 'model' },
            finishReason: 'STOP',
            index: 0,
          }],
          usageMetadata: {
            promptTokenCount: Math.max(1, Math.round(prompt.length / 4)),
            candidatesTokenCount: Math.max(1, Math.round(text.length / 4)),
            totalTokenCount: Math.max(2, Math.round((prompt.length + text.length) / 4)),
          },
          modelVersion: displayModel,
        };
        pushLog({ kind: 'gemini', model: displayModel, status: 200, ms: Date.now() - t0, provider: providers.WEB });
        return sendJson(res, 200, out);
      } catch (err) {
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
        const regional = err.code === 'region_not_supported';
        const detail = redactSecrets(String(err && err.message || 'unknown error')).replace(/\s+/g, ' ').slice(0, 220);
        const message = regional ? normalizeDiagnosticError(err, { bridge: 'web' }).error.message
          : `Gemini Web request failed: ${detail} (проверьте VPN и свежесть куки; повторите попытку)`;
        pushLog({ kind: 'gemini', status, ms: Date.now() - t0, error: regional ? 'region_not_supported' : 'web: ' + detail.slice(0, 140), provider: providers.WEB });
        return sendApiError(res, status, { error: {
          message,
          type: regional ? 'invalid_request_error' : 'api_error',
          code: regional ? 'region_not_supported' : status,
        } });
      }
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
          pushLog({ kind: 'gemini', model: displayModel, status: upRes.status, ms: Date.now() - t0, error: text.slice(0, 160), quota: extractQuotaInfo(text), provider: providers.CLOUD });
          return upstreamErrorToClient(res, { status: upRes.status, text: async () => text });
        }

        if (!stream) {
          const seen = [];
          for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
            if (data && data !== '[DONE]') {
              seen.push(parseUpstreamData(data));
            }
          }
          const mergedResp = mergeGeminiResponse(seen);
          guard.reportUsage(mergedResp.usageMetadata?.totalTokenCount);
          pushLog({ kind: 'gemini', model: displayModel, status: 200, ms: Date.now() - t0, provider: providers.CLOUD });
          return sendJson(res, 200, mergedResp);
        }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        let lastUsage = null;
        for await (const data of sseData(bodyWhileConnected(res, upRes.body))) {
          if (!data || data === '[DONE]') continue;
          const j = parseUpstreamData(data);
          // разворачиваем обёртку {"response": ...} -> чистый Gemini-формат
          const inner = j.response ?? j;
          if (inner.usageMetadata) lastUsage = inner.usageMetadata;
          res.write(`data: ${JSON.stringify(inner)}\n\n`);
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

  async function buildOpenAIModels() {
    let data = [];
    try {
      const models = await catalog.list(() => tokens.getAccessToken());
      data = [...models.entries()].map(([id, m]) => ({
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
      }));
    } catch (e) {
      // каталог аккаунта недоступен — всё равно отдаём web-модели
      console.error('  [models] upstream каталог недоступен:', e.message);
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
    try {
      const upstreamModels = await catalog.list(() => tokens.getAccessToken());
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

  // ---- статус-страница ----

  function statusPage() {
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const statusBadge = (st) => {
      const n = Number(st);
      if (Number.isFinite(n)) {
        const cls = n < 400 ? 'ok' : (n < 500 ? 'warn' : 'bad');
        return `<span class="badge ${cls}">${n}</span>`;
      }
      return esc(st);
    };
    const providerOf = (r) => {
      if (r.provider) return r.provider;
      const m = String(r.model || '');
      if (m.startsWith('web/')) return 'web';
      if (m.startsWith('cloud/')) return 'cloud';
      return '—';
    };
    const providerBadge = (p) => (p === 'web'
      ? '<span class="badge warn">web</span>'
      : p === 'cloud' ? '<span class="badge ok">cloud</span>' : '<span class="badge off">—</span>');
    const rows = log.slice().reverse().slice(0, 40).map((r) =>
      `<tr><td class="mono">${esc(r.ts?.slice(11, 19))}</td><td>${providerBadge(providerOf(r))}</td><td>${esc(r.kind)}</td>` +
      `<td class="mono">${esc(r.model || '')}</td><td>${statusBadge(r.status)}</td>` +
      `<td class="mono">${esc(r.ms ?? '')}ms</td><td>${esc(r.quota || '')}</td><td class="err">${esc(r.error || '')}</td></tr>`
    ).join('');
    let modelCount = 0;
    try { modelCount = catalog.cache ? catalog.cache.models.size : 0; } catch {}
    let webModelCount = 0;
    try { webModelCount = webBridge.getModelsList().length; } catch {}

    // Cloud Code (Antigravity): OAuth, квоты в процентах, нативные tools.
    const cloudKvs =
      `<div class="kv"><span class="k">Transport</span><span><span class="badge ok">OAuth · Cloud Code v1internal</span></span></div>` +
      `<div class="kv"><span class="k">Models</span><span><b>${modelCount}</b> · namespace <code>cloud/&lt;id&gt;</code></span></div>` +
      `<div class="kv"><span class="k">Tool calling</span><span><span class="badge ok">native (functionDeclarations + thought signatures)</span></span></div>` +
      `<div class="kv"><span class="k">Quota</span><span>per-account percentages · see <code>/_limits</code></span></div>` +
      `<div class="kv"><span class="k">Token refreshes</span><span>${upstream.refreshCount}</span></div>`;

    let webKvs = '';
    try {
      const ws = webBridge.summary ? webBridge.summary() : null;
      if (ws) {
        const enCls = ws.enabled ? 'ok' : 'off';
        const ckCls = ws.cookieSet ? 'ok' : 'warn';
        const allowWebAgent = !!(config.agent && config.agent.allowWebAgent === true);
        webKvs =
          `<div class="kv"><span class="k">Status</span><span><span class="badge ${enCls}">${ws.enabled ? 'Enabled' : 'Disabled'}</span></span></div>` +
          `<div class="kv"><span class="k">Cookie</span><span><span class="badge ${ckCls}">${ws.cookieSet ? 'set' : 'none (anonymous)'}</span></span></div>` +
          `<div class="kv"><span class="k">BL version</span><span><code>${esc(ws.bl)}</code></span></div>` +
          (ws.proxy ? `<div class="kv"><span class="k">Proxy</span><span><code>${esc(ws.proxy)}</code></span></div>` : '') +
          (ws.authUser !== null && ws.authUser !== undefined ? `<div class="kv"><span class="k">Google /u/</span><span><code>${esc(ws.authUser)}</code></span></div>` : '') +
          (ws.temporaryChats ? `<div class="kv"><span class="k">Mode</span><span>temporary chats</span></div>` : '') +
          `<div class="kv"><span class="k">Models</span><span><b>${webModelCount}</b> · namespace <code>web/&lt;alias&gt;</code></span></div>` +
          `<div class="kv"><span class="k">Model resolution</span><span><span class="badge warn">heuristic · exact aliases only</span></span></div>` +
          `<div class="kv"><span class="k">Tool calling</span><span><span class="badge warn">none · text-protocol emulation</span></span></div>` +
          `<div class="kv"><span class="k">Agent mode</span><span><span class="badge ${allowWebAgent ? 'warn' : 'off'}">${allowWebAgent ? 'web/&lt;alias&gt;-agent · VERY unreliable' : 'disabled (opt-in via allowWebAgent)'}</span></span></div>` +
          `<div class="kv"><span class="k">Web models</span><span>${ws.models.map((m) => '<code>web/' + esc(m) + '</code>').join(' ') || '—'}</span></div>`;
      }
    } catch {}

    const ns = network.summary();
    const netKvs =
      `<div class="kv"><span class="k">Status</span><span><span class="badge ${ns.active ? 'ok' : 'off'}">${ns.active ? 'Proxy / custom DNS' : 'Direct (system DNS)'}</span></span></div>` +
      `<div class="kv"><span class="k">Proxy</span><span>${ns.proxy ? '<code>' + esc(ns.proxy) + '</code>' : '—'}</span></div>` +
      (ns.webProxy ? `<div class="kv"><span class="k">Web bridge proxy</span><span><code>${esc(ns.webProxy)}</code></span></div>` : '') +
      (ns.envProxy ? `<div class="kv"><span class="k">Env proxy</span><span><code>${esc(ns.envProxy)}</code></span></div>` : '') +
      `<div class="kv"><span class="k">DNS</span><span>${ns.dnsMode === 'doh' ? 'DoH · <code>' + esc(ns.dohHost) + '</code>' : ns.dnsMode === 'custom' ? 'custom · <code>' + esc((ns.dnsServers || []).join(', ')) + '</code>' : 'system'}</span></div>`;

    const g = guard.summary();
    const guardKvs =      `<div class="kv"><span class="k">Status</span><span><span class="badge ${guard.cfg.enabled ? 'warn' : 'off'}">${guard.cfg.enabled ? 'Enabled' : 'Disabled (direct upstream mode)'}</span></span></div>` +
      `<div class="kv"><span class="k">Requests today</span><span><b>${g.requestsToday}</b>${guard.cfg.enabled ? ' / ' + g.limits.perDay : ''}</span></div>` +
      `<div class="kv"><span class="k">Tokens today</span><span><b>${g.tokensToday}</b>${guard.cfg.enabled ? ' / ' + g.limits.tokensPerDay : ''}</span></div>` +
      `<div class="kv"><span class="k">Cooldown</span><span><code>${esc(JSON.stringify(g.cooldowns))}</code></span></div>`;

    // Агентные файловые инструменты (lib/agent.js) + гибридный planner.
    const agentEnabled = !(config.agent && config.agent.enabled === false);
    const agentWs = agent.resolveWorkspace(config.agent, ROOT);
    const plannerCfg = { ...planner.DEFAULT_SETTINGS, ...((config.agent && config.agent.planner) || {}) };
    const allowWebAgent = !!(config.agent && config.agent.allowWebAgent === true);
    const recentAgent = log.filter((r) => r.agentActions != null).slice(-5).reverse();
    const agentKvs =
      `<div class="kv"><span class="k">Status</span><span><span class="badge ${agentEnabled ? 'ok' : 'off'}">${agentEnabled ? 'Enabled' : 'Disabled'}</span></span></div>` +
      `<div class="kv"><span class="k">Workspace</span><span><code>${esc(agentWs)}</code></span></div>` +
      `<div class="kv"><span class="k">Tools</span><span>${agent.TOOL_NAMES.map((t) => '<code>' + esc(t) + '</code>').join(' ')}</span></div>` +
      `<div class="kv"><span class="k">Max iterations</span><span>${(config.agent && config.agent.maxIterations) || agent.DEFAULTS.maxIterations}</span></div>` +
      `<div class="kv"><span class="k">Web agent</span><span><span class="badge ${allowWebAgent ? 'warn' : 'off'}">${allowWebAgent ? 'enabled · VERY unreliable' : 'disabled (opt-in)'}</span></span></div>` +
      `<div class="kv"><span class="k">Planner</span><span><span class="badge ${plannerCfg.enabled ? 'ok' : 'off'}">${plannerCfg.enabled ? 'enabled' : 'disabled'}</span> <code>${esc(plannerCfg.model)}</code> · maxCalls ${esc(plannerCfg.maxCalls)} · timeout ${esc(plannerCfg.timeoutMs)}ms</span></div>` +
      `<div class="kv"><span class="k">delete_path</span><span><span class="badge ${config.agent && config.agent.allowDelete ? 'warn' : 'off'}">${config.agent && config.agent.allowDelete ? 'allowed' : 'disabled'}</span></span></div>` +
      `<div class="kv"><span class="k">run_command</span><span><span class="badge ${config.agent && config.agent.allowShell ? 'warn' : 'off'}">${config.agent && config.agent.allowShell ? 'allowed' : 'disabled'}</span></span></div>` +
      `<div class="kv"><span class="k">Absolute paths</span><span><span class="badge ${config.agent && config.agent.allowAbsolutePaths ? 'warn' : 'off'}">${config.agent && config.agent.allowAbsolutePaths ? 'allowed (system dirs blocked)' : 'disabled (sandbox only)'}</span></span></div>` +
      (recentAgent.length
        ? `<div class="kv"><span class="k">Last agent runs</span><span>${recentAgent.map((r) => `<code>${esc(r.model || '')}</code> ${esc(r.agentActions)} actions`).join(' · ')}</span></div>`
        : '');

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Antigravity API Dashboard</title><meta http-equiv="refresh" content="5">
<style>
:root{--bg:#0b0c10;--panel:#141622;--sub:#1b1e2e;--border:#23273c;--txt:#f8fafc;--mut:#94a3b8;--dim:#64748b;--cy:#38bdf8;--ok:#10b981;--warn:#f59e0b;--bad:#ef4444}
*{box-sizing:border-box}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--txt);margin:0;padding:28px}
.wrap{max-width:1080px;margin:0 auto}
.header{display:flex;align-items:center;gap:12px}
.dot{width:11px;height:11px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok)}
h1{font-size:22px;margin:0}h1 .api{color:var(--cy)}
.sub{color:var(--dim);font-size:13px;margin:6px 0 18px}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.pill{background:var(--sub);border:1px solid var(--border);border-radius:20px;padding:5px 13px;font-size:12px;color:var(--mut)}
.pill b{color:var(--txt)}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;margin-bottom:18px;overflow:hidden}
.card h2{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--mut);margin:0;padding:14px 20px;border-bottom:1px solid var(--border)}
.card .body{padding:8px 20px 14px}
.kv{display:grid;grid-template-columns:190px 1fr;gap:8px;font-size:13px;padding:7px 0;border-bottom:1px dashed #1e2233}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--mut)}
.badge{display:inline-block;padding:2px 11px;border-radius:12px;font-size:12px;font-weight:600}
.badge.ok{background:#064e3b;color:#6ee7b7}.badge.off{background:#23273c;color:var(--mut)}
.badge.warn{background:#451a03;color:#fbbf24}.badge.bad{background:#450a0a;color:#fca5a5}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{padding:8px 10px;text-align:left;border-bottom:1px solid #1e2233;vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:none}
.mono{font-family:Consolas,monospace;font-size:12px}
.err{color:var(--bad);font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis}
code{color:var(--cy);background:#0f1220;padding:1px 7px;border-radius:5px;font-size:12px;margin-right:4px}
.empty{color:var(--dim);font-size:13px;padding:10px 0}
.footer{color:var(--dim);font-size:12px;margin-top:4px}
</style></head><body><div class="wrap">
<div class="header"><span class="dot"></span><h1>ANTIGRAVITY <span class="api">API</span></h1></div>
<p class="sub">Локальный OpenAI-совместимый шлюз · модели неймспейснуты: <code>cloud/&lt;id&gt;</code> и <code>web/&lt;alias&gt;</code> · автообновление каждые 5 с</p>
<div class="pills">
<span class="pill">Started <b>${esc(stats.startedAt)}</b></span>
<span class="pill">Requests <b>${stats.requests}</b></span>
<span class="pill">Errors <b>${stats.errors}</b></span>
<span class="pill">Guard blocks <b>${stats.blocked}</b></span>
<span class="pill">Cloud models <b>${modelCount}</b></span>
<span class="pill">Web models <b>${webModelCount}</b></span>
<span class="pill">Token refreshes <b>${upstream.refreshCount}</b></span>
</div>
<div class="card"><h2>☁️ Cloud Code (Antigravity)</h2><div class="body">${cloudKvs}</div></div>
<div class="card"><h2>🌐 Gemini Web (Browser Bridge) · VERY unreliable for agents</h2><div class="body">${webKvs}</div></div>
<div class="card"><h2>🤖 Agent &amp; Planner</h2><div class="body">${agentKvs}</div></div>
<div class="card"><h2>🛰 Network Transport</h2><div class="body">${netKvs}</div></div>
<div class="card"><h2>🛡 Guard Status (Optional)</h2><div class="body">${guardKvs}</div></div>
<div class="card"><h2>Recent Requests (last 40)</h2><div class="body">${
  rows ? `<table><tr><th>Time</th><th>Provider</th><th>Kind</th><th>Model</th><th>Status</th><th>Latency</th><th>Quota</th><th>Error</th></tr>${rows}</table>`
       : `<div class="empty">No requests yet.</div>`
}</div></div>
<p class="footer">Base URL: <code>http://127.0.0.1:${config.port}/v1</code> · Key file: <code>apikey.txt</code></p>
</div></body></html>`;
  }

  // ---- маршрутизация ----

  async function handler(req, res) {
    let p = req.url;
    try {
      let u;
      try { u = new URL(req.url, 'http://localhost'); } catch {
        throw requestError('Invalid request URL');
      }
      p = u.pathname;
      if (p === '/_health') return sendJson(res, 200, { ok: true, uptime: process.uptime() });
      if (p === '/api/diagnostics/chat') return await handleDiagnosticChat(req, res);

      if (!statusOk(req)) return unauthorized(res);

      if (p === '/' || p === '/_status') {
        // Дашборд — административная поверхность: клиентский API-ключ
        // (он лежит у Cursor/Cline/любого скрипта) в панель не пускаем.
        if (p === '/' && !adminOk(req)) {
          return forbidden(res, 'admin_key_required', 'HTML-дашборд доступен только с админским ключом (admin.key). Клиентский API-ключ не даёт доступа к панели.');
        }
        const s = {
          startedAt: stats.startedAt,
          requests: stats.requests,
          errors: stats.errors,
          tokens: tokens.summary(),
          network: network.summary(),
          agent: {
            enabled: !(config.agent && config.agent.enabled === false),
            workspace: agent.resolveWorkspace(config.agent, ROOT),
            tools: agent.TOOL_NAMES,
            allowDelete: !!(config.agent && config.agent.allowDelete),
            allowShell: !!(config.agent && config.agent.allowShell),
            allowWebAgent: !!(config.agent && config.agent.allowWebAgent === true),
            maxIterations: (config.agent && config.agent.maxIterations) || agent.DEFAULTS.maxIterations,
            planner: { ...planner.DEFAULT_SETTINGS, ...((config.agent && config.agent.planner) || {}) },
          },
        };
        if (p === '/_status') return sendJson(res, 200, s);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(statusPage());
      }

      if (p === '/_limits' || p === '/_quota') {
        // Независимые запросы — параллельно: иначе холодный вызов ждёт Google
        // последовательно (15с+15с), а GUI сдаётся раньше. Кэш: квоты 30с, аккаунт 300с.
        const quotaP = upstream.getQuotaSummary();
        if (p === '/_quota') return sendJson(res, 200, await quotaP);

        let modelsError = null;
        const [serverQuotas, account] = await Promise.all([
          quotaP,
          upstream.getAccountInfo(),
          (async () => {
            try {
              await catalog.list(() => tokens.getAccessToken()); // прогрев кэша моделей
            } catch (e) {
              modelsError = e.message; // показываем в GUI, а не глотаем
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

      if (req.method === 'POST' && p === '/_config') {
        if (!adminOk(req)) {
          return forbidden(res, 'admin_key_required', 'Изменение настроек доступно только с админским ключом (admin.key). Клиентский API-ключ даёт доступ только к /v1*.');
        }
        const readCfg = await readBodyOrRespond(req, res);
        if (!readCfg.ok) return;
        let parsed;
        try {
          parsed = parseRequestBody(readCfg.raw);
        } catch {
          return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
        }

        // Белый список полей: опасные флаги агента (allowDelete/allowShell/
        // allowAbsolutePaths/auditFile) и секреты не принимаются из HTTP никогда.
        const patch = configLib.patchConfig(config, parsed);
        Object.assign(config, patch.config);

        // Применяем к живым объектам. Исполнитель агента создаётся на каждый
        // запрос, поэтому его настройки подхватываются сами.
        guard.updateConfig(config.safeMode);
        webBridge.updateConfig(config.geminiWeb);
        network.updateConfig(config);

        if (config.persistConfig !== false && patch.applied.length) {
          // В файл пишем нормализованный конфиг целиком: миграции и дефолты не
          // теряются, неизвестные ключи сохраняются (deepMerge в lib/config).
          // apiKey/adminKey живут в этом же объекте, поэтому не пропадают.
          try {
            const cfgPath = path.join(ROOT, 'config.json');
            backupFile(cfgPath);
            writeFileAtomic(cfgPath, JSON.stringify(config, null, 2));
          } catch (e) {
            console.error('Failed to save config.json:', e);
            return sendJson(res, 500, { error: { message: `Не удалось записать config.json: ${e.message}`, type: 'internal_error' } });
          }
        }

        const reply = {
          ok: true,
          applied: patch.applied,
          ignored: patch.ignored,
          warnings: patch.warnings,
          restartRequired: patch.ignored.filter((k) => /allowDelete|allowShell|allowAbsolutePaths|auditFile/.test(k)),
          safeMode: guard.cfg,
          network: network.summary(),
        };
        if (webBridge.summary) reply.geminiWeb = webBridge.summary();
        return sendJson(res, 200, reply);
      }

      if (req.method === 'GET' && p === '/_network/test') {
        const timeout = Math.max(2000, Math.min(15000, Number(u.searchParams.get('timeout')) || 5000));
        return sendJson(res, 200, await network.test(timeout));
      }

      if (req.method === 'GET' && p === '/v1/models') return await listModelsOpenAI(res);
      if (req.method === 'GET' && /^\/(v1beta|v1)\/models\/?$/.test(p)) return await listModelsGemini(res);

      const getOne = p.match(/^\/(v1beta|v1)\/models\/(.+)$/);
      if (req.method === 'GET' && getOne) return await getModel(res, getOne[1], getOne[2]);

      // Имя модели неймспейснуто: cloud/<id> | web/<alias>. Разделитель может
      // прийти как %2F (клиенты кодируют слэш) — decodeURIComponent ниже.
      const gm = p.match(/^\/(v1beta|v1)\/models\/(.+?)(?::(generateContent|streamGenerateContent|countTokens))?$/);
      if (req.method === 'POST' && gm) {
        const model = decodeURIComponent(gm[2]);
        const method = gm[3] ?? 'generateContent';
        return await handleGeminiGenerate(req, res, model, method);
      }

      if (req.method === 'POST' && p === '/v1/chat/completions') return await handleOpenAIChat(req, res);

      sendJson(res, 404, { error: { message: `Нет пути ${p}. Доступно: /v1/chat/completions, /v1/models, /v1/models/{id}, /v1beta/models, /v1beta/models/{m}:generateContent|streamGenerateContent|countTokens` } });
    } catch (e) {
      if (e && e.code === 'client_disconnected') {
        pushLog({ kind: 'http', status: 499, error: 'client disconnected' });
        return;
      }
      stats.errors++;
      const status = e.status >= 400 && e.status <= 599 ? e.status : 500;
      // Client-side 4xx are routine (bad model, empty messages); keep stacks for server faults only.
      if (status >= 500) console.error('  [request error]', req.method, p, e);
      else console.error('  [request error]', req.method, p, e.message || e);
      sendApiError(res, status, { error: {
        message: e.message || 'Internal server error',
        type: status < 500 ? 'invalid_request_error' : 'api_error',
        code: status,
      } }, p === '/v1/chat/completions');
    }
  }

  const server = http.createServer(handler);
  server.on('error', (e) => {
    console.error(`  ! Порт ${config.port}: ${e.message}`);
    if (e.code === 'EADDRINUSE') console.error('    Уже занят. Поменяй "port" в config.json.');
  });
  server.listen(config.port, config.host);

  return { server, tokens, catalog, upstream, config, network };
}

// ---------------------------------------------------------------- CLI

function main() {
  const cmd = process.argv[2];
  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    console.error(`\n  ! ${e.message}\n`);
    process.exit(1);
  }
  const { config, created } = loaded;
  config.userAgent = resolveCloudCodeUserAgent(config.userAgent);

  if (cmd === 'key') {
    console.log(config.apiKey);
    return;
  }

  if (cmd === 'models') {
    const authFile = path.join(ROOT, 'auth.json');
    const network = new NetworkManager(config);
    const tokens = new TokenManager(authFile, { network });
    const catalog = new ModelCatalog(config.upstreamHost, {
      project: tokens.projectId,
      userAgent: config.userAgent,
      fallbackHost: config.upstreamFallbackHost,
      network,
    });
    catalog
      .list(() => tokens.getAccessToken())
      .then((models) => {
        for (const [id, m] of models) console.log(`  ${id.padEnd(32)} ${m.displayName}`);
      })
      .catch((e) => {
        console.error(e.message);
        process.exit(1);
      });
    return;
  }

  if (cmd && cmd !== 'start') {
    console.log('Commands: start (default) | key (show API key) | models (list models)');
    return;
  }

  console.log(`
  ANTIGRAVITY API — OpenAI & Gemini Compatible Gateway
  ────────────────────────────────────────────────────────────────────────
  Base URL (OpenAI):   http://127.0.0.1:${config.port}/v1
  Base URL (Gemini):   http://127.0.0.1:${config.port}/v1beta
  API Key File:        apikey.txt (Key: ${config.apiKey.slice(0, 10)}...)
  Upstream Gateway:    ${config.upstreamHost}
  Web Dashboard:       http://127.0.0.1:${config.port}/
`);

  if (created) console.log('  Created config.json and apikey.txt (API key generated).\n');
  start(config);

  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();
module.exports = { start, loadConfig, resolveCloudCodeUserAgent };

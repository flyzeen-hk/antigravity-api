'use strict';

/**
 * Gemini 4 Web Bridge
 *
 * Предоставляет доступ к Gemini 4 Argon (gemini-4-argon, gemini-4, gemini-4-pro,
 * gemini-4-thinking и др.) через веб-шлюз Google Gemini (gemini.google.com StreamGenerate RPC)
 * — тот же бэкенд, что использует сайт gemini.google.com.
 *
 * Выбор модели идёт через header x-goog-ext-525001261-jspb (КРИТИЧНО: без него
 * сервер игнорирует inner[79] и всё падает в 3.5 Flash-Lite — это и было причиной
 * "тупых и быстрых" ответов). Формат header:
 * [1,null,null,null,"<hex>",null,null,0,[4,5,6,8],null,null,1,null,null,<mode>,<think>,"<uuid>"]
 * Для Argon: hex=95a4c0abcba24364, mode=8 (реверс zexadev/gemini-web2api-go;
 * mode решает, hex игнорируется). inner[80]: 1=обычный, 2=расширенное мышление.
 * Реальное имя модели извлекается из ответа сервера (фрейм [42]) — тихий даунгрейд виден.
 * Для аккаунтов Google AI Pro / Ultra с доступом к Gemini 4 в веб-версии запросы
 * с mode=8 обслуживает Gemini 4 Argon. Бесплатные аккаунты Google даунгрейдит до Flash-Lite.
 *
 * ВНИМАНИЕ (честно): это эвристическая, а не криптографическая верификация.
 * Google не отдаёт per-response аттестованный идентификатор модели в этом
 * протоколе; привязка mode=8 → Argon основана на исследовании веб-клиента и
 * может сломаться при обновлении Google. Куки нужны для Pro-возможностей.
 *
 * - Без авторизации работает для базовых режимов.
 * - При передаче Google-cookie открывает полную мощность (нужен платный аккаунт).
 * - Поддерживает SSE-стриминг (OpenAI совместимый), агрегированные ответы, tool calling и прокси.
 * - BL-версия (boq_...) подтягивается автоматически: при 405/400 и раз в 6 часов.
 * - Поддержка мультиаккаунта (authUser -> /u/N + X-Goog-AuthUser), XSRF at-токена,
 *   временных чатов (temporaryChats, чтобы не засорять историю Gemini) и прокси.
 * - Полностью на чистом Node.js (без внешних зависимостей).
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sseLines } = require('./http_helpers');
const { redactProxy } = require('./net');

const DEFAULT_BL = 'boq_assistant-bard-web-server_20260716.08_p0';
const GOOGLE_HOST = 'gemini.google.com';
// __Secure-1PSIDTS — короткоживущий тикет (~30 мин). Без RotateCookies
// Google считает сессию анонимной и отвечает 401.
const ROTATE_URL = 'https://accounts.google.com/RotateCookies';
const ROTATE_BODY = '[000,"-0000000000000000000"]';
const ROTATE_COOKIE_NAMES = ['__Secure-1PSID', '__Secure-1PSIDTS'];
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// StreamGenerate принимает backend-сборку BardChatUi. Строка
// boq_gemini-web-uiserver_* — это frontend, с ней RPC отвечает ошибкой.
const BL_PATTERN = /boq_assistant-bard-web-server_\d+\.\d+_p\d+/i;

// Match only the known upstream refusal; never echo its body (it may contain secrets).
function regionRejection(text, depth = 0) {
  if (typeof text === 'string') {
    if (/User location is not supported for the API use/i.test(text)) return true;
    if (depth >= 8) return false;
    try { return regionRejection(JSON.parse(text), depth + 1); } catch { return false; }
  }
  if (!text || typeof text !== 'object' || depth >= 8) return false;
  return Object.values(text).some(value => regionRejection(value, depth + 1));
}

function regionError() {
  // Google (BardErrorInfo 1060 LOCATION_REJECTED) отклоняет выходной IP, а не куки:
  // типично для помеченных датацентр-пулов коммерческих прокси/VPN. Смена куки не
  // помогает — нужен другой сервер подключения из поддерживаемого Google региона.
  const err = new Error('Gemini Web: Google отклонил выходной IP текущего подключения (LOCATION_REJECTED 1060) — регион не поддерживается. Куки ни при чём; выберите другой сервер прокси из поддерживаемого региона.');
  err.status = 400;
  err.type = 'invalid_request_error';
  err.code = 'region_not_supported';
  return err;
}

// каталог приложения (один уровень выше lib/)
const ROOT_DIR = path.resolve(__dirname, '..');

// Первый непустой источник куки: сырой заголовок важнее файла, но пустая
// строка cookie не должна «затенять» заполненный cookie_file (GUI пишет
// cookie:"" при сохранении пути к файлу).
function pickCookieSource(...sources) {
  for (const src of sources) {
    if (typeof src === 'string' && src.trim()) return src.trim();
  }
  return '';
}

function cookieHeaderFromNetscape(text) {
  const parts = [];
  for (let line of String(text).split(/\r?\n/)) {
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7 || !f[5] || !/google/i.test(f[0])) continue;
    parts.push(`${f[5]}=${f[6]}`);
  }
  return parts.join('; ');
}

function cookieHeaderFromJson(value) {
  if (Array.isArray(value)) {
    // Экспорт Cookie-Editor / EditThisCookie: [{name, value, domain, ...}]
    return value
      .filter(c => c && typeof c.name === 'string' && typeof c.value === 'string' && c.name)
      .filter(c => !c.domain || /google/i.test(String(c.domain)))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  }
  if (value && typeof value === 'object') {
    for (const key of ['cookie', 'Cookie', 'COOKIE']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
    if (typeof value.name === 'string' && typeof value.value === 'string' && value.name) {
      return `${value.name}=${value.value}`;
    }
  }
  return '';
}

// Выбор модели в веб-протоколе BardChatUi (реверс zexadev/gemini-web2api-go):
//   Сервер признаёт ТОЛЬКО header x-goog-ext-525001261-jspb — без него inner[79]
//   игнорируется и всё падает в 3.5 Flash-Lite. Формат header:
//   [1,null,null,null,"<hex>",null,null,0,[4,5,6,8],null,null,1,null,null,<mode>,<think>,"<uuid>"]
//   Для Argon: hex=95a4c0abcba24364, mode=8 (mode решает, hex игнорируется).
//   inner[80]: 1=обычный, 2=расширенное мышление (только с куками).
//   inner-массив: 97 слотов (браузер шлёт 97-98).
const WEB_MODELS = {
  'gemini-4-argon': {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    modelId: 8,      // ARGON
    hexId: '95a4c0abcba24364',
    thinkMode: 4,    // DEFAULT
    description: 'Gemini 4 Argon via Gemini Web (стандартное мышление; needs paid/Pro+ Google cookie)',
    owned_by: 'google-web',
  },
  'gemini-4-argon-thinking': {
    id: 'gemini-4-argon-thinking',
    name: 'Gemini 4 Argon — максимальное мышление',
    modelId: 8,      // ARGON
    hexId: '95a4c0abcba24364',
    thinkMode: 0,    // EXTENDED (deepest) — максимум рассуждений
    description: 'Gemini 4 Argon, максимальное мышление (thinkMode 0 = EXTENDED). Для сложных задач.',
    owned_by: 'google-web',
  },
  'gemini-4': {
    id: 'gemini-4',
    name: 'Gemini 4 (Web)',
    modelId: 8,      // ARGON
    hexId: '95a4c0abcba24364',
    thinkMode: 4,
    description: 'Alias → gemini-4-argon (Gemini 4 via Gemini Web)',
    owned_by: 'google-web',
  },
  'gemini-4-pro': {
    id: 'gemini-4-pro',
    name: 'Gemini 4 Pro (Advanced)',
    modelId: 8,      // ARGON
    hexId: '95a4c0abcba24364',
    thinkMode: 4,
    description: 'Gemini 4 Argon, full capability via Gemini Web (requires Google cookie from paid account)',
    owned_by: 'google-web',
  },
  'gemini-4-flash': {
    id: 'gemini-4-flash',
    name: 'Gemini 4 (Web)',
    modelId: 8,      // ARGON
    hexId: '95a4c0abcba24364', // отдельной "4 Flash" не существует — ведёт на Argon
    thinkMode: 4,
    description: 'Routes to Gemini 4 Argon via Gemini Web (no separate 4 Flash model exists)',
    owned_by: 'google-web',
  },
  'gemini-4-thinking': {
    id: 'gemini-4-thinking',
    name: 'Gemini 4 — максимальное мышление (алиас)',
    modelId: 8,      // ARGON
    hexId: '95a4c0abcba24364',
    thinkMode: 0,    // EXTENDED (deepest)
    description: 'Alias → gemini-4-argon-thinking (максимальное мышление)',
    owned_by: 'google-web',
  },
};

// Только слова, которых нет в русском: «дуже», «треба», «якщо» по-русски тоже
// пишутся, и пара таких слов не должна переключать весь чат на украинский.
const UK_WORDS = new Set(('як що це цей ця ці без при йде йдуть був була були було вже тільки ' +
  'можна є немає також коли який яка які або але тобто тому ' +
  'чого чому куди ніколи краще знайди напиши покажи поясни зроби зробити працює ' +
  'працювати файл файли код помилка проблема дякую будь-ласка гаразд справи новий нова нові ' +
  'щоб воно вона працювало працювали допомогу допомогти допомога зараз потрібно потрібен ' +
  'добрий доброго день вечір ранок пан пані дякую будь вдячний мені тебе тобі нас вас вони ' +
  'робити взяти дати мати хочу хочеш хочемо можеш можете').split(' '));

class GeminiWebBridge {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.cookie = pickCookieSource(options.cookie, options.cookieFile, options.cookie_file);
    this.proxy = options.proxy || '';
    this.network = options.network || null;
    this.bl = options.bl || DEFAULT_BL;
    this.authUser = options.authUser ?? null; // индекс аккаунта Google (/u/N), null — основной
    this.atToken = options.atToken || '';     // XSRF-токен (опционально)
    this.temporaryChats = !!options.temporaryChats;
    this.accountLabel = options.accountLabel || ''; // подпись веб-аккаунта (напр. «личный Pro»)
    this.timeoutMs = options.timeoutMs || 180000;
    this.thinkMode = options.thinkMode || null; // null = по модели; 'extended' — максимум размышлений для всех веб-моделей
    this.historyMaxChars = Math.max(4000, Math.min(400000, Number(options.historyMaxChars) || 60000));
    this.xsrf = options.xsrf !== false;
    this._blFetchedAt = 0;
    this._blPromise = null;
    this._blNextTryAt = 0;
    this.onCookieRotated = typeof options.onCookieRotated === 'function' ? options.onCookieRotated : null;
    this.onAccountSwitch = typeof options.onAccountSwitch === 'function' ? options.onAccountSwitch : null;
    this._agentCache = null; // агент для текущего прокси создается лениво
    this._rotatePromise = null;
    this._lastRotateAt = 0;
    this._xsrfToken = '';
    this._xsrfAt = 0;
    this._xsrfFailAt = 0;
    // Мультиаккаунт: несколько наборов cookie с общим шлюзом. Пусто —
    // работает одиночная cookie выше (полная обратная совместимость).
    this._globalProxy = options.proxy || '';
    this._globalAuthUser = options.authUser ?? null;
    this._globalThinkMode = this.thinkMode;
    this._globalAccountLabel = this.accountLabel;
    this._globalTemporaryChats = this.temporaryChats;
    this.accounts = Array.isArray(options.accounts) ? options.accounts.filter((a) => a && a.name) : [];
    this.autoRotateOn429 = options.autoRotateOn429 === true;
    this._activeAccount = '';
    this._accountStats = new Map();
    if (this.accounts.length) this.selectAccount(options.activeAccount || this.accounts[0].name);
  }

  // ---- мультиаккаунт ----

  accountStat(name) {
    if (!this._accountStats.has(name)) {
      this._accountStats.set(name, { requests: 0, errors: 0, cooldownUntil: 0, lastError: '', lastUsedAt: 0 });
    }
    return this._accountStats.get(name);
  }

  // Переключение на аккаунт: подменяет cookie/proxy/authUser/thinkMode.
  selectAccount(name) {
    const acct = this.accounts.find((a) => a.name === name);
    if (!acct) return null;
    this._activeAccount = acct.name;
    const ck = pickCookieSource(acct.cookie, acct.cookie_file, acct.cookieFile);
    if (ck) {
      this.cookie = ck;
      this._xsrfToken = '';
      this._xsrfAt = 0;
      this._lastRotateAt = 0;
    }
    this.proxy = acct.proxy || this._globalProxy;
    this._agentCache = null;
    this.authUser = (typeof acct.authUser === 'number') ? acct.authUser : this._globalAuthUser;
    this.thinkMode = acct.thinkMode ?? this._globalThinkMode;
    this.accountLabel = acct.label || this._globalAccountLabel;
    this.temporaryChats = typeof acct.temporaryChats === 'boolean' ? acct.temporaryChats : this._globalTemporaryChats;
    this.accountStat(acct.name).lastUsedAt = Date.now();
    return acct;
  }

  // Следующий аккаунт по кругу, пропуская те, что в cooldown.
  nextAccountName(exclude = []) {
    if (this.accounts.length < 2) return null;
    const now = Date.now();
    const start = Math.max(0, this.accounts.findIndex((a) => a.name === this._activeAccount));
    // Текущий аккаунт исключаем всегда: ротация — это переход на другой.
    const skip = this._activeAccount ? [...exclude, this._activeAccount] : exclude;
    for (let i = 1; i <= this.accounts.length; i++) {
      const acct = this.accounts[(start + i) % this.accounts.length];
      if (!acct || skip.includes(acct.name)) continue;
      if (this.accountStat(acct.name).cooldownUntil > now) continue;
      return acct.name;
    }
    return null;
  }

  markAccountFailure(name, reason, cooldownMs = 60000) {
    if (!name) return;
    const st = this.accountStat(name);
    st.errors += 1;
    st.lastError = String(reason || '').slice(0, 200);
    st.cooldownUntil = Date.now() + cooldownMs;
  }

  accountsSummary() {
    return this.accounts.map((a) => {
      const st = this.accountStat(a.name);
      return {
        name: a.name,
        label: a.label || '',
        active: a.name === this._activeAccount,
        authUser: typeof a.authUser === 'number' ? a.authUser : null,
        hasProxy: !!a.proxy,
        hasCookie: !!pickCookieSource(a.cookie, a.cookie_file),
        requests: st.requests,
        errors: st.errors,
        cooldownUntil: st.cooldownUntil > Date.now() ? st.cooldownUntil : null,
        lastError: st.lastError || null,
      };
    });
  }

  updateConfig(cfg = {}) {
    if (typeof cfg.enabled === 'boolean') this.enabled = cfg.enabled;
    if (typeof cfg.xsrf === 'boolean') this.xsrf = cfg.xsrf;
    if (cfg.historyMaxChars !== undefined) {
      this.historyMaxChars = Math.max(4000, Math.min(400000, Number(cfg.historyMaxChars) || 60000));
    }
    if (cfg.thinkMode === 'extended' || cfg.thinkMode === 'default' || cfg.thinkMode === null || cfg.thinkMode === '') {
      this.thinkMode = cfg.thinkMode === '' ? null : cfg.thinkMode;
      this._globalThinkMode = this.thinkMode;
    }
    const hasCookieField = ['cookie', 'cookieFile', 'cookie_file']
      .some(k => typeof cfg[k] === 'string');
    const ck = hasCookieField ? pickCookieSource(cfg.cookie, cfg.cookieFile, cfg.cookie_file) : this.cookie;
    if (ck !== this.cookie) {
      this.cookie = ck;
      this._xsrfToken = '';
      this._xsrfAt = 0;
      this._lastRotateAt = 0;
    }
    if (typeof cfg.proxy === 'string' && cfg.proxy !== this.proxy) { this.proxy = cfg.proxy; this._agentCache = null; }
    if (typeof cfg.bl === 'string' && cfg.bl) this.bl = cfg.bl;
    if (typeof cfg.authUser === 'number' || cfg.authUser === null || cfg.authUser === '') {
      this.authUser = cfg.authUser === '' ? null : cfg.authUser;
      this._globalAuthUser = this.authUser;
    }
    if (typeof cfg.atToken === 'string') this.atToken = cfg.atToken;
    if (typeof cfg.temporaryChats === 'boolean') {
      this.temporaryChats = cfg.temporaryChats;
      this._globalTemporaryChats = cfg.temporaryChats;
    }
    if (typeof cfg.accountLabel === 'string') {
      this.accountLabel = cfg.accountLabel;
      this._globalAccountLabel = cfg.accountLabel;
    }
    if (typeof cfg.proxy === 'string') this._globalProxy = cfg.proxy;
    if (Array.isArray(cfg.accounts)) {
      this.accounts = cfg.accounts.filter((a) => a && a.name);
      const validNames = new Set(this.accounts.map((a) => a.name));
      for (const key of this._accountStats.keys()) {
        if (!validNames.has(key)) this._accountStats.delete(key);
      }
      this._activeAccount = '';
    }
    if (typeof cfg.autoRotateOn429 === 'boolean') this.autoRotateOn429 = cfg.autoRotateOn429;
    if (this.accounts.length) {
      const wanted = String(cfg.activeAccount || this._activeAccount || '').trim();
      const known = this.accounts.some((a) => a.name === wanted);
      this.selectAccount(known ? wanted : this.accounts[0].name);
    }
  }

  summary() {
    const { cookieStr } = this.getLoadedCookie();
    return {
      enabled: this.enabled,
      // Эвристическая верификация: mode=8 — исследованный селектор Gemini 4 Argon
      // в веб-протоколе (zexadev/gemini-web2api-go). Per-response аттестации
      // модели Google в этом протоколе не предоставляет.
      modelVerified: 'heuristic',
      generationAvailable: this.enabled,
      verificationReason: 'mode=8 community reverse-engineered as Gemini 4 Argon selector; no per-response attestation',
      accountLabel: this.accountLabel,
      cookieSet: !!cookieStr,
      thinkMode: this.thinkMode || 'per-model',
      proxy: redactProxy(this.proxy || ''),
      bl: this.bl,
      authUser: this.authUser,
      temporaryChats: this.temporaryChats,
      models: this.enabled ? Object.keys(WEB_MODELS) : [],
      ...(this.accounts.length ? { accounts: this.accountsSummary(), activeAccount: this._activeAccount } : {}),
    };
  }

  isWebModelName(modelName) {
    if (!modelName) return false;
    return Object.prototype.hasOwnProperty.call(WEB_MODELS, String(modelName).toLowerCase());
  }

  isWebModel(modelName) {
    return this.enabled && this.isWebModelName(modelName);
  }

  getModelMeta(modelName) {
    const lower = String(modelName).toLowerCase();
    const known = WEB_MODELS[lower];
    if (!known) {
      throw Object.assign(new Error(`Unknown web model "${modelName}"`), {
        status: 400,
        code: 'model_not_found',
      });
    }
    const meta = { ...known };
    // Глобальный override режима размышления (config.json -> geminiWeb.thinkMode):
    // 'extended' — EXTENDED (thinkMode 0) для всех веб-моделей, 'default' — обычный.
    if (this.thinkMode === 'extended') meta.thinkMode = 0;
    else if (this.thinkMode === 'default') meta.thinkMode = 4;
    return meta;
  }

  getModelsList() {
    if (!this.enabled) return [];
    return Object.values(WEB_MODELS).map(m => ({
      id: m.id,
      object: 'model',
      created: 1775000000,
      owned_by: m.owned_by,
      display_name: m.name,
      displayName: m.name,
      description: m.description,
      permission: [{
        id: 'modelperm-' + m.id,
        object: 'model_permission',
        created: 1775000000,
        allow_create_engine: false,
        allow_sampling: true,
        allow_logprobs: false,
        allow_search_indices: false,
        allow_view: true,
        allow_fine_tuning: false,
        organization: '*',
        group: null,
        is_blocking: false,
      }],
    }));
  }

  // ---- Cookies & Headers ----

  _resolveCookieFile(value) {
    const s = String(value || '').trim().replace(/^"(.*)"$/, '$1').trim();
    if (!s || s.includes(';') || s.startsWith('{') || s.startsWith('[')) return null;
    const candidates = path.isAbsolute(s) ? [s]
      : [path.join(ROOT_DIR, s), path.resolve(s), ...this.dataDirs().map((d) => path.join(d, s))];
    for (const f of candidates) {
      try {
        if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
      } catch {}
    }
    return null;
  }

  // В Docker мутабельные файлы лежат в томе (AG_DATA_DIR), а не рядом с кодом.
  dataDirs() {
    const dirs = [];
    if (process.env.AG_DATA_DIR) dirs.push(path.resolve(process.env.AG_DATA_DIR));
    try {
      const { resolveDataDir } = require('./data_dir');
      const d = resolveDataDir();
      if (d && !dirs.includes(d)) dirs.push(d);
    } catch {}
    return dirs;
  }

  getLoadedCookie() {
    let raw = this.cookie;
    const file = this._resolveCookieFile(raw);
    if (file) {
      try {
        raw = fs.readFileSync(file, 'utf8').trim();
      } catch {}
    }
    if (!raw) {
      // ищем cookie.txt рядом с приложением, в рабочей папке и в каталоге данных
      const candidates = [path.join(ROOT_DIR, 'cookie.txt'), path.join(process.cwd(), 'cookie.txt'),
        ...this.dataDirs().map((d) => path.join(d, 'cookie.txt'))];
      for (const f of candidates) {
        if (fs.existsSync(f)) {
          try {
            raw = fs.readFileSync(f, 'utf8').trim();
            if (raw) break;
          } catch {}
        }
      }
    }
    if (!raw) return { cookieStr: '', sapisid: null };

    raw = raw.replace(/^Cookie:\s*/i, '');

    if (raw.startsWith('{')) {
      try {
        const j = JSON.parse(raw);
        // JSON вида {"cookie_file": "cookie.txt"} — резолвим путь к файлу
        if (typeof j.cookie_file === 'string' && j.cookie_file) {
          let fp = j.cookie_file;
          if (!path.isAbsolute(fp)) {
            // В Docker относительный путь ищем и в томе данных, а не только у кода.
            const cands = [path.join(ROOT_DIR, fp), ...this.dataDirs().map((d) => path.join(d, fp))];
            fp = cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || cands[0];
          }
          if (fs.existsSync(fp)) {
            const nested = fs.readFileSync(fp, 'utf8').trim();
            if (nested.startsWith('{') || nested.startsWith('[')) {
              raw = cookieHeaderFromJson(JSON.parse(nested));
            } else {
              raw = nested;
            }
          }
        } else {
          raw = cookieHeaderFromJson(j) || raw;
        }
      } catch {}
    } else if (raw.startsWith('[')) {
      try {
        raw = cookieHeaderFromJson(JSON.parse(raw)) || raw;
      } catch {}
    } else if (raw.includes('\t')) {
      // Экспорт в формате Netscape (cookies.txt из расширений браузера)
      raw = cookieHeaderFromNetscape(raw) || raw;
    }

    // Неразобранный JSON/путь не должен уходить как заголовок Cookie.
    if (raw.startsWith('{') || raw.startsWith('[')) return { cookieStr: '', sapisid: null };
    raw = raw.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!raw.includes('=')) return { cookieStr: '', sapisid: null };

    const m = raw.match(/(?:^|;\s*)SAPISID=([^;]+)/);
    const sapisid = m ? m[1].trim() : null;
    return { cookieStr: raw, sapisid };
  }

  accountPrefix() {
    if (this.authUser === null || this.authUser === '' || this.authUser === 0) return '';
    return `/u/${this.authUser}`;
  }

  makeSapisidHash(sapisid) {
    const ts = Math.floor(Date.now() / 1000);
    const sha1 = crypto.createHash('sha1').update(`${ts} ${sapisid} https://gemini.google.com`).digest('hex');
    return `SAPISIDHASH ${ts}_${sha1}`;
  }

  // ---- Message / Prompt Conversion ----

  messagesToPrompt(messages = [], tools = []) {
    const parts = [];

    if (Array.isArray(tools) && tools.length > 0) {
      let toolDefs = tools.map(t => {
        const fn = t.type === 'function' ? t.function : t;
        return {
          name: fn.name || t.name || '',
          description: fn.description || t.description || '',
          parameters: fn.parameters || t.parameters || {},
        };
      });
      let toolsJson = JSON.stringify(toolDefs, null, 2);
      if (toolsJson.length > 30000) {
        toolDefs = toolDefs.map(t => ({ name: t.name, description: t.description }));
        toolsJson = JSON.stringify(toolDefs, null, 2);
      }

      parts.push(
        '[System instruction]: You have access to tools. ' +
        'To call a tool, respond with:\n' +
        '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n' +
        'Only use tool_call blocks when needed.\n\n' +
        `Available tools:\n${toolsJson}`
      );
    }

    for (const msg of messages) {
      const role = msg.role || 'user';
      let content = msg.content || '';
      if (Array.isArray(content)) {
        content = content.map(p => (typeof p === 'string' ? p : p.text || (p.type === 'image_url' ? '[Image attached]' : ''))).join(' ');
      }
      content = String(content).trim();

      if (role === 'system') {
        parts.push(`[System instruction]: ${content}`);
      } else if (role === 'assistant') {
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          const tcStrs = msg.tool_calls.map(tc => {
            const fn = tc.function || {};
            return `\`\`\`tool_call\n{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}\n\`\`\``;
          });
          parts.push(`[Assistant]: ${content}\n${tcStrs.join('\n')}`);
        } else {
          parts.push(`[Assistant]: ${content}`);
        }
      } else if (role === 'tool') {
        parts.push(`[Tool result for ${msg.name || msg.tool_call_id || 'tool'}]: ${content}`);
      } else {
        parts.push(content);
      }
    }

    return this._capHistory(parts);
  }

  // конвертация нативного Gemini-запроса (contents + systemInstruction) в промпт
  contentsToPrompt(requestObj = {}) {
    const parts = [];
    const sys = requestObj.systemInstruction || requestObj.system_instruction;
    if (sys) {
      const sysText = (sys.parts || [])
        .map(p => p.text || '')
        .filter(Boolean)
        .join(' ')
        .trim();
      if (sysText) parts.push(`[System instruction]: ${sysText}`);
    }
    for (const c of requestObj.contents || []) {
      const role = c.role === 'model' ? 'Assistant' : 'User';
      const text = (c.parts || [])
        .map(p => {
          if (p.text) return p.text;
          if (p.inlineData || p.inline_data) return '[Image attached]';
          return '';
        })
        .filter(Boolean)
        .join(' ')
        .trim();
      if (text) parts.push(`[${role}]: ${text}`);
    }
    return this._capHistory(parts);
  }

  _capHistory(parts) {
    const clean = (parts || []).filter(Boolean);
    let joined = clean.join('\n\n');
    const maxChars = this.historyMaxChars || 60000;
    if (joined.length <= maxChars) return joined;
    // Keep system instructions and most recent turns within historyMaxChars
    const sys = [];
    const turns = [];
    for (const p of clean) {
      if (p.startsWith('[System instruction]:')) sys.push(p);
      else turns.push(p);
    }
    while (turns.length > 1 && [...sys, ...turns].join('\n\n').length > maxChars) {
      turns.shift();
    }
    joined = [...sys, ...turns].join('\n\n');
    return joined.length > maxChars ? joined.slice(-maxChars) : joined;
  }

  // Строит x-goog-ext-525001261-jspb — ЕДИНСТВЕННЫЙ селектор модели, который признаёт сервер.
  // Без него inner[79] игнорируется и всё падает в 3.5 Flash-Lite.
  // Формат из перехваченного трафика: [1,null,null,null,"<hex>",null,null,0,[4,5,6,8],null,null,1,null,null,<mode>,<think>,"<uuid>"]
  buildModelHeader(hexId, mode, thinkMode) {
    const think = thinkMode === 0 ? 2 : 1;
    const uuid = crypto.randomUUID();
    return `[1,null,null,null,"${hexId}",null,null,0,[4,5,6,8],null,null,1,null,null,${mode},${think},"${uuid}"]`;
  }

  // Извлекает РЕАЛЬНОЕ имя модели из ответа сервера (фрейм [42]).
  // Формат: "95a4c0abcba24364",null,null,"4 Argon" — берём последнее совпадение.
  // Позволяет увидеть тихий даунгрейд (например, в 3.5 Flash-Lite).
  extractUpstreamModel(rawText) {
    if (!rawText) return '';
    const re = /"[0-9a-f]{16}",null,null,"([^"\\]{1,40})"/g;
    let m, last = '';
    while ((m = re.exec(rawText)) !== null) {
      if (m[1]) last = m[1];
    }
    return last;
  }

  // ---- Reply language ----

  // У украинского бывают тексты вообще без і/ї/є/ґ (всё зависит от слов), а
  // русских слов со ы/э/ё эти тексты не содержат — по ним и различим.
  // Язык ответа Gemini берётся из сообщений пользователя: hl влияет на
  // служебные реплики и предпочтение языка, inner[1] — на язык генерации.
  // Кириллица/латиница мало что говорят о языке, поэтому считаем символы по
  // письменностям и берём доминирующую. Языки с латиницей (fr/de/es/pl…)
  // по буквам не различить, поэтому они, как и раньше, уходят в en.
  langScores(text) {
    const stripped = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ');
    const count = (re) => (stripped.match(re) || []).length;
    const ukSpecific = count(/[ІіЇїЄєҐґ]/g);
    return {
      cyr: count(/[А-Яа-яЁё]/g) + ukSpecific,
      uk: ukSpecific,
      ja: count(/[\u3040-\u30ff\u31f0-\u31ff]/g),
      zh: count(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g),
      ko: count(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g),
      ar: count(/[\u0600-\u06ff\u0750-\u077f]/g),
      he: count(/[\u0590-\u05ff]/g),
      el: count(/[\u0370-\u03ff\u1f00-\u1fff]/g),
      hi: count(/[\u0900-\u097f]/g),
      th: count(/[\u0e00-\u0e7f]/g),
      ka: count(/[\u10a0-\u10ff]/g),
      hy: count(/[\u0530-\u058f]/g),
      lat: count(/[A-Za-z]/g),
    };
  }

  // Порог 3: «ok» или пара случайных букв не должны переключать язык.
  // Ключи кроме 'cyr'/'lat' — отдельные языки; латиницу сравниваем с суммой
  // чужих букв, потому что в любом тексте бывают имена, URL и код.
  // text — исходный текст, нужен для украинских слов без особых букв.
  pickLang(scores = {}, text = '') {
    const get = (k) => Number(scores[k]) || 0;
    const cyr = get('cyr');
    const uk = get('uk');
    const foreign = ['ja', 'zh', 'ko', 'ar', 'he', 'el', 'hi', 'th', 'ka', 'hy'];
    const foreignTotal = foreign.reduce((n, k) => n + get(k), 0);
    const nonLatin = cyr + foreignTotal;

    // Не-латинские языки в приоритете: их буквы однозначны.
    // Украинский: особые буквы (і ї є ґ) + частые слова, которых нет в русском.
    const ukWords = (String(text || '').toLowerCase().match(/[а-яіїєґ']+/g) || [])
      .filter(w => UK_WORDS.has(w)).length;
    const ukShare = cyr ? uk / cyr : 0;
    const ukHit = cyr >= 3 && (uk >= 2 && ukShare >= 0.08 || ukWords >= 2);
    const best = { lang: ukHit ? 'uk' : 'ru', count: cyr };
    const pick = (lang, count) => { if (count > best.count) { best.lang = lang; best.count = count; } };
    for (const lang of foreign) pick(lang, get(lang));
    // У японского кана+кандзи: иероглифы без каны — это китайский.
    if (best.lang === 'ja' && get('ja') < 3 && get('zh') > get('ja')) { best.lang = 'zh'; best.count = get('zh'); }
    // Для иероглифов и алфавитов с однозначными буквами хватит двух символов.
    const minCount = ['ja', 'zh', 'ko'].includes(best.lang) ? 2 : 3;
    if (best.count >= minCount) return best.lang;

    if (get('lat') >= 3 && get('lat') > nonLatin) return 'en';
    return '';
  }

  detectLangFromText(text) {
    return this.pickLang(this.langScores(text), text);
  }

  // Копим статистику по всей переписке: короткая реплика «ok» или случайный
  // набор клавиш не должны переключать язык всего чата.
  detectChatLang(messages = []) {
    const total = {};
    let text = '';
    for (const msg of messages) {
      if (!msg || (msg.role || 'user') !== 'user') continue;
      let content = msg.content || '';
      if (Array.isArray(content)) {
        content = content.map(p => (typeof p === 'string' ? p : p.text || '')).join(' ');
      }
      const s = this.langScores(content);
      for (const k of Object.keys(s)) total[k] = (total[k] || 0) + s[k];
      text += ' ' + content;
    }
    return this.pickLang(total, text) || 'en';
  }

  detectContentsLang(requestObj = {}) {
    const total = {};
    let text = '';
    for (const c of requestObj.contents || []) {
      if (!c || c.role === 'model') continue;
      const part = (c.parts || []).map(p => p.text || '').join(' ');
      const s = this.langScores(part);
      for (const k of Object.keys(s)) total[k] = (total[k] || 0) + s[k];
      text += ' ' + part;
    }
    return this.pickLang(total, text) || 'en';
  }

  buildPayload(promptText, modelId, thinkMode, lang = 'en') {
    // thinkMode: 4=DEFAULT → 1 (обычный), 0=EXTENDED → 2 (расширенное мышление, только с куками)
    const think = thinkMode === 0 ? 2 : 1;
    const inner = new Array(97).fill(null);
    // inner[1] только подсказывает язык: на длинных чатах модель его часто
    // игнорирует и отвечает по-английски. Явная строка в начале запроса
    // надёжнее (для en не нужна — это язык по умолчанию).
    const langHint = lang && lang !== 'en' && /^[a-z]{2}(-[a-z]{2})?$/i.test(lang)
      ? `[Respond in "${lang}" — the language of the user's messages.]\n\n`
      : '';
    inner[0] = [langHint + promptText, 0, null, null, null, null, 0];
    inner[1] = [lang];
    inner[2] = ['', '', '', null, null, null, null, null, null, ''];
    inner[6] = [0];
    inner[7] = 1;
    inner[10] = 1;
    inner[11] = 0;
    inner[17] = [[0]];
    inner[18] = 0;
    inner[27] = 1;
    inner[30] = [4];
    // флаги персистентности чата (как в веб-клиенте)
    if (this.temporaryChats) {
      inner[41] = [1];
      inner[45] = 1;
    } else {
      inner[41] = [2];
    }
    inner[53] = 0;
    inner[59] = crypto.randomUUID();
    inner[61] = [];
    inner[68] = 1;
    inner[79] = modelId;
    inner[80] = think;

    const outer = [null, JSON.stringify(inner)];
    const params = new URLSearchParams();
    params.set('f.req', JSON.stringify(outer));
    const at = this.atToken || (this.xsrf ? this._xsrfToken : '');
    if (at) params.set('at', at);
    return params.toString();
  }

  cleanText(text) {
    if (!text) return '';
    return text
      .replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g, '')
      .trim();
  }

  parseToolCalls(text) {
    const pattern = /```tool_call\s*\n([\s\S]*?)\n```/g;
    const toolCalls = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      try {
        const data = JSON.parse(match[1].trim());
        if (!data || typeof data.name !== 'string' || !data.name.trim()) continue;
        toolCalls.push({
          id: 'call_' + crypto.randomBytes(6).toString('hex'),
          type: 'function',
          function: {
            name: data.name.trim(),
            arguments: JSON.stringify(data.arguments || {}),
          },
        });
      } catch {}
    }
    const clean = text.replace(pattern, '').trim();
    return { cleanText: clean, toolCalls };
  }

  // ---- Network request with optional Proxy ----

  createAgent(proxyUrl) {
    if (!proxyUrl) return null;
    if (this._agentCache && this._agentCacheFor === proxyUrl) return this._agentCache;
    try {
      const u = new URL(proxyUrl);
      const isHttpsProxy = u.protocol === 'https:';
      const proxyPort = parseInt(u.port, 10) || (isHttpsProxy ? 443 : 80);
      const proxyHost = u.hostname;
      const authHeader = (u.username || u.password)
        ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
        : '';

      class WebProxyAgent extends https.Agent {
        createConnection(_options, callback) {
          let settled = false;
          const finish = (err, sock) => {
            if (settled) {
              if (sock) { try { sock.destroy(); } catch {} }
              return;
            }
            settled = true;
            callback(err, sock);
          };
          const connectOpts = {
            host: proxyHost,
            port: proxyPort,
            method: 'CONNECT',
            path: `${GOOGLE_HOST}:443`,
            headers: {
              Host: `${GOOGLE_HOST}:443`,
              'Proxy-Connection': 'Keep-Alive',
              ...(authHeader ? { 'Proxy-Authorization': authHeader } : {}),
            },
          };
          const httpModule = isHttpsProxy ? https : http;
          const req = httpModule.request(connectOpts);
          req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
              try { socket.destroy(); } catch {}
              return finish(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
            }
            const tlsSocket = tls.connect({
              socket,
              servername: GOOGLE_HOST,
            }, () => finish(null, tlsSocket));
            tlsSocket.once('error', (err) => {
              try { socket.destroy(); } catch {}
              finish(err);
            });
          });
          req.once('error', finish);
          req.end();
        }
      }

      const agent = new WebProxyAgent({ keepAlive: true, maxSockets: 32 });
      this._agentCache = agent;
      this._agentCacheFor = proxyUrl;
      return agent;
    } catch {
      return null;
    }
  }

  // При остановке шлюза destroy() у keep-alive агентов, иначе сокеты держат
  // event loop ещё ~5 минут.
  closeAllSockets() {
    try { this._agentCache?.destroy(); } catch {}
    this._agentCache = null;
    this._agentCacheFor = '';
    try { this.network?.destroyAll?.(); } catch {}
  }

  getAgent() {
    // NetworkManager already knows the web route (geminiWeb.proxy), env proxies,
    // NO_PROXY and custom DNS. Fall back to the local agent only without it.
    if (this.network) {
      return {
        proxy: this.proxy || this.network.settings.webProxy || '',
        agent: this.network.agentFor('web', GOOGLE_HOST, this.proxy || undefined),
      };
    }
    const proxy = this.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
    return { proxy, agent: this.createAgent(proxy) };
  }

  _fetchBlPage(agent) {
    return new Promise((resolve) => {
      const req = https.request({
        host: GOOGLE_HOST,
        port: 443,
        path: '/app',
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
        agent,
        timeout: 15000,
        maxHeaderSize: 262144,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', () => resolve(''));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.on('error', () => resolve(''));
      req.end();
    });
  }

  // Автообновление BL-версии со страницы gemini.google.com (как настоящий браузер).
  async fetchLatestBl() {
    const agents = [];
    try { agents.push(this.getAgent().agent); } catch {}
    // Relay отдаёт на HTML-страницу Google "sorry", поэтому пробуем и прямой маршрут.
    if (agents[0] !== null) agents.push(null);
    for (const agent of agents) {
      const body = await this._fetchBlPage(agent);
      const m = body && body.match(BL_PATTERN);
      if (m && m[0]) {
        if (m[0] !== this.bl) this.bl = m[0];
        this._blFetchedAt = Date.now();
        return this.bl;
      }
    }
    return null;
  }

  // BL устойчив: раз в ~6 часов, или форсируется по флагу.
  // Один запрос на всех: без этого пачка входящих запросов при недоступной
  // странице /app давала N параллельных 15-секундных GET, и каждый запрос
  // повторял их заново. После неудачи — минутная пауза.
  async ensureBlFresh(force = false) {
    if (!force && Date.now() - this._blFetchedAt < 6 * 3600 * 1000) return this.bl;
    if (!force && Date.now() < (this._blNextTryAt || 0)) return this.bl;
    if (!this._blPromise) {
      this._blPromise = this.fetchLatestBl()
        .then((bl) => {
          if (!bl) this._blNextTryAt = Date.now() + 60 * 1000;
          return bl;
        })
        .finally(() => { this._blPromise = null; });
    }
    await this._blPromise;
    return this.bl;
  }

  async sendStreamRequest(bodyStr, modelMeta, lang = 'en', opts = {}) {
    if (this._activeAccount) this.accountStat(this._activeAccount).requests += 1;
    const reqid = Math.floor(Date.now() / 1000) % 1000000;
    const prefix = this.accountPrefix();
    const pathUrl = `${prefix}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${this.bl}&hl=${encodeURIComponent(lang)}&_reqid=${reqid}&rt=c`;

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'Origin': `https://${GOOGLE_HOST}`,
      'Referer': `https://${GOOGLE_HOST}${prefix}/app`,
      'X-Same-Domain': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Content-Length': Buffer.byteLength(bodyStr),
    };

    const { cookieStr, sapisid } = this.getLoadedCookie();
    if (cookieStr) headers['Cookie'] = cookieStr;
    if (sapisid) headers['Authorization'] = this.makeSapisidHash(sapisid);
    if (prefix) headers['X-Goog-AuthUser'] = String(this.authUser);
    // КРИТИЧНО: без этого header сервер игнорирует выбор модели и отдаёт 3.5 Flash-Lite
    if (modelMeta && modelMeta.hexId) {
      headers['x-goog-ext-525001261-jspb'] = this.buildModelHeader(
        modelMeta.hexId, modelMeta.modelId, modelMeta.thinkMode);
    }

    const { agent } = this.getAgent();
    const signal = opts.signal || null;

    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        return reject(Object.assign(new Error('client disconnected'), { code: 'client_disconnected' }));
      }
      const req = https.request({
        host: GOOGLE_HOST,
        port: 443,
        path: pathUrl,
        method: 'POST',
        headers,
        agent,
        timeout: this.timeoutMs,
        maxHeaderSize: 131072,
      }, (res) => {
        if (res.statusCode >= 300) {
          const redirected = res.statusCode < 400;
          const err = redirected
            ? new Error('Gemini Web upstream redirected to a Google verification page ("sorry") — change the egress/proxy or refresh the session')
            : new Error(`Gemini Web HTTP ${res.statusCode}`);
          err.status = redirected ? 502 : res.statusCode;
          if (redirected) err.code = 'web_verification_required';
          if (res.headers && res.headers.location) err.location = res.headers.location;
          // Read only a bounded error body; keep the original fallback for other failures.
          const chunks = [];
          let size = 0;
          res.on('data', chunk => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = 65536 - size;
            if (remaining > 0) {
              chunks.push(data.subarray(0, remaining));
              size += Math.min(data.length, remaining);
            }
          });
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            reject(regionRejection(body) ? regionError() : err);
          });
          res.on('error', () => reject(err));
          return;
        }
        resolve(res);
      });

      const onAbort = () => {
        req.destroy(Object.assign(new Error('client disconnected'), { code: 'client_disconnected' }));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => { if (signal) signal.removeEventListener('abort', onAbort); });
      req.on('timeout', () => {
        req.destroy(new Error(`Gemini Web request timed out (${this.timeoutMs}ms)`));
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
  }

  _cookieHeaderValue(cookieStr, name) {
    const m = String(cookieStr || '').match(new RegExp(`(?:^|;\\s*)${escapeRe(name)}=([^;]*)`));
    return m ? m[1] : '';
  }

  _cookieSubset(cookieStr, names) {
    return names.map((name) => {
      const value = this._cookieHeaderValue(cookieStr, name);
      return value ? `${name}=${value}` : '';
    }).filter(Boolean).join('; ');
  }

  _mergeSetCookie(cookieStr, setCookieHeaders) {
    let out = String(cookieStr || '');
    const updated = [];
    for (const raw of setCookieHeaders || []) {
      const first = String(raw).split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      const re = new RegExp(`(^|;\\s*)${escapeRe(name)}=[^;]*`);
      if (re.test(out)) out = out.replace(re, (m, prefix) => `${prefix}${name}=${value}`);
      else out = out ? `${out}; ${name}=${value}` : `${name}=${value}`;
      updated.push(name);
    }
    return { cookie: out, updated };
  }

  // __Secure-1PSIDTS живёт ~30 минут; без keepalive Google считает сессию анонимной.
  async rotateCookies() {
    if (this._rotatePromise) return this._rotatePromise;
    if (Date.now() - (this._lastRotateAt || 0) < 60 * 1000) return false;
    this._lastRotateAt = Date.now();
    this._rotatePromise = (async () => {
      try {
        const { cookieStr } = this.getLoadedCookie();
        if (!this._cookieHeaderValue(cookieStr, '__Secure-1PSID')) return false;
        const subset = this._cookieSubset(cookieStr, ROTATE_COOKIE_NAMES);
        if (!subset) return false;
        const { agent } = this.getAgent();
        const body = ROTATE_BODY;
        const headers = {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Origin': 'https://accounts.google.com',
          'Referer': 'https://accounts.google.com/RotateCookiesPage?og_pid=658&rot=3&origin=https%3A%2F%2Fgemini.google.com&exp_id=0',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'same-origin',
          'Sec-Fetch-Site': 'same-origin',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': subset,
          'Content-Length': Buffer.byteLength(body),
        };
        const result = await new Promise((resolve) => {
          const req = https.request({
            host: 'accounts.google.com',
            port: 443,
            path: '/RotateCookies',
            method: 'POST',
            headers,
            agent,
            timeout: 15000,
            maxHeaderSize: 131072,
          }, (res) => {
            const setCookie = res.headers['set-cookie'] || [];
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, setCookie }));
          });
          req.on('timeout', () => { req.destroy(); resolve({ status: 0, setCookie: [] }); });
          req.on('error', () => resolve({ status: 0, setCookie: [] }));
          req.write(body);
          req.end();
        });
        if (result.status === 200 && result.setCookie.length) {
          const merged = this._mergeSetCookie(cookieStr, result.setCookie);
          if (merged.updated.length) {
            this.cookie = merged.cookie;
            // Без сохранения ротированная cookie живёт только в памяти: после
            // рестарта или сохранения настроек вернётся старая и веб-модели
            // начнут отвечать 401 через ~30 минут.
            if (this.onCookieRotated) {
              try { this.onCookieRotated(merged.cookie, this._activeAccount || ''); } catch {}
            }
            return true;
          }
        }
        return false;
      } catch {
        return false;
      } finally {
        this._rotatePromise = null;
      }
    })();
    return this._rotatePromise;
  }

  async ensureSessionFresh() {
    if (Date.now() - (this._lastRotateAt || 0) < 5 * 60 * 1000) return;
    await this.rotateCookies();
  }

  _fetchAppHtmlPage(cookieStr, agent) {
    return new Promise((resolve) => {
      const headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': CHROME_UA,
      };
      if (cookieStr) headers.Cookie = cookieStr;
      const req = https.request({
        host: GOOGLE_HOST,
        port: 443,
        path: `${this.accountPrefix()}/app`,
        method: 'GET',
        headers,
        agent,
        timeout: 15000,
        maxHeaderSize: 262144,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
        res.on('error', () => resolve({ status: 0, location: '', body: '' }));
        res.on('end', () => resolve({
          status: res.statusCode,
          location: String(res.headers.location || ''),
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, location: '', body: '' }); });
      req.on('error', () => resolve({ status: 0, location: '', body: '' }));
      req.end();
    });
  }

  async _fetchAppTokens(cookieStr) {
    const agents = [];
    try { agents.push(this.getAgent().agent); } catch {}
    if (agents[0] !== null) agents.push(null);
    let last = null;
    for (const [index, agent] of agents.entries()) {
      let page;
      try {
        page = await this._fetchAppHtmlPage(cookieStr, agent);
      } catch {
        page = { status: 0, location: '', body: '' };
      }
      const via = index === 0 ? 'route' : 'direct';
      const m = page.body && page.body.match(/"SNlM0e":"([^"]{10,200})"/);
      if (m) return { token: m[1], page, via };
      last = { page, via };
    }
    return { token: '', page: last ? last.page : { status: 0, location: '', body: '' }, via: last ? last.via : '' };
  }

  // С cookie Google требует XSRF-токен at со страницы /app ("SNlM0e").
  async ensureXsrf(force = false) {
    const { cookieStr } = this.getLoadedCookie();
    if (!cookieStr) return '';
    if (!force && this._xsrfToken && Date.now() - (this._xsrfAt || 0) < 20 * 60 * 1000) return this._xsrfToken;
    if (!force && !this._xsrfToken && Date.now() - (this._xsrfFailAt || 0) < 60 * 1000) return '';
    try {
      const result = await this._fetchAppTokens(cookieStr);
      this._lastXsrfPage = {
        via: result.via,
        status: result.page.status,
        location: String(result.page.location || '').slice(0, 120),
      };
      if (result.token) {
        this._xsrfToken = result.token;
        this._xsrfAt = Date.now();
        return this._xsrfToken;
      }
      this._xsrfToken = '';
      this._xsrfFailAt = Date.now();
      return '';
    } catch {
      this._xsrfToken = '';
      this._xsrfFailAt = Date.now();
      return '';
    }
  }

  // Запрос с автолечением: обновляем BL/сессию/XSRF и при 401/403/429 переключаем аккаунт.
  async sendStreamRequestResilient(bodyOrFactory, modelMeta, lang = 'en', opts = {}) {
    let currentBody = typeof bodyOrFactory === 'function' ? bodyOrFactory() : bodyOrFactory;
    let builtXsrf = this._xsrfToken || '';
    await this.ensureBlFresh();
    if (this.xsrf !== false && this.getLoadedCookie().cookieStr) {
      await this.ensureSessionFresh().catch(() => {});
      await this.ensureXsrf().catch(() => {});
    }
    const makeBody = () => {
      if (typeof bodyOrFactory === 'function') return bodyOrFactory();
      if (typeof opts?.rebuildPayload === 'function' && (this._xsrfToken || '') !== builtXsrf) {
        builtXsrf = this._xsrfToken || '';
        currentBody = opts.rebuildPayload();
      }
      return currentBody;
    };
    try {
      return await this.sendStreamRequest(makeBody(), modelMeta, lang, opts);
    } catch (e) {
      if (e && e.code === 'region_not_supported') throw e;
      if (e && (e.status === 405 || e.status === 400 || e.status === 404)) {
        const fresh = await this.fetchLatestBl();
        if (fresh) {
          try {
            return await this.sendStreamRequest(makeBody(), modelMeta, lang, opts);
          } catch (e2) {
            if (e2 && e2.code === 'region_not_supported') throw e2;
            e2.message = `${e2.message} (BL auto-updated to ${fresh})`;
            throw e2;
          }
        }
      }
      const rotatable = e && (e.status === 401 || e.status === 403
        || (e.status === 429 && this.autoRotateOn429));
      if (rotatable && this.accounts.length > 1) {
        const failed = this._activeAccount;
        this.markAccountFailure(failed, `${e.status}: ${e.message}`, e.status === 429 ? 120000 : 600000);
        const next = this.nextAccountName([failed]);
        if (next) {
          this.selectAccount(next);
          builtXsrf = null;
          if (this.onAccountSwitch) {
            try { this.onAccountSwitch(next); } catch {}
          }
          if (this.xsrf !== false && this.getLoadedCookie().cookieStr) {
            await this.ensureXsrf().catch(() => {});
          }
          try {
            return await this.sendStreamRequest(makeBody(), modelMeta, lang, opts);
          } catch (e3) {
            this.markAccountFailure(next, e3.status ? `${e3.status}: ${e3.message}` : e3.message, 60000);
            throw e3;
          }
        }
      }
      if (e && e.status === 429) {
        e.message = 'Gemini Web rate limited (HTTP 429) — включите temporaryChats или подождите'
          + (this.accounts.length > 1 ? ' либо добавьте аккаунт (autoRotateOn429)' : '');
      }
      throw e;
    }
  }

  // ---- Streaming Iterator ----

  async *streamResponse(res, opts = {}) {
    const prevParts = [];
    let rawAccum = '';
    let streamUpstreamModel = '';
    this._lastUpstreamModel = '';

    for await (const rawLine of sseLines(res)) {
      const line = rawLine.trim();
      let frame;
      try { frame = JSON.parse(line); } catch {
        if (line.startsWith('BardErrorInfo')) {
          if (regionRejection(line)) throw regionError();
          const m = line.match(/BardErrorInfo\s*\[(\d+)\]/);
          if (m && m[1] === '1060') throw regionError();
          const err = new Error(`Gemini Web upstream rejected request (BardErrorInfo [${m ? m[1] : 'unknown'}])`);
          err.status = 502;
          err.type = 'api_error';
          err.code = 502;
          throw err;
        }
        continue;
      }
      if (!Array.isArray(frame)) continue;

      if (!streamUpstreamModel) {
        rawAccum += line + '\n';
        if (rawAccum.length > 200000) rawAccum = rawAccum.slice(-200000);
        const um = this.extractUpstreamModel(rawAccum);
        if (um) {
          streamUpstreamModel = um;
          this._lastUpstreamModel = um;
          if (opts && opts.metaOut) opts.metaOut.upstreamModel = um;
          rawAccum = '';
        }
      }

      for (const record of frame) {
        if (!Array.isArray(record) || record[0] !== 'wrb.fr') continue;
        if (typeof record[2] !== 'string') {
          const flat = JSON.stringify(record);
          if (flat.includes('BardErrorInfo')) {
            if (regionRejection(flat)) throw regionError();
            const m = flat.match(/BardErrorInfo\D*(\d+)/);
            if (m && m[1] === '1060') throw regionError();
            const err = new Error(`Gemini Web upstream rejected request (BardErrorInfo [${m ? m[1] : 'unknown'}]) — проверьте регион/прокси и куки аккаунта`);
            err.status = 502;
            err.type = 'api_error';
            err.code = 502;
            throw err;
          }
          continue;
        }
        let payload;
        try { payload = JSON.parse(record[2]); } catch { continue; }

        const metadata = [Array.isArray(payload) ? [...payload.slice(0, 4), ...payload.slice(5)] : null, record.slice(3)];
        const metadataText = JSON.stringify(metadata);
        if (metadataText.includes('BardErrorInfo')) {
          if (regionRejection(metadata)) throw regionError();
          const m = metadataText.match(/BardErrorInfo\s*\[(\d+)\]/);
          if (m && m[1] === '1060') throw regionError();
          const err = new Error(`Gemini Web upstream rejected request (BardErrorInfo [${m ? m[1] : 'unknown'}])`);
          err.status = 502;
          err.type = 'api_error';
          err.code = 502;
          throw err;
        }
        const candidates = [payload, payload?.error, payload?.[0]?.[2]];
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
          if (!candidate.error && !(candidate.code >= 400) && !candidate.status) continue;
          if (regionRejection(candidate)) throw regionError();
          const error = candidate.error || candidate;
          const diagnostic = JSON.stringify(error);
          const bard = diagnostic.match(/BardErrorInfo\s*\[(\d+)\]/);
          if (bard && bard[1] === '1060') throw regionError(); // LOCATION_REJECTED
          const safeDiagnostic = typeof error.message === 'string' ? error.message
            : typeof error.status === 'string' ? error.status
            : typeof error.code === 'number' ? `HTTP ${error.code}` : '';
          const err = new Error(diagnostic.includes('BardErrorInfo')
            ? `Gemini Web upstream rejected request (BardErrorInfo [${bard ? bard[1] : 'unknown'}])`
            : safeDiagnostic ? `Gemini Web upstream rejected request: ${safeDiagnostic}` : 'Gemini Web upstream rejected request');
          err.status = 502;
          err.type = 'api_error';
          err.code = 502;
          throw err;
        }

        if (Array.isArray(payload) && Array.isArray(payload[4])) {
          // Предыдущий текст храним по каждой части отдельно: в кадре бывает
          // несколько текстовых блоков, и общий счётчик съедал второй из них,
          // а переписанный короткий ответ не отдавался вовсе.
          for (let pi = 0; pi < payload[4].length; pi++) {
            const part = payload[4][pi];
            if (!Array.isArray(part) || !Array.isArray(part[1])) continue;
            if (!prevParts[pi]) prevParts[pi] = '';
            let text = '';
            for (const t of part[1]) {
              if (typeof t === 'string' && t.length > text.length) text = t;
            }
            if (!text) continue;
            const prev = prevParts[pi];
            let delta = '';
            if (text.startsWith(prev)) delta = text.slice(prev.length);
            else if (text !== prev) delta = text; // апстрим переписал часть
            prevParts[pi] = text;
            if (delta) yield delta;
          }
        }
      }
    }
  }

  // ---- Complete Text Generation ----

  async generate(promptText, modelId = 4, thinkMode = 4, lang, opts = {}) {
    const replyLang = lang || this.detectLangFromText(promptText) || 'en';
    const payload = this.buildPayload(promptText, modelId, thinkMode, replyLang);
    const res = await this.sendStreamRequestResilient(
      payload,
      { modelId, thinkMode, hexId: '95a4c0abcba24364' },
      replyLang,
      { ...opts, rebuildPayload: () => this.buildPayload(promptText, modelId, thinkMode, replyLang) }
    );

    let fullText = '';
    for await (const delta of this.streamResponse(res)) {
      fullText += delta;
    }
    const clean = this.cleanText(fullText);
    if (!clean) {
      const err = new Error('Gemini Web returned an empty response — the session may be expired or the bridge is blocked. Refresh the cookie in Settings → Gemini Web.');
      err.status = 502;
      err.code = 'web_empty_response';
      throw err;
    }
    return clean;
  }

  // ---- OpenAI API Handler ----

  async handleOpenAIChat(body, stream, clientRes, hooks = {}) {
    const signal = hooks.signal || null;
    const model = String(body.model || 'gemini-4');
    const meta = this.getModelMeta(model);
    const lang = this.detectChatLang(body.messages || []);
    const prompt = this.messagesToPrompt(body.messages || [], body.tools || []);
    const payload = this.buildPayload(prompt, meta.modelId, meta.thinkMode, lang);

    const upstreamRes = await this.sendStreamRequestResilient(
      payload,
      meta,
      lang,
      { signal, rebuildPayload: () => this.buildPayload(prompt, meta.modelId, meta.thinkMode, lang) }
    );
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-' + crypto.randomUUID();
    const metaOut = { upstreamModel: '' };

    if (!stream) {
      let fullText = '';
      for await (const delta of this.streamResponse(upstreamRes, { metaOut })) {
        fullText += delta;
      }
      const { cleanText, toolCalls } = this.parseToolCalls(fullText);
      if (!cleanText && !toolCalls.length) {
        const err = new Error('Gemini Web returned an empty response — the session may be expired or the bridge is blocked. Refresh the cookie in Settings → Gemini Web.');
        err.status = 502;
        err.code = 'web_empty_response';
        throw err;
      }
      const upstreamModel = metaOut.upstreamModel || this._lastUpstreamModel || '';

      const choice = {
        index: 0,
        message: {
          role: 'assistant',
          content: cleanText || (toolCalls.length ? null : ''),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      };
      if (toolCalls.length) {
        choice.message.tool_calls = toolCalls;
      }

      const promptTokens = Math.max(1, Math.round(prompt.length / 4));
      const completionTokens = Math.max(1, Math.round(fullText.length / 4));

      return {
        id,
        object: 'chat.completion',
        created,
        model,
        upstream_model: upstreamModel,
        choices: [choice],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    }

    const iterator = this.streamResponse(upstreamRes, { metaOut })[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) {
      const err = new Error('Gemini Web returned an empty response — the session may be expired or the bridge is blocked. Refresh the cookie in Settings → Gemini Web.');
      err.status = 502;
      err.code = 'web_empty_response';
      throw err;
    }
    clientRes.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    // Initial role chunk
    const initChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    };
    clientRes.write(`data: ${JSON.stringify(initChunk)}\n\n`);

    let accumulated = '';
    try {
      if (!first.done) {
        accumulated += first.value;
        const firstChunk = {
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: first.value }, finish_reason: null }],
        };
        clientRes.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const delta = next.value;
        accumulated += delta;
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        };
        clientRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    } catch (e) {
      const errChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: `\n[Stream Error: ${e.message}]` }, finish_reason: 'error' }],
      };
      if (e.code === 'region_not_supported') {
        errChunk.error = { message: e.message, type: e.type, code: e.code };
      }
      clientRes.write(`data: ${JSON.stringify(errChunk)}\n\n`);
    }

    // Auto-agent hook: если в накопленном тексте есть вызовы инструментов,
    // сервер может исполнить их и вернуть продолжение ответа.
    if (hooks.onComplete && accumulated) {
      try {
        const extra = await hooks.onComplete(accumulated);
        if (extra) {
          const extraChunk = {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: extra }, finish_reason: null }],
          };
          clientRes.write(`data: ${JSON.stringify(extraChunk)}\n\n`);
        }
      } catch (e) {
        const errDelta = `\n\n[Auto-agent error: ${e.message}]`;
        const errChunk = {
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: errDelta }, finish_reason: null }],
        };
        clientRes.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      }
    }

    // Final finish chunk
    const finishChunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    clientRes.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
    const promptTokens = Math.max(1, Math.round(prompt.length / 4));
    const completionTokens = Math.max(1, Math.round(accumulated.length / 4));
    if (typeof hooks.onUsage === 'function') {
      try { hooks.onUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }); } catch {}
    }
    return null;
  }
}

module.exports = {
  GeminiWebBridge,
  WEB_MODELS,
};

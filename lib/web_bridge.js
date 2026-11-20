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
    this._blFetchedAt = 0;
    this._agentCache = null; // агент для текущего прокси создается лениво
    this._rotatePromise = null;
    this._lastRotateAt = 0;
    this._xsrfToken = '';
    this._xsrfAt = 0;
    this._xsrfFailAt = 0;
  }

  updateConfig(cfg = {}) {
    if (typeof cfg.enabled === 'boolean') this.enabled = cfg.enabled;
    if (cfg.thinkMode === 'extended' || cfg.thinkMode === 'default' || cfg.thinkMode === null || cfg.thinkMode === '') {
      this.thinkMode = cfg.thinkMode === '' ? null : cfg.thinkMode;
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
    if (typeof cfg.authUser === 'number' || cfg.authUser === null || cfg.authUser === '') this.authUser = cfg.authUser === '' ? null : cfg.authUser;
    if (typeof cfg.atToken === 'string') this.atToken = cfg.atToken;
    if (typeof cfg.temporaryChats === 'boolean') this.temporaryChats = cfg.temporaryChats;
    if (typeof cfg.accountLabel === 'string') this.accountLabel = cfg.accountLabel;
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
    const candidates = path.isAbsolute(s) ? [s] : [path.join(ROOT_DIR, s), path.resolve(s)];
    for (const f of candidates) {
      try {
        if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
      } catch {}
    }
    return null;
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
      // ищем cookie.txt рядом с приложением и в рабочей папке
      const candidates = [path.join(ROOT_DIR, 'cookie.txt'), path.join(process.cwd(), 'cookie.txt')];
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
          if (!path.isAbsolute(fp)) fp = path.join(ROOT_DIR, fp);
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

    return parts.filter(Boolean).join('\n\n');
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
    return parts.join('\n\n');
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
    const at = this.atToken;
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
        toolCalls.push({
          id: 'call_' + crypto.randomBytes(6).toString('hex'),
          type: 'function',
          function: {
            name: data.name,
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

      const agent = new https.Agent({
        keepAlive: true,
        createConnection: (options, callback) => {
          const connectOpts = {
            host: proxyHost,
            port: proxyPort,
            method: 'CONNECT',
            path: `${GOOGLE_HOST}:443`,
            headers: {
              Host: `${GOOGLE_HOST}:443`,
              'Proxy-Connection': 'Keep-Alive',
            },
          };
          if (u.username || u.password) {
            const creds = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
            connectOpts.headers['Proxy-Authorization'] = `Basic ${creds}`;
          }

          const httpModule = isHttpsProxy ? https : http;
          const req = httpModule.request(connectOpts);
          req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
              return callback(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
            }
            const tlsSocket = tls.connect({
              socket,
              servername: GOOGLE_HOST,
            }, () => callback(null, tlsSocket));
            tlsSocket.on('error', err => callback(err));
          });
          req.on('error', err => callback(err));
          req.end();
        },
      });
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
    try { this._agent?.destroy(); } catch {}
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
  async ensureBlFresh(force = false) {
    if (!force && Date.now() - this._blFetchedAt < 6 * 3600 * 1000) return this.bl;
    await this.fetchLatestBl();
    return this.bl;
  }

  async sendStreamRequest(bodyStr, modelMeta, lang = 'en', opts = {}) {
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

  // Запрос с автолечением: обновляем BL при 405/400 и один раз пробуем снова.
  async sendStreamRequestResilient(bodyStr, modelMeta, lang = 'en', opts = {}) {
    await this.ensureBlFresh();
    try {
      return await this.sendStreamRequest(bodyStr, modelMeta, lang, opts);
    } catch (e) {
      if (e && e.code === 'region_not_supported') throw e;
      if (e && (e.status === 405 || e.status === 400 || e.status === 404)) {
        const fresh = await this.fetchLatestBl();
        if (fresh) {
          try {
            return await this.sendStreamRequest(bodyStr, modelMeta, lang, opts);
          } catch (e2) {
            if (e2 && e2.code === 'region_not_supported') throw e2;
            // дублируем шутдаун исходника, если ретрай тоже мимо
            e2.message = `${e2.message} (BL auto-updated to ${fresh})`;
            throw e2;
          }
        }
      }
      if (e && e.status === 429) {
        e.message = 'Gemini Web rate limited (HTTP 429) — включите temporary_chats или подождите';
      }
      throw e;
    }
  }

  // ---- Streaming Iterator ----

  async *streamResponse(res) {
    let prevText = '';
    let rawAccum = '';
    this._lastUpstreamModel = '';

    for await (const rawLine of sseLines(res)) {
      const line = rawLine.trim();
      let frame;
      try { frame = JSON.parse(line); } catch {
        // Keep the legacy standalone diagnostic, but never scan generated JSON text.
        if (line.startsWith('BardErrorInfo')) {
          if (regionRejection(line)) throw regionError();
          const m = line.match(/BardErrorInfo\s*\[(\d+)\]/);
          if (m && m[1] === '1060') throw regionError(); // LOCATION_REJECTED
          const err = new Error(`Gemini Web upstream rejected request (BardErrorInfo [${m ? m[1] : 'unknown'}])`);
          err.status = 502;
          err.type = 'api_error';
          err.code = 502;
          throw err;
        }
        continue;
      }
      if (!Array.isArray(frame)) continue;

      if (!this._lastUpstreamModel) {
        rawAccum += line + '\n';
        if (rawAccum.length > 200000) rawAccum = rawAccum.slice(-200000);
        const um = this.extractUpstreamModel(rawAccum);
        if (um) {
          this._lastUpstreamModel = um;
          rawAccum = '';
        }
      }

      for (const record of frame) {
        if (!Array.isArray(record) || record[0] !== 'wrb.fr') continue;
        // Ошибочный конверт может приходить с record[2] = null, а сама ошибка —
        // в protobuf Any на record[5] (например BardErrorInfo [1060] при
        // региональной блокировке). Без этой проверки ответ молча терялся.
        if (typeof record[2] !== 'string') {
          const flat = JSON.stringify(record);
          if (flat.includes('BardErrorInfo')) {
            if (regionRejection(flat)) throw regionError();
            const m = flat.match(/BardErrorInfo\D*(\d+)/);
            if (m && m[1] === '1060') throw regionError(); // LOCATION_REJECTED
            throw new Error(`Gemini Web upstream rejected request (BardErrorInfo [${m ? m[1] : 'unknown'}]) — проверьте регион/VPN и куки аккаунта`);
          }
          continue;
        }
        let payload;
        try { payload = JSON.parse(record[2]); } catch { continue; }

        // Inspect error envelopes only: candidate text can quote both the region
        // refusal and BardErrorInfo without being an upstream rejection.
        const metadata = [Array.isArray(payload) ? [...payload.slice(0, 4), ...payload.slice(5)] : null, record.slice(3)];
        const metadataText = JSON.stringify(metadata);
        if (metadataText.includes('BardErrorInfo')) {
          if (regionRejection(metadata)) throw regionError();
          const m = metadataText.match(/BardErrorInfo\s*\[(\d+)\]/);
          if (m && m[1] === '1060') throw regionError(); // LOCATION_REJECTED
          throw new Error(`Gemini Web upstream rejected request (BardErrorInfo [${m ? m[1] : 'unknown'}])`);
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
          for (const part of payload[4]) {
            if (Array.isArray(part) && Array.isArray(part[1])) {
              for (const t of part[1]) {
                if (typeof t === 'string' && t.length > prevText.length) {
                  const delta = t.slice(prevText.length);
                  prevText = t;
                  // Trimming each delta destroys spaces at transport boundaries.
                  if (delta) yield delta;
                }
              }
            }
          }
        }
      }
    }
  }

  // ---- Complete Text Generation ----

  async generate(promptText, modelId = 4, thinkMode = 4, lang, opts = {}) {
    const replyLang = lang || this.detectLangFromText(promptText) || 'en';
    const bodyStr = this.buildPayload(promptText, modelId, thinkMode, replyLang);
    const res = await this.sendStreamRequestResilient(bodyStr, { modelId, thinkMode, hexId: '95a4c0abcba24364' }, replyLang, opts);

    let fullText = '';
    for await (const delta of this.streamResponse(res)) {
      fullText += delta;
    }
    const clean = this.cleanText(fullText);
    if (!clean) {
      const err = new Error('Gemini Web returned an empty response — the session may be expired or the bridge is blocked. Refresh the cookie in Settings & Limits → Gemini 4 Unlock.');
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
    const reqBody = this.buildPayload(prompt, meta.modelId, meta.thinkMode, lang);

    const upstreamRes = await this.sendStreamRequestResilient(reqBody, meta, lang, { signal });
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-' + crypto.randomUUID();

    if (!stream) {
      let fullText = '';
      for await (const delta of this.streamResponse(upstreamRes)) {
        fullText += delta;
      }
      const { cleanText, toolCalls } = this.parseToolCalls(fullText);
      if (!cleanText && !toolCalls.length) {
        const err = new Error('Gemini Web returned an empty response — the session may be expired or the bridge is blocked. Refresh the cookie in Settings & Limits → Gemini 4 Unlock.');
        err.status = 502;
        err.code = 'web_empty_response';
        throw err;
      }
      const upstreamModel = this._lastUpstreamModel || '';

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

    // Read the first delta before committing HTTP headers, so a structured
    // upstream refusal remains a normal HTTP error instead of an SSE 200.
    const iterator = this.streamResponse(upstreamRes)[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) {
      const err = new Error('Gemini Web returned an empty response — the session may be expired or the bridge is blocked. Refresh the cookie in Settings & Limits → Gemini 4 Unlock.');
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
    return null;
  }
}

module.exports = {
  GeminiWebBridge,
  WEB_MODELS,
};

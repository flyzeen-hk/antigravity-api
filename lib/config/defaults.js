'use strict';

/*
 * Дефолты config.json в одном месте.
 *
 * Раньше они жили в server.js (DEFAULT_CONFIG), в Guard, в app.py и в README —
 * и расходились: панель показывала одни лимиты, Guard применял другие.
 * Теперь единственный источник — этот файл.
 */

const agent = require('../agent');
const planner = require('../planner');

// v2: configVersion, network.* как единственный источник DNS/прокси,
// geminiWeb.accounts[] для мультиаккаунта.
const CONFIG_VERSION = 2;

const DEFAULTS = {
  configVersion: CONFIG_VERSION,
  port: 8317,
  host: '127.0.0.1', // '0.0.0.0' — доступ с других устройств локальной сети
  upstreamHost: 'https://daily-cloudcode-pa.googleapis.com',
  // Резервный хост: если primary недоступен по сети (DNS/TCP/TLS),
  // запросы прозрачно уходят сюда. Практика сообщества: daily -> prod.
  upstreamFallbackHost: 'https://cloudcode-pa.googleapis.com',
  // Устаревшее поле: читается как fallback для network.dnsServers.
  dnsServers: [],
  // Единый сетевой слой: прокси, DNS-over-HTTPS, свои DNS-серверы.
  network: {
    proxy: '',
    dohUrl: '',
    dnsServers: [],
    useEnvProxy: true,
    timeoutMs: 30000,
  },
  // Браузерные клиенты (Open WebUI, LibreChat, свои дашборды) ходят на шлюз
  // с другого origin. По умолчанию разрешён только loopback любого порта.
  cors: {
    enabled: true,
    allowAnyOrigin: false,
    origins: [],
  },
  // Бюджет рассуждений. mapReasoningEffort=false по умолчанию: поддержка
  // generationConfig.thinkingConfig зависит от апстрима, поэтому включается
  // осознанно после проверки на своём аккаунте.
  thinking: {
    mapReasoningEffort: false,
    defaultBudget: null,
  },
  // Клиенты с зашитым списком моделей (Roo/Cline) шлют чужие имена.
  // Пусто = прежнее поведение (400 model_namespace_required).
  defaultModel: '',
  userAgent: 'antigravity/1.11.4', // legacy value; start() upgrades it to the official client signature
  apiKey: '', // генерируется автоматически при первом запуске (apikey.txt)
  adminKey: '', // защищает /_* (админка), НЕ выдаётся клиентам моделей
  includeThoughts: false, // true — выдавать рассуждения моделей как reasoning_content
  // Запас к max_tokens клиента: думающие модели тратят бюджет на рассуждения,
  // и при маленьком лимите видимого текста не остаётся. 0 отключает запас.
  outputHeadroomTokens: 256,
  requestTimeoutMs: 600000,
  retries: 2,
  // Разблокировка моделей Gemini 4 через веб-шлюз Google
  geminiWeb: {
    enabled: true,
    cookie: '', // cookie строка или путь к cookie.txt (открывает Gemini 4 Pro)
    proxy: '', // e.g. http://127.0.0.1:7890 (опционально)
    bl: 'boq_assistant-bard-web-server_20260716.08_p0',
    accountLabel: '', // подпись веб-аккаунта (напр. «личный Pro»)
    // Мультиаккаунт: [{ name, cookie|cookie_file, authUser, proxy, label }].
    // Пусто = одиночная cookie выше (обратная совместимость).
    accounts: [],
    activeAccount: '',
    autoRotateOn429: false,
    // Сколько символов истории уходит в веб-протокол: транскрипт растёт линейно
    // и напрямую превращается в задержку первого токена.
    historyMaxChars: 60000,
    // С cookie Google требует XSRF-токен at со страницы /app.
    xsrf: true,
    defaultModel: '',
  },
  // Опциональный Safe Mode guard (выключен по умолчанию)
  safeMode: {
    enabled: false,
    maxRequestsPerMinute: 60,
    maxRequestsPerHour: 600,
    maxRequestsPerDay: 3000,
    maxTokensPerDay: 50000000,
    maxRequestsPerWeek: 20000,
    maxTokensPerWeek: 200000000,
    minIntervalMs: 200,
    jitterMs: 100,
    maxConcurrent: 4,
    cooldownAfter429Ms: 30000,
    maxCooldownMs: 300000,
  },
  // Встроенные агентные файловые инструменты (lib/agent.js)
  agent: { ...agent.DEFAULTS, planner: { ...planner.DEFAULT_SETTINGS } },
};

module.exports = { CONFIG_VERSION, DEFAULTS };

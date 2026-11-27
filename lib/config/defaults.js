'use strict';

/*
 * Единый источник дефолтов config.json (v2).
 */

const agent = require('../agent');
const planner = require('../planner');

const CONFIG_VERSION = 2;

const DEFAULTS = {
  configVersion: CONFIG_VERSION,
  port: 8317,
  host: '127.0.0.1',
  upstreamHost: 'https://daily-cloudcode-pa.googleapis.com',
  upstreamFallbackHost: 'https://cloudcode-pa.googleapis.com',
  dnsServers: [],
  network: {
    proxy: '',
    dohUrl: '',
    dnsServers: [],
    useEnvProxy: true,
    timeoutMs: 30000,
  },
  cors: {
    enabled: true,
    allowAnyOrigin: false,
    origins: [],
  },
  thinking: {
    mapReasoningEffort: false,
    defaultBudget: null,
  },
  defaultModel: '',
  userAgent: 'antigravity/2.29.0',
  apiKey: '',
  adminKey: '',
  includeThoughts: false,
  outputHeadroomTokens: 256,
  requestTimeoutMs: 600000,
  retries: 2,
  theme: 'dark',
  language: 'ru',
  autoStartServer: false,
  geminiWeb: {
    enabled: true,
    cookie: '',
    cookie_file: '',
    proxy: '',
    bl: 'boq_assistant-bard-web-server_20260716.08_p0',
    accountLabel: '',
    authUser: null,
    atToken: '',
    temporaryChats: false,
    thinkMode: null,
    accounts: [],
    activeAccount: '',
    autoRotateOn429: false,
    historyMaxChars: 60000,
    xsrf: true,
    defaultModel: '',
  },
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
  agent: { ...agent.DEFAULTS, planner: { ...planner.DEFAULT_SETTINGS } },
};

module.exports = { CONFIG_VERSION, DEFAULTS };

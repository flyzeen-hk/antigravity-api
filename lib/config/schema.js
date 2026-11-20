'use strict';

const agent = require('../agent');
const planner = require('../planner');
const { CONFIG_VERSION, DEFAULTS } = require('./defaults');

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Глубокий мерж: объекты сливаются, массивы и примитивы заменяются.
// Неизвестные ключи сохраняются — пользовательский конфиг не «худеет».
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

// v1 -> v2: dnsServers переезжает в network.dnsServers, agent.autoAgent
// удаляется, allowWebAgent становится строгим boolean.
function migrate(raw) {
  // База — DEFAULTS, сверху пользовательский файл. Без этого пропущенные в
  // файле ключи (upstreamHost, userAgent, requestTimeoutMs) оставались
  // undefined, и шлюз после первого запуска не знал, куда идти.
  const out = deepMerge(deepMerge({}, DEFAULTS), isPlainObject(raw) ? raw : {});
  if (!isPlainObject(out.network)) out.network = {};
  const legacyDns = Array.isArray(out.dnsServers) ? out.dnsServers : [];
  if (!Array.isArray(out.network.dnsServers) || !out.network.dnsServers.length) {
    if (legacyDns.length) out.network.dnsServers = legacyDns.slice();
  }
  if (isPlainObject(out.agent)) {
    delete out.agent.autoAgent;
    out.agent.allowWebAgent = out.agent.allowWebAgent === true;
  }
  const version = Number(out.configVersion);
  out.configVersion = Number.isInteger(version) && version > 0
    ? Math.max(version, CONFIG_VERSION) : CONFIG_VERSION;
  return out;
}

function normalizeAccounts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const accounts = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const name = String(item.name || '').trim().slice(0, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const cookieFile = typeof item.cookie_file === 'string' ? item.cookie_file
      : (typeof item.cookieFile === 'string' ? item.cookieFile : '');
    accounts.push({
      name,
      cookie: typeof item.cookie === 'string' ? item.cookie : '',
      cookie_file: cookieFile,
      authUser: Number.isInteger(item.authUser) ? item.authUser : null,
      proxy: typeof item.proxy === 'string' ? item.proxy : '',
      label: typeof item.label === 'string' ? item.label : '',
      thinkMode: item.thinkMode === 'extended' || item.thinkMode === 'default' ? item.thinkMode : null,
      temporaryChats: item.temporaryChats === true,
    });
  }
  return accounts;
}

function normalizeAgent(rawAgent) {
  const a = isPlainObject(rawAgent) ? rawAgent : {};
  const out = { ...agent.DEFAULTS, ...a };
  delete out.autoAgent;
  out.enabled = out.enabled !== false;
  // Опасные флаги: только явный true, только из файла.
  out.allowDelete = out.allowDelete === true;
  out.allowShell = out.allowShell === true;
  out.allowAbsolutePaths = out.allowAbsolutePaths === true;
  out.allowWebAgent = out.allowWebAgent === true;
  out.workspaceRoot = typeof out.workspaceRoot === 'string' ? out.workspaceRoot : '';
  out.auditFile = typeof out.auditFile === 'string' ? out.auditFile : '';
  out.maxIterations = clampNumber(out.maxIterations, 1, 24, agent.DEFAULTS.maxIterations);
  out.maxReadBytes = clampNumber(out.maxReadBytes, 1024, 1024 * 1024, agent.DEFAULTS.maxReadBytes);
  out.maxWriteBytes = clampNumber(out.maxWriteBytes, 1024, 8 * 1024 * 1024, agent.DEFAULTS.maxWriteBytes);
  out.maxListEntries = clampNumber(out.maxListEntries, 1, 5000, agent.DEFAULTS.maxListEntries);
  out.shellTimeoutMs = clampNumber(out.shellTimeoutMs, 1000, 600000, agent.DEFAULTS.shellTimeoutMs);
  out.auditRotateBytes = clampNumber(out.auditRotateBytes, 64 * 1024, 512 * 1024 * 1024, agent.DEFAULTS.auditRotateBytes);
  out.planner = { ...planner.DEFAULT_SETTINGS, ...(isPlainObject(a.planner) ? a.planner : {}) };
  out.planner.enabled = out.planner.enabled !== false;
  out.planner.maxCalls = clampNumber(out.planner.maxCalls, 0, 10, planner.DEFAULT_SETTINGS.maxCalls);
  out.planner.timeoutMs = clampNumber(out.planner.timeoutMs, 1000, 180000, planner.DEFAULT_SETTINGS.timeoutMs);
  return out;
}

function normalizeWeb(rawWeb) {
  const out = deepMerge(DEFAULTS.geminiWeb, isPlainObject(rawWeb) ? rawWeb : {});
  out.accounts = normalizeAccounts(out.accounts);
  out.historyMaxChars = clampNumber(out.historyMaxChars, 4000, 400000, DEFAULTS.geminiWeb.historyMaxChars);
  out.temporaryChats = out.temporaryChats === true;
  out.enabled = out.enabled !== false;
  out.xsrf = out.xsrf !== false;
  out.autoRotateOn429 = out.autoRotateOn429 === true;
  out.defaultModel = String(out.defaultModel || '').trim();
  const wanted = String(out.activeAccount || '').trim();
  const found = out.accounts.find((a) => a.name === wanted);
  out.activeAccount = found ? found.name : (out.accounts[0] ? out.accounts[0].name : '');
  return out;
}

function normalizeSafeMode(rawSafe) {
  const out = deepMerge(DEFAULTS.safeMode, isPlainObject(rawSafe) ? rawSafe : {});
  out.enabled = out.enabled === true;
  for (const key of ['maxRequestsPerMinute', 'maxRequestsPerHour', 'maxRequestsPerDay',
    'maxRequestsPerWeek', 'minIntervalMs', 'jitterMs', 'maxConcurrent']) {
    out[key] = clampNumber(out[key], key === 'minIntervalMs' || key === 'jitterMs' ? 0 : 1,
      10_000_000, DEFAULTS.safeMode[key]);
  }
  for (const key of ['maxTokensPerDay', 'maxTokensPerWeek', 'cooldownAfter429Ms', 'maxCooldownMs']) {
    out[key] = clampNumber(out[key], 0, 1_000_000_000_000, DEFAULTS.safeMode[key]);
  }
  return out;
}

/*
 * Полная нормализация. Возвращает { config, warnings }.
 * warnings — то, что было молча починено (панель может показать).
 */
function normalize(raw) {
  const warnings = [];
  const merged = migrate(raw);

  const port = clampNumber(merged.port, 1, 65535, DEFAULTS.port);
  if (Number(merged.port) !== port) warnings.push(`port: некорректное значение, использую ${port}`);
  merged.port = port;
  merged.host = typeof merged.host === 'string' && merged.host.trim() ? merged.host.trim() : DEFAULTS.host;
  merged.requestTimeoutMs = clampNumber(merged.requestTimeoutMs, 5000, 900000, DEFAULTS.requestTimeoutMs);
  merged.retries = clampNumber(merged.retries, 0, 5, DEFAULTS.retries);

  merged.network = deepMerge(DEFAULTS.network, isPlainObject(merged.network) ? merged.network : {});
  merged.network.dnsServers = (Array.isArray(merged.network.dnsServers) ? merged.network.dnsServers : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  merged.dnsServers = Array.isArray(merged.dnsServers) ? merged.dnsServers.slice() : [];

  merged.cors = deepMerge(DEFAULTS.cors, isPlainObject(merged.cors) ? merged.cors : {});
  merged.cors.origins = (Array.isArray(merged.cors.origins) ? merged.cors.origins : [])
    .map((s) => String(s || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);

  merged.thinking = deepMerge(DEFAULTS.thinking, isPlainObject(merged.thinking) ? merged.thinking : {});
  merged.thinking.mapReasoningEffort = merged.thinking.mapReasoningEffort === true;
  merged.thinking.defaultBudget = merged.thinking.defaultBudget == null
    ? null : clampNumber(merged.thinking.defaultBudget, 0, 65536, null);

  merged.geminiWeb = normalizeWeb(merged.geminiWeb);
  merged.safeMode = normalizeSafeMode(merged.safeMode);
  merged.agent = normalizeAgent(merged.agent);

  merged.defaultModel = typeof merged.defaultModel === 'string' ? merged.defaultModel.trim() : '';
  merged.includeThoughts = merged.includeThoughts === true;

  return { config: merged, warnings };
}

module.exports = {
  isPlainObject,
  clampNumber,
  deepMerge,
  migrate,
  normalize,
  normalizeAccounts,
};

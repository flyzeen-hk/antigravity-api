'use strict';

const { isPlainObject, deepMerge, normalize } = require('./schema');

// Секреты и опасные флаги ОС-исполнения/удаления НИКОГДА не принимаются из HTTP:
// защищённый adminKey доступ разрешает менять настройки маршрутизации и агента
// (включая agent.enabled, port/host с перезапуском), но allowDelete/allowShell/
// allowAbsolutePaths/auditFile меняются только вручную в config.json.
const FORBIDDEN_PATCH_KEYS = new Set([
  'apiKey', 'adminKey', 'upstreamHost', 'upstreamFallbackHost',
  'userAgent', 'requestTimeoutMs',
  'agent.allowDelete', 'agent.allowShell', 'agent.allowAbsolutePaths',
  'agent.auditFile',
]);

// Разрешённые для PATCH / POST /_config пути.
const PATCH_WHITELIST = {
  safeMode: ['enabled', 'maxRequestsPerMinute', 'maxRequestsPerHour', 'maxRequestsPerDay',
    'maxTokensPerDay', 'maxRequestsPerWeek', 'maxTokensPerWeek', 'minIntervalMs', 'jitterMs',
    'maxConcurrent', 'cooldownAfter429Ms', 'maxCooldownMs'],
  geminiWeb: ['enabled', 'cookie', 'cookie_file', 'cookieFile', 'proxy', 'temporaryChats',
    'thinkMode', 'accountLabel', 'authUser', 'atToken', 'bl', 'accounts', 'activeAccount',
    'autoRotateOn429', 'historyMaxChars', 'xsrf', 'defaultModel'],
  network: ['proxy', 'dohUrl', 'dnsServers', 'useEnvProxy', 'timeoutMs'],
  agent: ['enabled', 'allowWebAgent', 'workspaceRoot', 'maxIterations', 'maxReadBytes', 'maxWriteBytes',
    'maxListEntries', 'shellTimeoutMs', 'auditRotateBytes', 'planner'],
  cors: ['enabled', 'allowAnyOrigin', 'origins'],
  thinking: ['mapReasoningEffort', 'defaultBudget'],
  port: null,
  host: null,
  defaultModel: null,
  includeThoughts: null,
  outputHeadroomTokens: null,
  retries: null,
  dnsServers: null,
  theme: null,
  language: null,
  autoStartServer: null,
};

function isForbiddenPath(p) {
  if (FORBIDDEN_PATCH_KEYS.has(p)) return true;
  const root = p.split('.')[0];
  return FORBIDDEN_PATCH_KEYS.has(root);
}

function patchConfig(current, patch) {
  const base = isPlainObject(current) ? current : {};
  const applied = [];
  const ignored = [];
  const safe = {};

  for (const [root, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
    const allowed = Object.prototype.hasOwnProperty.call(PATCH_WHITELIST, root)
      ? PATCH_WHITELIST[root] : undefined;
    if (allowed === undefined) {
      ignored.push(root);
      continue;
    }
    if (allowed === null) {
      if (isForbiddenPath(root)) { ignored.push(root); continue; }
      safe[root] = value;
      applied.push(root);
      continue;
    }
    if (!isPlainObject(value)) { ignored.push(root); continue; }
    const currentSection = isPlainObject(base[root]) ? base[root] : {};
    const picked = {};
    for (const [key, sub] of Object.entries(value)) {
      const p = `${root}.${key}`;
      if (allowed.includes(key) && !isForbiddenPath(p)) {
        const targetKey = (root === 'geminiWeb' && key === 'cookieFile') ? 'cookie_file' : key;
        picked[targetKey] = sub;
        applied.push(p);
      } else {
        ignored.push(p);
      }
    }
    if (Object.keys(picked).length) safe[root] = { ...currentSection, ...picked };
  }

  const merged = deepMerge(base, safe);
  if (isPlainObject(base.agent) && isPlainObject(merged.agent)) {
    merged.agent = {
      ...merged.agent,
      allowDelete: base.agent.allowDelete === true,
      allowShell: base.agent.allowShell === true,
      allowAbsolutePaths: base.agent.allowAbsolutePaths === true,
      auditFile: base.agent.auditFile,
    };
  }
  const { config, warnings } = normalize(merged);
  return { config, applied, ignored, warnings };
}

module.exports = { PATCH_WHITELIST, FORBIDDEN_PATCH_KEYS, patchConfig };

'use strict';

const { isPlainObject, deepMerge, normalize } = require('./schema');

// Опасные флаги и секреты: НИКОГДА не принимаются из HTTP-запроса.
// Раньше POST /_config писал { ...agent.DEFAULTS, ...prev, ...incoming } и через
// него можно было включить allowShell/allowAbsolutePaths на ходу, а заодно
// подменить network.proxy (и получить OAuth-токен Google на свой сервер).
const FORBIDDEN_PATCH_KEYS = new Set([
  'apiKey', 'adminKey', 'port', 'host', 'upstreamHost', 'upstreamFallbackHost',
  'userAgent', 'requestTimeoutMs',
  'agent.allowDelete', 'agent.allowShell', 'agent.allowAbsolutePaths',
  'agent.auditFile', 'agent.enabled',
]);

// Что вообще разрешено менять на лету через POST /_config.
// null = примитив/массив, принимается целиком.
const PATCH_WHITELIST = {
  safeMode: ['enabled', 'maxRequestsPerMinute', 'maxRequestsPerHour', 'maxRequestsPerDay',
    'maxTokensPerDay', 'maxRequestsPerWeek', 'maxTokensPerWeek', 'minIntervalMs', 'jitterMs',
    'maxConcurrent', 'cooldownAfter429Ms', 'maxCooldownMs'],
  geminiWeb: ['enabled', 'cookie', 'cookie_file', 'cookieFile', 'proxy', 'temporaryChats',
    'thinkMode', 'accountLabel', 'authUser', 'atToken', 'bl', 'accounts', 'activeAccount',
    'autoRotateOn429', 'historyMaxChars', 'xsrf', 'defaultModel'],
  network: ['proxy', 'dohUrl', 'dnsServers', 'useEnvProxy', 'timeoutMs'],
  agent: ['allowWebAgent', 'workspaceRoot', 'maxIterations', 'maxReadBytes', 'maxWriteBytes',
    'maxListEntries', 'shellTimeoutMs', 'auditRotateBytes', 'planner'],
  cors: ['enabled', 'allowAnyOrigin', 'origins'],
  thinking: ['mapReasoningEffort', 'defaultBudget'],
  defaultModel: null,
  includeThoughts: null,
  retries: null,
  dnsServers: null,
};

function isForbiddenPath(path) {
  if (FORBIDDEN_PATCH_KEYS.has(path)) return true;
  const root = path.split('.')[0];
  return FORBIDDEN_PATCH_KEYS.has(root);
}

/*
 * Применяет патч настроек к текущему конфигу.
 * Возвращает { config, applied, ignored, warnings }.
 * ignored перечисляет отклонённые пути — панель и клиент видят ровно то,
 * что произошло, вместо молчаливого «настройки сохранены».
 */
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
      const path = `${root}.${key}`;
      if (allowed.includes(key) && !isForbiddenPath(path)) {
        picked[key] = sub;
        applied.push(path);
      } else {
        ignored.push(path);
      }
    }
    if (Object.keys(picked).length) safe[root] = { ...currentSection, ...picked };
  }

  const merged = deepMerge(base, safe);
  // Опасные флаги агента всегда берём из текущего (файлового) конфига.
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

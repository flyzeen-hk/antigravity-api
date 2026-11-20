'use strict';

/*
 * Фасад конфигурации: дефолты, нормализация, миграции и безопасный патч.
 * Все места (server.js, /_config, тесты) обязаны идти через этот модуль,
 * иначе снова появятся четыре разных мержа.
 */

const { CONFIG_VERSION, DEFAULTS } = require('./config/defaults');
const { isPlainObject, clampNumber, deepMerge, migrate, normalize } = require('./config/schema');
const { PATCH_WHITELIST, FORBIDDEN_PATCH_KEYS, patchConfig } = require('./config/patch');

module.exports = {
  CONFIG_VERSION,
  DEFAULTS,
  PATCH_WHITELIST,
  FORBIDDEN_PATCH_KEYS,
  isPlainObject,
  clampNumber,
  deepMerge,
  migrate,
  normalize,
  patchConfig,
};

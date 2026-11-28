'use strict';

/*
 * Единый источник истины по провайдерам моделей.
 *
 * Модели жёстко разделены префиксом:
 *   cloud/<model-id>  — Google Antigravity / Cloud Code (OAuth, квоты в %)
 *   web/<alias>       — Gemini Web bridge (cookies, без нативных tools)
 *
 * Суффикс -agent срезается после префикса: cloud/<id>-agent, web/<alias>-agent.
 */

const { WEB_MODELS } = require('./web_bridge');

const CLOUD = 'cloud';
const WEB = 'web';
const NAMESPACES = [CLOUD, WEB];
const AGENT_SUFFIX = '-agent';
const EXAMPLES = ['cloud/gemini-3-flash', 'web/gemini-4-argon', 'cloud/gemini-3-flash-agent'];

function webAliases() {
  return Object.keys(WEB_MODELS);
}

function isKnownWebAlias(id) {
  return Object.prototype.hasOwnProperty.call(WEB_MODELS, String(id || '').toLowerCase());
}

function failure(code, message, examples = EXAMPLES) {
  return {
    ok: false,
    status: 400,
    code,
    message,
    hint: { examples },
  };
}

function formatModel(namespace, id, { agent = false } = {}) {
  return `${namespace}/${id}${agent ? AGENT_SUFFIX : ''}`;
}

function parseModel(input, opts = {}) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    return failure('model_required', 'Model id is required. Use cloud/<model-id> or web/<alias>.');
  }

  const slash = raw.indexOf('/');
  if (slash <= 0) {
    return failure(
      'model_namespace_required',
      `Model "${raw}" must be namespaced. Use cloud/<model-id> or web/<alias>.`,
    );
  }

  const namespace = raw.slice(0, slash).toLowerCase();
  let id = raw.slice(slash + 1);

  if (!NAMESPACES.includes(namespace)) {
    return failure(
      'model_namespace_invalid',
      `Unknown provider namespace "${namespace}". Use "cloud" or "web".`,
    );
  }
  if (!id || id.length > 200 || /[\s/\\]/.test(id)) {
    return failure('model_not_found', `Invalid model id "${raw}".`);
  }

  let agentRequested = false;
  if (id.endsWith(AGENT_SUFFIX) && id.length > AGENT_SUFFIX.length) {
    agentRequested = true;
    id = id.slice(0, -AGENT_SUFFIX.length);
  }

  if (namespace === WEB) {
    const alias = id.toLowerCase();
    const checkWeb = typeof opts.isWebAlias === 'function' ? opts.isWebAlias : isKnownWebAlias;
    const listWeb = typeof opts.webAliases === 'function' ? opts.webAliases : webAliases;
    if (!checkWeb(alias)) {
      return failure(
        'model_not_found',
        `Unknown web model "${raw}".`,
        listWeb().map((a) => `web/${a}`),
      );
    }
    id = alias;
  }

  return {
    ok: true,
    namespace,
    id,
    baseId: id,
    agentRequested,
    displayId: formatModel(namespace, id, { agent: agentRequested }),
  };
}

function describeModel(namespace, { bridgeEnabled = true } = {}) {
  if (namespace === CLOUD) {
    return {
      provider: CLOUD,
      tools: 'native',
      streaming: true,
      thinking: true,
      quota: 'cloud-code',
      reliability: 'high',
      warnings: [],
    };
  }

  return {
    provider: WEB,
    tools: 'emulated',
    streaming: true,
    thinking: true,
    quota: 'web-session',
    reliability: 'very-low',
    warnings: [
      'Gemini Web has no native tool calling: agent mode is text-protocol emulation and is VERY unreliable (length-capped replies). Short tasks only.',
    ],
    bridgeEnabled: !!bridgeEnabled,
  };
}

function groupModels(models = []) {
  const groups = { cloud: [], web: [] };
  for (const model of models) {
    const id = typeof model === 'string' ? model : model && model.id;
    const bucket = typeof id === 'string' && id.startsWith(WEB + '/') ? WEB : CLOUD;
    groups[bucket].push(model);
  }
  return groups;
}

module.exports = {
  CLOUD,
  WEB,
  NAMESPACES,
  AGENT_SUFFIX,
  EXAMPLES,
  webAliases,
  isKnownWebAlias,
  parseModel,
  formatModel,
  describeModel,
  groupModels,
};

'use strict';

/*
 * Тесты namespace-моделей (lib/providers.js) — без сети.
 * Жёсткие префиксы cloud/ и web/, суффикс -agent, capabilities.
 */

const providers = require('../lib/providers');
const { GeminiWebBridge } = require('../lib/web_bridge');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok ', name); }
  else { failed++; console.error('  FAIL', name); }
}

console.log('== 1. cloud/*');
let p = providers.parseModel('cloud/gemini-3-flash');
ok(p.ok && p.namespace === 'cloud' && p.baseId === 'gemini-3-flash' && !p.agentRequested, 'cloud plain');
ok(p.displayId === 'cloud/gemini-3-flash', 'cloud displayId');

p = providers.parseModel('cloud/gemini-3-flash-agent');
ok(p.ok && p.baseId === 'gemini-3-flash' && p.agentRequested, 'cloud -agent');
ok(p.displayId === 'cloud/gemini-3-flash-agent', 'cloud agent displayId');

console.log('== 2. web/*');
p = providers.parseModel('web/gemini-4-argon');
ok(p.ok && p.namespace === 'web' && p.baseId === 'gemini-4-argon', 'web alias');

p = providers.parseModel('web/gemini-4-argon-thinking-agent');
ok(p.ok && p.baseId === 'gemini-4-argon-thinking' && p.agentRequested, 'web -agent');

p = providers.parseModel('WEB/Gemini-4-Argon');
ok(p.ok && p.namespace === 'web' && p.baseId === 'gemini-4-argon', 'case-insensitive alias');

console.log('== 3. Ошибки namespace');
ok(!providers.parseModel('gemini-3-flash').ok, 'плоское имя отклонено');
ok(providers.parseModel('gemini-3-flash').code === 'model_namespace_required', 'code model_namespace_required');
ok(providers.parseModel('api/gemini-3-flash').code === 'model_namespace_invalid', 'code model_namespace_invalid');
ok(providers.parseModel('').code === 'model_required', 'empty model');
ok(providers.parseModel('cloud/').code === 'model_not_found', 'empty id');
ok(providers.parseModel('cloud/a/b').code === 'model_not_found', 'slash inside id');
ok(providers.parseModel('web/gemini-4-garbage').code === 'model_not_found', 'unknown web alias');
ok(Array.isArray(providers.parseModel('web/gemini-4-garbage').hint.examples), 'hint с примерами');

console.log('== 4. web_bridge ужесточён');
const bridge = new GeminiWebBridge({ enabled: true });
ok(bridge.isWebModelName('gemini-4-argon') === true, 'точный алиас распознан');
ok(bridge.isWebModelName('gemini-4-garbage') === false, 'catch-all убран');
ok(bridge.isWebModelName('gemini-web') === false, 'gemini-web больше не алиас');
let threw = false;
try { bridge.getModelMeta('gemini-4-garbage'); } catch { threw = true; }
ok(threw, 'getModelMeta бросает на неизвестный алиас');
const list = bridge.getModelsList();
ok(list.length === 6, 'каталог: 6 веб-моделей');
ok(list.every((m) => typeof m.display_name === 'string' && m.display_name), 'display_name заполнен');
ok(list.every((m) => typeof m.displayName === 'string'), 'displayName сохранён');

console.log('== 5. describeModel / groupModels');
const cloudCaps = providers.describeModel('cloud');
const webCaps = providers.describeModel('web', { bridgeEnabled: true });
ok(cloudCaps.tools === 'native' && cloudCaps.reliability === 'high', 'cloud capabilities');
ok(webCaps.tools === 'emulated' && webCaps.reliability === 'very-low', 'web capabilities');
ok(webCaps.warnings.length > 0, 'web warning присутствует');
const grouped = providers.groupModels([
  { id: 'cloud/a' }, { id: 'web/b' }, { id: 'cloud/c' },
]);
ok(grouped.cloud.length === 2 && grouped.web.length === 1, 'groupModels buckets');
ok(providers.formatModel('cloud', 'x', { agent: true }) === 'cloud/x-agent', 'formatModel agent');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

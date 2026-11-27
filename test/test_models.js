'use strict';

// ModelCatalog: кэш, stale-while-revalidate, фильтрация служебных моделей,
// история новых/удалённых моделей, planLocked (-disabled), custom-модели и health-check.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ModelCatalog } = require('../lib/models');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

function fakeNetwork(payloads) {
  let calls = 0;
  return {
    get calls() { return calls; },
    fetch: async () => {
      const body = payloads[Math.min(calls, payloads.length - 1)];
      calls++;
      return new Response(JSON.stringify({ models: body }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

const FIRST = {
  'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.5, resetTime: '2026-01-01T00:00:00Z' } },
  'tab_flash_lite_preview': { displayName: 'internal' },
  'chat_20706': { displayName: 'internal' },
  'claude-disabled': { displayName: 'placeholder', disabled: true, tagTitle: 'Paid Pro', tagDescription: 'Pro only' },
  'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxTokens: 200000 },
};
const SECOND = {
  'gemini-3-flash': FIRST['gemini-3-flash'],
  'gemini-4-neon-disabled': { displayName: 'Gemini 4 Neon', disabled: true, tagTitle: 'Paid Pro', tagDescription: 'Pro only' },
  'gemini-3-pro': { displayName: 'Gemini 3 Pro' },
};

(async () => {
  console.log('== 1. Первый запрос тянет каталог, повторный — из кэша');
  const net = fakeNetwork([FIRST, SECOND]);
  const cat = new ModelCatalog('http://upstream', { ttlMs: 60000, network: net });
  const m1 = await cat.list(async () => 'token');
  ok(net.calls === 1, 'один запрос к апстриму');
  ok(m1.has('gemini-3-flash'), 'публичная модель есть');
  ok(!m1.has('tab_flash_lite_preview') && !m1.has('chat_20706'), 'служебные tab_*/chat_* скрыты');
  ok(!m1.has('claude-disabled'), '-disabled заглушки скрыты из активного Map');
  ok(cat.disabledModels.has('claude-disabled'), '-disabled модели сохранены в disabledModels (planLocked)');
  ok(m1.get('gemini-3-flash').quota.percent === 50, 'квота пересчитана в проценты');
  await cat.list(async () => 'token');
  ok(net.calls === 1, 'в пределах ttl апстрим не дёргается');

  console.log('== 2. После ttl отдаётся старый каталог, обновление — в фоне');
  const net2 = fakeNetwork([FIRST, SECOND]);
  const cat2 = new ModelCatalog('http://upstream', { ttlMs: 0, network: net2 });
  const stale = await cat2.list(async () => 'token');
  ok(stale.has('gemini-3-flash'), 'первый ответ получен');
  const t0 = Date.now();
  const staleAgain = await cat2.list(async () => 'token');
  const elapsed = Date.now() - t0;
  ok(staleAgain === stale, 'мгновенно вернулся прошлый каталог, а не новый запрос');
  ok(elapsed < 50, 'ответ не ждёт сеть: ' + elapsed + ' мс');
  await new Promise((r) => setTimeout(r, 50));
  const updated = await cat2.list(async () => 'token');
  ok(updated.has('gemini-3-pro'), 'фоновое обновление доехало до кэша');

  console.log('== 3. Ошибка обновления не ломает выдачу');
  let fail = 0;
  const cat3 = new ModelCatalog('http://upstream', { ttlMs: 60000, network: { fetch: async () => { fail++; throw new Error('network down'); } } });
  await assert.rejects(() => cat3.list(async () => 'token'), /network down/);
  ok(fail === 1, 'ошибка первого запроса пробрасывается наверх');
  const cat4 = new ModelCatalog('http://upstream', { ttlMs: 0, network: { fetch: async () => { throw new Error('down'); } } });
  cat4.cache = { at: 0, models: new Map([['x', { displayName: 'X' }]]) };
  const kept = await cat4.list(async () => 'token');
  ok(kept.has('x'), 'при падении фонового обновления отдаётся старый каталог');
  await new Promise((r) => setTimeout(r, 20));

  console.log('== 4. Реестр known_models.json: новые, убранные, custom и health');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-models-test-'));
  const regFile = path.join(tmpDir, 'known_models.json');
  try {
    const net4 = fakeNetwork([FIRST, SECOND]);
    const cat5 = new ModelCatalog('http://upstream', { ttlMs: 60000, network: net4, registryFile: regFile });
    await cat5.list(async () => 'token');
    await cat5.list(async () => 'token', { force: true });
    const snap = cat5.getCatalogSnapshot();
    ok(snap.diff.added.includes('gemini-3-pro'), 'новая модель зафиксирована в diff.added');
    ok(snap.diff.removed.includes('claude-sonnet-4-6'), 'убранная модель зафиксирована в diff.removed');
    ok(snap.removed.some((m) => m.rawId === 'claude-sonnet-4-6' && m.removedFromCatalog), 'убранная модель сохранена в истории без удаления');
    ok(snap.planLocked.some((m) => m.baseId === 'gemini-4-neon' && m.tagTitle === 'Paid Pro'), 'тарифная модель gemini-4-neon показана в planLocked');

    cat5.addCustomModel('cloud/gemini-4-neon-high', 'Gemini 4 Neon High');
    cat5.recordHealth('cloud/gemini-4-neon-high', { status: 'not_found', httpStatus: 404, ms: 120, error: 'HTTP 404' });
    const catReloaded = new ModelCatalog('http://upstream', { ttlMs: 60000, network: net4, registryFile: regFile });
    ok(catReloaded.getCustomModels().some((m) => m.id === 'gemini-4-neon-high'), 'custom-модель сохраняется на диске');
    ok(catReloaded.getHealth('cloud/gemini-4-neon-high')?.status === 'not_found', 'результат health-check сохраняется на диске');
    catReloaded.removeCustomModel('gemini-4-neon-high');
    ok(catReloaded.getCustomModels().length === 0, 'custom-модель удаляется');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\nИтого: ' + passed + ' ok, ' + failed + ' fail');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

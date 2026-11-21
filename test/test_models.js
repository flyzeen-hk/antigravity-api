'use strict';

// ModelCatalog: кэш, stale-while-revalidate и фильтрация служебных моделей.

const assert = require('assert');
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
  'claude-disabled': { displayName: 'placeholder' },
  'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxTokens: 200000 },
};
const SECOND = { ...FIRST, 'gemini-3-pro': { displayName: 'Gemini 3 Pro' } };

(async () => {
  console.log('== 1. Первый запрос тянет каталог, повторный — из кэша');
  const net = fakeNetwork([FIRST, SECOND]);
  const cat = new ModelCatalog('http://upstream', { ttlMs: 60000, network: net });
  const m1 = await cat.list(async () => 'token');
  ok(net.calls === 1, 'один запрос к апстриму');
  ok(m1.has('gemini-3-flash'), 'публичная модель есть');
  ok(!m1.has('tab_flash_lite_preview') && !m1.has('chat_20706'), 'служебные tab_*/chat_* скрыты');
  ok(!m1.has('claude-disabled'), '-disabled заглушки скрыты');
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

  console.log('\nИтого: ' + passed + ' ok, ' + failed + ' fail');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

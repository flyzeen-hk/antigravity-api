'use strict';

/*
 * Unit-тесты гибридного планировщика (lib/planner.js) без сети:
 *   1. available(): enabled, валидный web-алиас, состояние моста.
 *   2. call(): консультантский промпт, mode, stats.
 *   3. maxCalls и timeoutMs.
 *   4. Ошибки возвращаются как результат инструмента и не бросаются наружу.
 */

const assert = require('assert/strict');
const { createPlanner, DEFAULT_SETTINGS, PLANNER_TOOL_SPEC } = require('../lib/planner');

let passed = 0;
function ok(name) {
  passed++;
  console.log('  ok  ' + name);
}

function fakeBridge({ enabled = true, answer = 'план: 1) прочитать 2) записать 3) проверить', delayMs = 0, error = null } = {}) {
  const calls = [];
  return {
    enabled,
    calls,
    getModelMeta(name) {
      assert.equal(name, 'gemini-4-argon-thinking');
      return { modelId: 8, thinkMode: 0 };
    },
    async generate(prompt, modelId, thinkMode) {
      calls.push({ prompt, modelId, thinkMode });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (error) throw error;
      return answer;
    },
  };
}

(async () => {
  console.log('== 1. available()');
  assert.equal(PLANNER_TOOL_SPEC.function.name, 'ask_planner');
  assert.ok(PLANNER_TOOL_SPEC.function.parameters.required.includes('question'));

  let p = createPlanner({ bridge: fakeBridge(), settings: DEFAULT_SETTINGS });
  assert.equal(p.available(), true);
  ok('доступен при включённом мосте и валидном web-алиасе');

  p = createPlanner({ bridge: fakeBridge({ enabled: false }), settings: DEFAULT_SETTINGS });
  assert.equal(p.available(), false);
  const off = await p.call({ question: 'q', mode: 'plan' });
  assert.equal(off.ok, false);
  assert.match(off.error, /недоступен/i);
  ok('выключенный мост: available=false и безопасный результат вместо throw');

  p = createPlanner({ bridge: fakeBridge(), settings: { ...DEFAULT_SETTINGS, enabled: false } });
  assert.equal(p.available(), false);
  ok('planner.enabled=false выключает консультанта');

  p = createPlanner({ bridge: fakeBridge(), settings: { ...DEFAULT_SETTINGS, model: 'cloud/gemini-3-flash' } });
  assert.equal(p.available(), false);
  ok('cloud/ модель не принимается как планировщик');

  p = createPlanner({ bridge: fakeBridge(), settings: { ...DEFAULT_SETTINGS, model: 'web/gemini-9-nope' } });
  assert.equal(p.available(), false);
  ok('неизвестный web-алиас отключает planner');

  console.log('== 2. call()');
  const bridge = fakeBridge();
  p = createPlanner({ bridge, settings: DEFAULT_SETTINGS });
  const res = await p.call({ question: 'Как разбить файл на чанки?', mode: 'advice', context: 'файл 20 КБ' });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'advice');
  assert.ok(res.advice.startsWith('план:'));
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].modelId, 8);
  assert.equal(bridge.calls[0].thinkMode, 0);
  assert.match(bridge.calls[0].prompt, /How do you split|Как разбить/);
  assert.match(bridge.calls[0].prompt, /Do NOT output tool calls/);
  assert.match(bridge.calls[0].prompt, /файл 20 КБ/);
  assert.equal(p.stats().calls, 1);
  assert.equal(p.stats().errors, 0);
  assert.ok(p.stats().ms >= 0);
  ok('промпт, mode, meta модели и stats корректны');

  const invalidMode = await p.call({ question: 'q', mode: 'hack' });
  assert.equal(invalidMode.ok, true);
  assert.equal(invalidMode.mode, 'advice');
  ok('неизвестный mode деградирует до advice');

  const fresh = createPlanner({ bridge: fakeBridge(), settings: DEFAULT_SETTINGS });
  const empty = await fresh.call({ question: '   ', mode: 'plan' });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /question/i);
  assert.equal(fresh.stats().calls, 0, 'пустой вопрос не расходует лимит');
  ok('пустой question отклоняется без расхода лимита');

  console.log('== 3. maxCalls и timeout');
  const limited = createPlanner({ bridge: fakeBridge(), settings: { ...DEFAULT_SETTINGS, maxCalls: 2 } });
  assert.equal((await limited.call({ question: '1', mode: 'plan' })).ok, true);
  assert.equal((await limited.call({ question: '2', mode: 'plan' })).ok, true);
  const third = await limited.call({ question: '3', mode: 'plan' });
  assert.equal(third.ok, false);
  assert.match(third.error, /Лимит вызовов/);
  assert.equal(limited.stats().calls, 2);
  ok('maxCalls ограничивает число консультаций на запрос');

  const slowBridge = fakeBridge({ delayMs: 6000 });
  const timed = createPlanner({ bridge: slowBridge, settings: { ...DEFAULT_SETTINGS, timeoutMs: 5000 } });
  const t0 = Date.now();
  const timeoutResult = await timed.call({ question: 'долго', mode: 'plan' });
  const elapsed = Date.now() - t0;
  assert.equal(timeoutResult.ok, false);
  assert.match(timeoutResult.error, /таймаут 5000/);
  assert.ok(elapsed >= 4500 && elapsed < 5900, `timeout должен сработать около 5с, прошло ${elapsed}мс`);
  assert.equal(timed.stats().errors, 1);
  ok('timeoutMs возвращает ошибку результатом инструмента');

  console.log('== 4. ошибки транспорта');
  const failing = createPlanner({ bridge: fakeBridge({ error: new Error('network down') }), settings: DEFAULT_SETTINGS });
  const failed = await failing.call({ question: 'q', mode: 'review' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /network down/);
  assert.equal(failing.stats().errors, 1);
  assert.equal(failing.stats().calls, 1);
  ok('исключение моста превращается в {ok:false}');

  console.log(`\nPLANNER TESTS PASSED: ${passed}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

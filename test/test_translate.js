'use strict';

/*
 * Юнит-тесты lib/translate.js (OpenAI <-> Gemini) без сети.
 * Запуск: node test/test_translate.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_SIG_FILE = path.join(os.tmpdir(), 'ag_thought_signatures.json');
const SIG_FILE = path.join(os.tmpdir(), `ag-test-sigs-${process.pid}.json`);
process.env.AG_SIG_FILE = SIG_FILE;
const { removeTree } = require('../lib/safe_files');
process.on('exit', () => removeTree(SIG_FILE));

const {
  openAIToGeminiRequest, geminiToOpenAIResponse, GeminiStreamToOpenAI, mapFinish, mapUsage,
  sanitizeGeminiSchema, recordThoughtSignature, getThoughtSignature,
} = require('../lib/translate');

const fileStamp = (f) => {
  try {
    const s = fs.statSync(f);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
};
const realSigBefore = fileStamp(REAL_SIG_FILE);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });

(async () => {
  console.log('== translate: запрос');

  await test('параллельные tool-ответы -> один user-ход, порядок и имена сохранены', () => {
    const req = openAIToGeminiRequest({ messages: [
      { role: 'user', content: 'погода и время?' },
      { role: 'assistant', content: null, tool_calls: [call('c1', 'get_weather', '{"city":"Москва"}'), call('c2', 'get_time', '{}')] },
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":-5}' },
      { role: 'tool', tool_call_id: 'c2', content: '12:00' },
    ] });
    assert.deepStrictEqual(req.contents.map((c) => c.role), ['user', 'model', 'user']);
    assert.strictEqual(req.contents[1].parts.filter((p) => p.functionCall).length, 2);
    assert.deepStrictEqual(req.contents[2].parts.map((p) => p.functionResponse), [
      { name: 'get_weather', response: { temp: -5 } },
      { name: 'get_time', response: { result: '12:00' } },
    ]);
  });

  await test('группы tool-ответов делятся по ходам; system между ними не разрывает группу', () => {
    const req = openAIToGeminiRequest({ messages: [
      { role: 'user', content: 'шаг 1' },
      { role: 'assistant', content: null, tool_calls: [call('x1', 'first', '{}'), call('x2', 'second', '{}')] },
      { role: 'tool', tool_call_id: 'x1', content: '{"n":1}' },
      { role: 'system', content: 'правило' },
      { role: 'tool', tool_call_id: 'x2', content: '{"n":2}' },
      { role: 'assistant', content: null, tool_calls: [call('y1', 'third', '{}')] },
      { role: 'tool', tool_call_id: 'y1', content: '{"n":3}' },
      { role: 'user', content: 'дальше' },
    ] });
    assert.deepStrictEqual(req.contents.map((c) => c.role), ['user', 'model', 'user', 'model', 'user', 'user']);
    assert.deepStrictEqual(req.contents[2].parts.map((p) => p.functionResponse.name), ['first', 'second']);
    assert.deepStrictEqual(req.contents[4].parts.map((p) => p.functionResponse.name), ['third']);
    assert.deepStrictEqual(req.contents[5].parts, [{ text: 'дальше' }]);
    assert.strictEqual(req.systemInstruction.parts[0].text, 'правило');
  });

  await test('неизвестный tool_call_id -> имя функции = id (как раньше)', () => {
    const req = openAIToGeminiRequest({ messages: [{ role: 'tool', tool_call_id: 'orphan', content: '{}' }] });
    assert.strictEqual(req.contents[0].parts[0].functionResponse.name, 'orphan');
  });

  await test('functionResponse.response всегда объект (protobuf Struct)', () => {
    const cases = [
      ['{"temp":-5}', { temp: -5 }],
      ['42', { result: 42 }],
      ['[1,2]', { result: [1, 2] }],
      ['"строка"', { result: 'строка' }],
      ['null', { result: null }],
      ['просто текст', { result: 'просто текст' }],
      ['{битый', { result: '{битый' }],
      [null, {}],
      [undefined, {}],
      [{ already: true }, { already: true }],
      [7, { result: 7 }],
      [[{ type: 'text', text: '{"a":1}' }], { a: 1 }],
      [[{ type: 'text', text: 'часть 1' }, { type: 'text', text: 'часть 2' }], { result: 'часть 1\nчасть 2' }],
    ];
    for (const [content, expected] of cases) {
      const req = openAIToGeminiRequest({ messages: [
        { role: 'assistant', content: null, tool_calls: [call('t', 'fn', '{}')] },
        { role: 'tool', tool_call_id: 't', content },
      ] });
      assert.deepStrictEqual(req.contents[1].parts[0].functionResponse.response, expected, `content=${JSON.stringify(content)}`);
    }
  });

  await test('functionCall.args всегда объект', () => {
    const cases = [
      ['{"city":"Москва"}', { city: 'Москва' }],
      [{ city: 'Рим' }, { city: 'Рим' }],
      ['', {}],
      [undefined, {}],
      ['null', {}],
      ['[1,2]', { _raw: '[1,2]' }],
      ['"x"', { _raw: '"x"' }],
      ['{битый', { _raw: '{битый' }],
    ];
    for (const [args, expected] of cases) {
      const req = openAIToGeminiRequest({ messages: [{ role: 'assistant', content: null, tool_calls: [call('a', 'fn', args)] }] });
      assert.deepStrictEqual(req.contents[0].parts[0].functionCall.args, expected, `arguments=${JSON.stringify(args)}`);
    }
  });

  await test('thoughtSignature клиента ставится только на первый functionCall хода', () => {
    const req = openAIToGeminiRequest({ messages: [{ role: 'assistant', content: null, tool_calls: [
      { ...call('p1', 'a', '{}'), thought_signature: 'sig-first' },
      { ...call('p2', 'b', '{}'), thought_signature: 'sig-second' },
    ] }] });
    assert.strictEqual(req.contents[0].parts[0].thoughtSignature, 'sig-first');
    assert.strictEqual(req.contents[0].parts[1].thoughtSignature, undefined);
  });

  await test('max_completion_tokens -> maxOutputTokens; max_tokens приоритетнее', () => {
    const base = { messages: [{ role: 'user', content: 'x' }] };
    assert.strictEqual(openAIToGeminiRequest({ ...base, max_completion_tokens: 77 }).generationConfig.maxOutputTokens, 77);
    assert.strictEqual(openAIToGeminiRequest({ ...base, max_tokens: 10, max_completion_tokens: 77 }).generationConfig.maxOutputTokens, 10);
    assert.strictEqual(openAIToGeminiRequest(base).generationConfig, undefined);
  });

  await test('рекурсивный $ref обрывается; общий не рекурсивный $ref раскрывается везде', () => {
    const out = sanitizeGeminiSchema({
      $defs: {
        Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Node', description: 'Дети' } } } },
        Tag: { type: 'string', description: 'Метка' },
      },
      type: 'object',
      properties: { root: { $ref: '#/$defs/Node' }, a: { $ref: '#/$defs/Tag' }, b: { $ref: '#/$defs/Tag' } },
    }, { isRoot: true });
    assert.strictEqual(out.properties.root.type, 'object');
    assert.deepStrictEqual(out.properties.root.properties.name, { type: 'string' });
    assert.deepStrictEqual(out.properties.root.properties.children.items, { type: 'object', description: 'Дети' });
    assert.deepStrictEqual(out.properties.a, { type: 'string', description: 'Метка' });
    assert.deepStrictEqual(out.properties.b, { type: 'string', description: 'Метка' });
  });

  await test('взаимная рекурсия A -> B -> A тоже конечна', () => {
    const out = sanitizeGeminiSchema({
      definitions: {
        A: { type: 'object', properties: { b: { $ref: '#/definitions/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/definitions/A' } } },
      },
      $ref: '#/definitions/A',
    }, { isRoot: true });
    assert.deepStrictEqual(out, { type: 'object', properties: { b: { type: 'object', properties: { a: { type: 'object' } } } } });
  });

  console.log('== translate: ответ');

  await test('mapFinish: все причины фильтрации -> content_filter', () => {
    for (const r of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION']) {
      assert.strictEqual(mapFinish(r, false), 'content_filter', r);
    }
    assert.strictEqual(mapFinish('MAX_TOKENS', false), 'length');
    assert.strictEqual(mapFinish('STOP', false), 'stop');
    assert.strictEqual(mapFinish('OTHER', false), 'stop');
    assert.strictEqual(mapFinish('SAFETY', true), 'tool_calls');
  });

  await test('usage: рассуждения входят в completion_tokens, кэш — в details', () => {
    assert.deepStrictEqual(
      mapUsage({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 20, cachedContentTokenCount: 4, totalTokenCount: 35 }),
      {
        prompt_tokens: 10, completion_tokens: 25, total_tokens: 35,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 20 },
      });
    assert.deepStrictEqual(mapUsage({ promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 }), { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    assert.deepStrictEqual(mapUsage({ promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 5 }), {
      prompt_tokens: 3, completion_tokens: 7, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 },
    });
    assert.strictEqual(mapUsage(undefined), undefined);
  });

  await test('promptFeedback.blockReason без кандидатов -> content_filter (non-stream)', () => {
    const out = geminiToOpenAIResponse({ response: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 4, totalTokenCount: 4 } } }, 'm');
    assert.strictEqual(out.choices[0].finish_reason, 'content_filter');
    assert.strictEqual(out.choices[0].message.content, null);
    assert.deepStrictEqual(out.usage, { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 });
    const normal = geminiToOpenAIResponse({ response: { candidates: [{ content: { parts: [{ text: 'да' }] }, finishReason: 'STOP' }], promptFeedback: { safetyRatings: [] } } }, 'm');
    assert.strictEqual(normal.choices[0].finish_reason, 'stop');
    assert.strictEqual(normal.choices[0].message.content, 'да');
  });

  await test('promptFeedback.blockReason -> content_filter (stream), ровно один финальный чанк', () => {
    const conv = new GeminiStreamToOpenAI('m');
    const chunks = conv.pushData(JSON.stringify({ response: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } }));
    chunks.push(...conv.finishChunks());
    const finals = chunks.filter((c) => c.choices[0].finish_reason);
    assert.strictEqual(finals.length, 1);
    assert.strictEqual(finals[0].choices[0].finish_reason, 'content_filter');

    const normal = new GeminiStreamToOpenAI('m');
    normal.pushData(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'да' }] }, finishReason: 'STOP' }] } }));
    assert.strictEqual(normal.finishChunks()[0].choices[0].finish_reason, 'stop');
  });

  await test('stream: usage с рассуждениями в финальном чанке, guard видит totalTokenCount', () => {
    const conv = new GeminiStreamToOpenAI('m');
    conv.pushData(JSON.stringify({ response: {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, thoughtsTokenCount: 3, totalTokenCount: 6 },
    } }));
    const [fin] = conv.finishChunks();
    assert.deepStrictEqual(fin.usage, { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6, completion_tokens_details: { reasoning_tokens: 3 } });
    assert.strictEqual(conv.getUsageTokens(), 6);
  });

  console.log('== translate: кэш подписей');

  await test('поиск подписи: id -> имя+аргументы -> имя -> последняя', () => {
    recordThoughtSignature('id-1', 'lookup', { q: 1 }, 'sig-args');
    recordThoughtSignature('id-2', 'lookup', { q: 2 }, 'sig-name');
    assert.strictEqual(getThoughtSignature('id-1'), 'sig-args');
    assert.strictEqual(getThoughtSignature('missing', 'lookup', { q: 1 }), 'sig-args');
    assert.strictEqual(getThoughtSignature('missing', 'lookup', { q: 9 }), 'sig-name');
    assert.strictEqual(getThoughtSignature('missing', 'other', null), 'sig-name');
  });

  await test('кэш ограничен 500 ключами и вытесняет самые старые', () => {
    for (let i = 0; i < 600; i++) recordThoughtSignature('c' + i, '', null, 'sig-c' + i);
    assert.strictEqual(getThoughtSignature('c599'), 'sig-c599');
    assert.strictEqual(getThoughtSignature('c100'), 'sig-c100');
    // вытесненный ключ не найден -> последняя глобальная подпись
    assert.strictEqual(getThoughtSignature('c99'), 'sig-c599');
    assert.strictEqual(getThoughtSignature('id-1'), 'sig-c599');
  });

  await test('повторная запись освежает ключ: вытесняется следующий по старшинству', () => {
    recordThoughtSignature('c100', '', null, 'sig-c100');
    recordThoughtSignature('c600', '', null, 'sig-c600');
    assert.strictEqual(getThoughtSignature('c100'), 'sig-c100');
    assert.strictEqual(getThoughtSignature('c101'), 'sig-c600');
    assert.strictEqual(getThoughtSignature('c102'), 'sig-c102');
  });

  await test('кэш пишется в AG_SIG_FILE (≤ 500 записей), настоящий файл в %TEMP% не тронут', async () => {
    await sleep(700);
    const saved = JSON.parse(fs.readFileSync(SIG_FILE, 'utf8'));
    assert.ok(Object.keys(saved).length <= 500, `записей: ${Object.keys(saved).length}`);
    assert.strictEqual(saved.c600, 'sig-c600');
    assert.strictEqual(saved.c101, undefined);
    assert.strictEqual(fileStamp(REAL_SIG_FILE), realSigBefore);
  });

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();

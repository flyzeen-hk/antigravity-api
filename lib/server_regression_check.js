'use strict';

// Focused offline regressions; no servers, real credentials or external requests.
const assert = require('assert/strict');
const { parseRequestBody, validateOpenAI, validateGemini, sseData, upstreamErrorBody, sendApiError } = require('./http_helpers');
const { fetchWithFallback, netWhy } = require('./fetch_fallback');
const { GeminiStreamToOpenAI } = require('./translate');
const { GeminiWebBridge } = require('./web_bridge');

async function main() {
  let passed = 0;
  async function check(name, fn) {
    await fn();
    console.log(`PASS ${name}`);
    passed++;
  }
  await check('malformed JSON and top-level values are client errors', () => {
    for (const text of ['{', 'null', '[]', '1', '"text"']) {
      assert.throws(() => parseRequestBody(text), e => e.status === 400);
    }
    assert.deepEqual(parseRequestBody('{}'), {});
  });
  await check('invalid message/contents shapes are rejected before conversion', () => {
    for (const messages of [{}, [null], [{ content: [null] }]]) {
      assert.throws(() => validateOpenAI({ model: 'cloud/test', messages }), e => e.status === 400);
    }
    assert.throws(() => validateGemini({ contents: [{ parts: {} }] }), e => e.status === 400);
    validateOpenAI({ model: 'cloud/test', messages: [{ role: 'assistant', content: null, tool_calls: [] }] });
    validateGemini({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
  });
  await check('text, empty and JSON upstream errors remain API JSON errors', () => {
    for (const text of ['<html>gateway down</html>', '', 'null', '{"error":{"message":"down"}}']) {
      const body = upstreamErrorBody(502, text);
      assert.equal(body.error.code, 502);
      assert.equal(body.error.type, 'api_error');
      assert.equal(typeof body.error.message, 'string');
    }
    assert.equal(netWhy(new Error('fetch failed', { cause: new Error('DNS failure') })), 'fetch failed: DNS failure');
  });
  await check('SSE handles multiline data, split UTF-8, CRLF and final line', async () => {
    const bytes = Buffer.from('data: {"text":\r\ndata: "Привет"}\r\n\r\ndata: [DONE]');
    async function* bytesOneAtATime() { for (const byte of bytes) yield Buffer.from([byte]); }
    const events = [];
    for await (const data of sseData(bytesOneAtATime())) events.push(data);
    assert.deepEqual(JSON.parse(events[0]), { text: 'Привет' });
    assert.equal(events[1], '[DONE]');
  });
  await check('OpenAI stream identity stays stable and tool indexes are distinct', () => {
    const converter = new GeminiStreamToOpenAI('test');
    const chunks = converter.pushData(JSON.stringify({ candidates: [{ content: { parts: [
      { functionCall: { name: 'first', args: {} } }, { functionCall: { name: 'second', args: {} } },
    ] } }] }));
    chunks.push(...converter.finishChunks());
    assert.equal(new Set(chunks.map(c => c.id)).size, 1);
    assert.deepEqual(chunks.flatMap(c => c.choices[0].delta.tool_calls || []).map(c => c.index), [0, 1]);
  });
  await check('SSE errors do not resend headers and OpenAI receives DONE', () => {
    const writes = [];
    const response = { headersSent: true, write: value => writes.push(value), end() { this.writableEnded = true; }, writeHead() { throw new Error('headers sent twice'); } };
    sendApiError(response, 502, { error: { message: 'upstream interrupted' } }, true);
    assert.ok(writes[0].startsWith('data: {"error":'));
    assert.equal(writes[1], 'data: [DONE]\n\n');
    assert.equal(response.writableEnded, true);
  });
  await check('web stream preserves boundary whitespace, UTF-8 and final frame without newline', async () => {
    const bridge = new GeminiWebBridge({ enabled: false });
    function frame(text) { return JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [[null, [text]]]])]]); }
    const bytes = Buffer.from(frame('Привет') + '\n' + frame('Привет мир'));
    async function* stream() { for (const byte of bytes) yield Buffer.from([byte]); }
    let text = '';
    for await (const delta of bridge.streamResponse(stream())) text += delta;
    assert.equal(text, 'Привет мир');
  });
  await check('cancelled fetch never attempts the fallback host', async () => {
    const original = global.fetch;
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    global.fetch = async () => { calls++; throw new DOMException('Cancelled', 'AbortError'); };
    try {
      await assert.rejects(fetchWithFallback('https://primary.invalid', 'https://fallback.invalid', '/test', { signal: controller.signal }));
      assert.equal(calls, 1);
    } finally { global.fetch = original; }
  });
  console.log(`${passed} focused offline regressions passed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

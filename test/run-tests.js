'use strict';

/*
 * Интеграционные тесты antigravity-api с моками OAuth и Cloud Code (daily-эндпоинт).
 * Запуск: node test/run-tests.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Тестовые подписи (mock-sig-123 и т.п.) не должны попадать в настоящий кэш в %TEMP%.
process.env.AG_SIG_FILE = path.join(os.tmpdir(), `ag-test-sigs-${process.pid}.json`);
process.on('exit', () => removeTree(process.env.AG_SIG_FILE));

const { removeTree } = require('../lib/safe_files');
const { start, resolveCloudCodeUserAgent } = require('../server.js');

const PORT_OAUTH = 9531;
const PORT_UPSTREAM = 9532;
const PORT_API = 9533;
const KEY = 'test-key-123';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((e) => {
      failed++;
      failures.push({ name, e });
      console.error(`FAIL  ${name}\n      ${e.message}`);
    });
}

function readBodyReq(req) {
  return new Promise((r) => {
    const ch = [];
    req.on('data', (c) => ch.push(c));
    req.on('end', () => r(Buffer.concat(ch).toString('utf8')));
  });
}

function parseSSE(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (d === '[DONE]') {
          out.push({ done: true });
          continue;
        }
        try {
          out.push(JSON.parse(d));
        } catch {}
      }
    }
  }
  return out;
}

function api(port, method, p, body, headers = {}) {
  const data = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        const ch = [];
        res.on('data', (c) => ch.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(ch).toString('utf8'), sse: parseSSE(Buffer.concat(ch).toString('utf8')) }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const AUTH = () => ({ authorization: 'Bearer ' + KEY });

// ---------- моки ----------

function startMockOAuth() {
  let refreshCalls = 0;
  const server = http.createServer(async (req, res) => {
    const body = await readBodyReq(req);
    const params = new URLSearchParams(body);
    if (params.get('grant_type') !== 'refresh_token' || !params.get('refresh_token')) {
      res.writeHead(400).end('{}');
      return;
    }
    refreshCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'mock-access-' + refreshCalls, expires_in: 3600, scope: 'test-scope' }));
  });
  return new Promise((r) => server.listen(PORT_OAUTH, '127.0.0.1', () => r({ server, get: () => refreshCalls })));
}

function startMockUpstream() {
  const state = { lastAuth: '', lastUA: '', lastBody: null };
  const server = http.createServer(async (req, res) => {
    state.lastAuth = req.headers.authorization || '';
    state.lastUA = req.headers['user-agent'] || '';
    const body = JSON.parse(await readBodyReq(req));
    if (req.url === '/v1internal:fetchAvailableModels') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          models: {
            'gemini-3-flash': { displayName: 'Gemini 3 Flash', maxTokens: 1000, maxOutputTokens: 500 },
            'gemini-4-catalog-test': { displayName: 'Mock catalog model, not a real availability claim' },
            'gemini-4-argon-disabled': { displayName: 'Disabled placeholder' },
            'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxTokens: 250000, maxOutputTokens: 64000 },
            'chat_20706': { displayName: null },
            'tab_flash_lite_preview': { displayName: null },
          },
        })
      );
    }
    if (req.url === '/v1internal:loadCodeAssist') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ currentTier: { id: 'standard-tier', name: 'Antigravity' }, cloudaicompanionProject: 'aicode-consumers' }));
    }
    if (req.url === '/v1internal:fetchUserInfo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ regionCode: 'NL' }));
    }
    if (req.url === '/v1internal:retrieveUserQuotaSummary') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          groups: [
            {
              group: 'gemini',
              displayName: 'Gemini Models',
              buckets: [
                { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.85, resetTime: '2026-10-15T00:00:00Z' },
                { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.9, resetTime: '2026-10-08T18:00:00Z' },
              ],
            },
          ],
        })
      );
    }
    if (req.url === '/v1internal:countTokens') {
      state.lastCountBody = body;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ response: { totalTokens: 42 } }));
    }
    if (req.url.startsWith('/v1internal:generateContent')) {
      state.lastBody = body;
      const model = body.model;
      if (model === 'quota-model') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 429, message: 'Individual quota reached. Resets in 100h0m0s.', status: 'RESOURCE_EXHAUSTED' } }));
      }
      if (model === 'region-model') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } }));
      }
      if (model === 'notfound-model') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const text = JSON.stringify(body.request);
      const isCallTool = text.includes('CALL_TOOL');

      // Скриптованный cloud-агент: нативный functionCall -> файл -> финал.
      if (text.includes('AGENT_WRITE')) {
        if (!text.includes('functionResponse')) {
          send({ response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { path: 'agent-loop.txt', content: 'native-loop' } }, thoughtSignature: 'mock-agent-sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } } });
        } else {
          send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Готово: агент записал файл.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 } } });
        }
        res.end();
        return;
      }

      // Два параллельных functionCall в одном ходе; подпись только у первого, как у Gemini.
      if (text.includes('AGENT_PARALLEL')) {
        if (!text.includes('functionResponse')) {
          send({ response: { candidates: [{ content: { role: 'model', parts: [
            { functionCall: { name: 'write_file', args: { path: 'p1.txt', content: 'один' } }, thoughtSignature: 'mock-parallel-sig' },
            { functionCall: { name: 'write_file', args: { path: 'p2.txt', content: 'два' } } },
          ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 6, totalTokenCount: 15 } } });
        } else {
          send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Оба файла записаны.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 } } });
        }
        res.end();
        return;
      }

      // Скриптованный planner-прогон: ask_planner -> write_file -> финал.
      if (text.includes('PLANNER_TASK')) {
        state.plannerSteps = (state.plannerSteps || 0) + 1;
        if (state.plannerSteps === 1) {
          send({ response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'ask_planner', args: { question: 'Как спланировать задачу?', mode: 'plan' } }, thoughtSignature: 'planner-sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } } });
        } else if (state.plannerSteps === 2) {
          send({ response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { path: 'planner-loop.txt', content: 'после плана' } }, thoughtSignature: 'write-sig' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3, totalTokenCount: 9 } } });
        } else {
          send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Готово: план применён.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 } } });
        }
        res.end();
        return;
      }

      // Thought-чанк перед обычным текстом: агент не должен терять финальный ответ.
      if (text.includes('THINK_AGENT')) {
        send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'думаю...', thought: true }] } }] } });
        send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Финальный ответ' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } } });
        res.end();
        return;
      }

      // Медленный апстрим для проверки отмены при уходе клиента.
      if (text.includes('SLOW_STREAM')) {
        res.on('close', () => { if (typeof state.onSlowClose === 'function') state.onSlowClose(); });
        send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'первый ' }] } }] } });
        // дальше не отправляем ничего, пока клиент не отключится
        return;
      }

      // Запрос отклонён фильтром Google: кандидатов нет, только promptFeedback.
      if (text.includes('BLOCKED_PROMPT')) {
        send({ response: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 4, totalTokenCount: 4 } } });
        res.end();
        return;
      }

      if (model === 'echo-model' || isCallTool) {
        send({ response: { candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'думаю...' }] } }] } });
        if (isCallTool) {
          send({ response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Москва' } }, thoughtSignature: 'mock-sig-123' }] }, finishReason: 'STOP' }] } });
          send({ response: { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 } } });
        } else {
          send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'ECHO:' + text }] } }] } });
          send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: '!tail' }] } }] } });
          send({ response: { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 13, totalTokenCount: 34 } } });
        }
        res.end();
        return;
      }

      // обычный многочастный стрим
      send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Привет' }] } }] } });
      send({ response: { candidates: [{ content: { role: 'model', parts: [{ text: ', мир' }] } }] } });
      send({ response: { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 } } });
      res.end();
      return;
    }
    res.writeHead(404).end('{}');
  });
  return new Promise((r) => server.listen(PORT_UPSTREAM, '127.0.0.1', () => r({ server, state })));
}

// ---------- main ----------

async function main() {
  const mockOAuth = await startMockOAuth();
  const mockUp = await startMockUpstream();

  // временный auth.json и usage.json для теста
  const authFile = path.join(os.tmpdir(), 'ag-test-auth-' + Date.now() + '.json');
  fs.writeFileSync(authFile, JSON.stringify({ type: 'antigravity', refresh_token: 'test-refresh-token', access_token: '', access_expires_at: 0 }));
  process.env.AG_AUTH_FILE = authFile;
  process.env.AG_OAUTH_URL = `http://127.0.0.1:${PORT_OAUTH}/token`;

  const usageFile = path.join(os.tmpdir(), 'ag-test-usage-' + Date.now() + '.json');
  fs.writeFileSync(usageFile, JSON.stringify({ days: {}, cooldowns: {} }));
  process.env.AG_USAGE_FILE = usageFile;

  const api1 = start({
    port: PORT_API,
    host: '127.0.0.1',
    upstreamHost: `http://127.0.0.1:${PORT_UPSTREAM}`,
    userAgent: 'antigravity-test/1.0',
    apiKey: KEY,
    includeThoughts: false,
    requestTimeoutMs: 30000,
    retries: 0,
    persistConfig: false, // не трогаем настоящий config.json из тестов
    network: { useEnvProxy: false }, // тесты не должны зависеть от системного прокси/DNS хоста
    safeMode: {
      enabled: true,
      maxRequestsPerMinute: 100,
      maxRequestsPerHour: 1000,
      maxRequestsPerDay: 1000,
      maxTokensPerDay: 10 ** 9,
      maxRequestsPerWeek: 10000,
      maxTokensPerWeek: 10 ** 12,
      minIntervalMs: 10,
      jitterMs: 10,
      maxConcurrent: 4,
      cooldownAfter429Ms: 300,
      maxCooldownMs: 1000,
    },
  });
  await new Promise((r) => setTimeout(r, 250));

  const A = (p, method = 'GET', body = null, headers = AUTH()) => api(PORT_API, method, p, body, headers);

  await ok('auth: неверный ключ -> 401', async () => {
    const r = await api(PORT_API, 'GET', '/v1/models', null, { authorization: 'Bearer wrong' });
    assert.strictEqual(r.status, 401);
  });

  await ok('user-agent: legacy antigravity/1.x -> официальная подпись aidev_client', async () => {
    const ua = resolveCloudCodeUserAgent('antigravity/1.11.4');
    assert.match(ua, /^antigravity\/2\.29\.0 \(aidev_client; os_type=/);
    assert.match(ua, /cl=1003475615/);
    assert.match(resolveCloudCodeUserAgent('antigravity/2.30.1'), /^antigravity\/2\.30\.1 \(aidev_client/);
    assert.strictEqual(resolveCloudCodeUserAgent('my-custom-agent'), 'my-custom-agent');
  });

  await ok('GET /v1/models: каталог + фильтрация tab_*/chat_*', async () => {
    const r = await A('/v1/models');
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    const ids = j.data.map((m) => m.id);
    assert.ok(ids.includes('cloud/gemini-3-flash'));
    assert.ok(ids.includes('cloud/claude-sonnet-4-6'));
    assert.ok(!ids.some((id) => id.endsWith('/chat_20706')));
    assert.ok(!ids.some((id) => id.endsWith('/tab_flash_lite_preview')));
    assert.ok(!ids.some((id) => id.includes('-disabled')), 'disabled-заглушки не должны попадать в каталог');
    assert.strictEqual(j.data[0].owned_by, 'antigravity');
    assert.strictEqual(j.data[0].provider, 'cloud');
  });

  await ok('chat/completions non-stream: текст + usage + finish', async () => {
    const r = await A('/v1/chat/completions', 'POST', {
      model: 'cloud/gemini-3-flash',
      messages: [{ role: 'system', content: 'Ты ассистент' }, { role: 'user', content: 'привет' }],
      temperature: 0.5,
      max_tokens: 100,
    });
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.choices[0].message.role, 'assistant');
    assert.strictEqual(j.choices[0].message.content, 'Привет, мир');
    assert.strictEqual(j.choices[0].finish_reason, 'stop');
    assert.deepStrictEqual(j.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    assert.ok(j.id.startsWith('chatcmpl-ag-'));
  });

  await ok('chat/completions: перевод запроса (system, роли, параметры)', async () => {
    await A('/v1/chat/completions', 'POST', {
      model: 'cloud/echo-model',
      messages: [
        { role: 'system', content: 'Ты ассистент' },
        { role: 'user', content: [{ type: 'text', text: 'вопрос' }] },
        { role: 'assistant', content: 'ответ' },
        { role: 'user', content: 'еще' },
      ],
      max_tokens: 123,
      stop: 'STOP',
    });
    const sent = mockUp.state.lastBody;
    assert.strictEqual(sent.model, 'echo-model');
    assert.strictEqual(sent.request.systemInstruction.parts[0].text, 'Ты ассистент');
    assert.strictEqual(sent.request.contents[0].role, 'user');
    assert.strictEqual(sent.request.contents[0].parts[0].text, 'вопрос');
    assert.strictEqual(sent.request.contents[1].role, 'model');
    assert.strictEqual(sent.request.generationConfig.maxOutputTokens, 123);
    assert.deepStrictEqual(sent.request.generationConfig.stopSequences, ['STOP']);
    assert.strictEqual(mockUp.state.lastUA, 'antigravity-test/1.0');
    assert.match(mockUp.state.lastAuth, /^Bearer mock-access-/);
  });

  await ok('chat/completions: tool calls обе стороны', async () => {
    await A('/v1/chat/completions', 'POST', {
      model: 'cloud/echo-model',
      messages: [
        { role: 'user', content: 'CALL_TOOL' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Москва"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":-5}' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Погода', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    });
    const sent = mockUp.state.lastBody.request;
    assert.strictEqual(sent.tools[0].functionDeclarations[0].name, 'get_weather');
    const modelMsg = sent.contents.find((c) => c.role === 'model');
    assert.deepStrictEqual(modelMsg.parts[0].functionCall, { name: 'get_weather', args: { city: 'Москва' } });
    const toolMsg = sent.contents.find((c) => c.role === 'user' && c.parts[0].functionResponse);
    assert.strictEqual(toolMsg.parts[0].functionResponse.name, 'get_weather');
    assert.deepStrictEqual(toolMsg.parts[0].functionResponse.response, { temp: -5 });

    // и ответ с functionCall -> OpenAI tool_calls
    const r = await A('/v1/chat/completions', 'POST', { model: 'cloud/CALL_TOOL', messages: [{ role: 'user', content: 'CALL_TOOL' }] });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(j.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.deepStrictEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments), { city: 'Москва' });
    assert.strictEqual(j.choices[0].message.content, null);
    assert.strictEqual(j.choices[0].message.tool_calls[0].thought_signature, 'mock-sig-123');

    // Проверяем возврат thoughtSignature в следующем запросе (диалог продолжается)
    const returnedCall = j.choices[0].message.tool_calls[0];
    await A('/v1/chat/completions', 'POST', {
      model: 'cloud/echo-model',
      messages: [
        { role: 'user', content: 'CALL_TOOL' },
        { role: 'assistant', content: null, tool_calls: [returnedCall] },
        { role: 'tool', tool_call_id: returnedCall.id, content: '{"temp":-5}' },
      ],
    });
    const nextSent = mockUp.state.lastBody.request;
    const modelStep = nextSent.contents.find((c) => c.role === 'model');
    assert.strictEqual(modelStep.parts[0].thoughtSignature, 'mock-sig-123');
  });

  await ok('chat/completions: санитизация tools ($schema, exclusiveMinimum, $defs, additionalProperties)', async () => {
    await A('/v1/chat/completions', 'POST', {
      model: 'cloud/echo-model',
      messages: [{ role: 'user', content: 'test' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'git_log',
            description: 'Показать лог',
            parameters: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              $defs: {
                GitRef: { type: 'string', description: 'Ветка' },
              },
              title: 'GitLogParams',
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { $ref: '#/$defs/GitRef' },
                max_count: {
                  type: 'integer',
                  exclusiveMinimum: 0,
                  title: 'MaxCount',
                },
              },
              required: ['ref'],
            },
          },
        },
      ],
    });
    const decl = mockUp.state.lastBody.request.tools[0].functionDeclarations[0];
    assert.strictEqual(decl.name, 'git_log');
    const p = decl.parameters;
    assert.strictEqual(p.$schema, undefined);
    assert.strictEqual(p.$defs, undefined);
    assert.strictEqual(p.title, undefined);
    assert.strictEqual(p.additionalProperties, undefined);
    assert.strictEqual(p.type, 'object');
    assert.strictEqual(p.properties.ref.type, 'string');
    assert.strictEqual(p.properties.ref.description, 'Ветка');
    assert.strictEqual(p.properties.max_count.type, 'integer');
    assert.strictEqual(p.properties.max_count.minimum, 0);
    assert.strictEqual(p.properties.max_count.exclusiveMinimum, undefined);
  });

  await ok('chat/completions stream: OpenAI SSE чанки', async () => {
    const r = await A('/v1/chat/completions', 'POST', { model: 'cloud/gemini-3-flash', stream: true, messages: [{ role: 'user', content: 'привет' }] });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /text\/event-stream/);
    const ev = r.sse;
    assert.deepStrictEqual(ev[0].choices[0].delta, { role: 'assistant', content: '' });
    const contents = ev.map((c) => c.choices?.[0]?.delta?.content).filter(Boolean).join('');
    assert.strictEqual(contents, 'Привет, мир');
    const fin = ev.find((c) => c.choices?.[0]?.finish_reason === 'stop');
    assert.ok(fin, 'нет финального чанка');
    assert.deepStrictEqual(fin.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    assert.ok(ev[ev.length - 1].done, 'нет [DONE]');
  });

  await ok('chat/completions stream: мысли фильтруются', async () => {
    const r = await A('/v1/chat/completions', 'POST', { model: 'cloud/echo-model', stream: true, messages: [{ role: 'user', content: 'echo' }] });
    const ev = r.sse;
    const hasThought = ev.some((c) => c.choices?.[0]?.delta?.reasoning_content !== undefined);
    assert.ok(!hasThought, 'reasoning_content не должно быть при includeThoughts=false');
    const content = ev.map((c) => c.choices?.[0]?.delta?.content).filter(Boolean).join('');
    assert.ok(content.startsWith('ECHO:'));
  });

  await ok('гео-блок апстрима -> region_not_supported вместо числового code', async () => {
    const r = await A('/v1/chat/completions', 'POST', { model: 'cloud/region-model', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(r.status, 400);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.error.code, 'region_not_supported');
    assert.strictEqual(j.error.type, 'invalid_request_error');
    assert.match(j.error.message, /location is not supported/i);
  });

  await ok('неизвестная cloud-модель -> понятный model_not_found', async () => {
    const r = await A('/v1/chat/completions', 'POST', { model: 'cloud/notfound-model', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(r.status, 404);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.error.code, 'model_not_found');
    assert.match(j.error.message, /Check the model id via \/v1\/models/);
  });

  await ok('429 от апстрима -> rate_limit_error с сообщением о квоте', async () => {
    const r = await A('/v1/chat/completions', 'POST', { model: 'cloud/quota-model', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(r.status, 429);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.error.type, 'rate_limit_error');
    assert.ok(j.error.message.includes('Resets in'), j.error.message);
  });

  await ok('Gemini-нативный: generateContent без обёртки', async () => {
    await new Promise((r) => setTimeout(r, 1300)); // ждём окончания cooldown после 429-теста (maxCooldownMs=1000)
    const r = await A('/v1beta/models/cloud/gemini-3-flash:generateContent', 'POST', { contents: [{ role: 'user', parts: [{ text: 'привет' }] }] });
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.ok(!j.response, 'обёртка должна быть развёрнута');
    assert.strictEqual(j.candidates[0].content.parts[0].text, 'Привет, мир');
    assert.strictEqual(j.candidates[0].finishReason, 'STOP');
  });

  await ok('Gemini-нативный: streamGenerateContent SSE развёрнутый', async () => {
    const r = await A('/v1beta/models/cloud/gemini-3-flash:streamGenerateContent?alt=sse', 'POST', { contents: [{ role: 'user', parts: [{ text: 'привет' }] }] });
    const j = r.sse;
    assert.ok(j.length >= 3);
    assert.ok(!j[0].response, 'нет обёртки');
    assert.strictEqual(j[j.length - 1].candidates[0].finishReason, 'STOP');
    assert.ok(j[j.length - 1].usageMetadata.totalTokenCount === 18);
  });

  await ok('countTokens: unwrap response', async () => {
    const r = await A('/v1beta/models/cloud/gemini-3-flash:countTokens', 'POST', { contents: [{ role: 'user', parts: [{ text: 'привет' }] }] });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.totalTokens, 42);
    const sent = mockUp.state.lastCountBody;
    assert.strictEqual(sent.model, undefined, 'внешний model не должен уходить в countTokens');
    assert.strictEqual(sent.project, undefined, 'project не должен уходить в countTokens');
    assert.strictEqual(sent.request.model, 'models/gemini-3-flash');
    assert.ok(Array.isArray(sent.request.contents));
  });

  await ok('заблокированный запрос (promptFeedback) -> content_filter в non-stream, stream и native', async () => {
    const messages = [{ role: 'user', content: 'BLOCKED_PROMPT' }];
    const plain = await A('/v1/chat/completions', 'POST', { model: 'cloud/gemini-3-flash', messages });
    assert.strictEqual(plain.status, 200, plain.text);
    const pj = JSON.parse(plain.text);
    assert.strictEqual(pj.choices[0].finish_reason, 'content_filter');
    assert.strictEqual(pj.choices[0].message.content, null);
    assert.deepStrictEqual(pj.usage, { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 });

    const streamed = await A('/v1/chat/completions', 'POST', { model: 'cloud/gemini-3-flash', stream: true, messages });
    const finals = streamed.sse.filter((c) => c.choices?.[0]?.finish_reason);
    assert.strictEqual(finals.length, 1);
    assert.strictEqual(finals[0].choices[0].finish_reason, 'content_filter');
    assert.ok(streamed.sse[streamed.sse.length - 1].done, 'нет [DONE]');

    const native = await A('/v1beta/models/cloud/gemini-3-flash:generateContent', 'POST', { contents: [{ role: 'user', parts: [{ text: 'BLOCKED_PROMPT' }] }] });
    assert.strictEqual(native.status, 200, native.text);
    const nj = JSON.parse(native.text);
    assert.deepStrictEqual(nj.candidates, []);
    assert.strictEqual(nj.promptFeedback.blockReason, 'PROHIBITED_CONTENT');
  });

  await ok('авто-refresh: access_token запрошен при старте', async () => {
    assert.ok(mockOAuth.get() >= 1, 'oauth refresh должен был вызваться');
  });

  await ok('/_limits: локальные лимиты + аккаунт + cooldown', async () => {
    const r = await A('/_limits');
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.ok(j.local.limits.perDay > 0, 'нет локальных лимитов');
    assert.strictEqual(typeof j.local.requestsToday, 'number');
    assert.ok(j.local.week && typeof j.local.week.requests === 'number', 'нет недельных лимитов');
    assert.ok(Array.isArray(j.local.days) && j.local.days.length === 7, 'нет истории 7 дней');
    assert.strictEqual(j.account.tier, 'Antigravity', JSON.stringify(j.account));
    assert.strictEqual(j.account.project, 'aicode-consumers');
    assert.strictEqual(j.account.region, 'NL');
    assert.ok(Array.isArray(j.models) && j.models.length >= 2, 'нет моделей в /_limits');
  });

  await ok('/_quota: реальные квоты групп моделей', async () => {
    const r = await A('/_quota');
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.ok(Array.isArray(j.groups) && j.groups.length >= 1, 'нет групп в /_quota');
    assert.strictEqual(j.groups[0].displayName, 'Gemini Models');
    assert.strictEqual(j.groups[0].buckets[0].remainingPercent, 85);
  });

  await ok('/_config: динамическое изменение лимитов Safe Mode', async () => {
    const r = await A('/_config', 'POST', { safeMode: { maxRequestsPerMinute: 42, maxRequestsPerDay: 555 } });
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.safeMode.maxRequestsPerMinute, 42);
    assert.strictEqual(j.safeMode.maxRequestsPerDay, 555);
  });

  await ok('/_config: сетевые настройки применяются на лету и редактируются', async () => {
    const on = await A('/_config', 'POST', {
      network: { proxy: '', dohUrl: '', dnsServers: ['1.1.1.1'], useEnvProxy: false },
      dnsServers: ['1.1.1.1'],
    });
    assert.strictEqual(on.status, 200, on.text);
    const j = JSON.parse(on.text);
    assert.strictEqual(j.network.dnsMode, 'custom');
    assert.deepStrictEqual(j.network.dnsServers, ['1.1.1.1']);
    assert.strictEqual(j.network.proxy, '');

    const off = await A('/_config', 'POST', {
      network: { proxy: '', dohUrl: '', dnsServers: [], useEnvProxy: false },
      dnsServers: [],
    });
    assert.strictEqual(JSON.parse(off.text).network.dnsMode, 'system');

    const status = await A('/_status');
    assert.strictEqual(status.status, 200);
    assert.ok(JSON.parse(status.text).network, '/_status не отдаёт network');
  });

  await ok('web-bridge unit: тесты lib/web_bridge.js (child process)', () =>
    new Promise((resolve, reject) => {
      const cp = require('child_process');
      cp.execFile(process.execPath, [path.join(__dirname, 'test_web_bridge.js')], { timeout: 60000 }, (e, stdout, stderr) => {
        if (e) return reject(new Error(stderr || stdout || e.message));
        resolve();
      });
    })
  );

  await ok('diagnostic chat HTTP integration: isolated local server and offline transports', () =>
    new Promise((resolve, reject) => {
      const cp = require('child_process');
      cp.execFile(process.execPath, [path.join(__dirname, 'test_diagnostics.js')], { timeout: 120000 }, (e, stdout, stderr) => {
        if (e) return reject(new Error(stderr || stdout || e.message));
        resolve();
      });
    })
  );

  await ok('cookie-extract unit: тесты scripts/extract_gemini_cookie.py (child process)', () =>
    new Promise((resolve, reject) => {
      const cp = require('child_process');
      const py = process.platform === 'win32' ? 'python' : 'python3';
      cp.execFile(py, [path.join(__dirname, 'test_cookie_extract.py')], { timeout: 60000 }, (e, stdout, stderr) => {
        if (e) return reject(new Error(stderr || stdout || e.message));
        resolve();
      });
    })
  );

  await ok('network unit: прокси, DoH, CONNECT, SOCKS5 (child process)', () =>
    new Promise((resolve, reject) => {
      const cp = require('child_process');
      cp.execFile(process.execPath, [path.join(__dirname, 'test_net.js')], { timeout: 120000 }, (e, stdout, stderr) => {
        if (e) return reject(new Error(stderr || stdout || e.message));
        resolve();
      });
    })
  );

  await ok('cookie CDP unit: mock /json/version + WebSocket (child process)', () =>
    new Promise((resolve, reject) => {
      const cp = require('child_process');
      const py = process.platform === 'win32' ? 'python' : 'python3';
      cp.execFile(py, [path.join(__dirname, 'test_cookie_cdp.py')], { timeout: 60000 }, (e, stdout, stderr) => {
        if (e) return reject(new Error(stderr || stdout || e.message));
        resolve();
      });
    })
  );

  await ok('model lists advertise cloud/ and web/ namespaced IDs', async () => {
    const r = await A('/v1/models');
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    const ids = j.data.map((m) => m.id);
    for (const id of ['web/gemini-4-argon', 'web/gemini-4-argon-thinking', 'web/gemini-4',
      'web/gemini-4-pro', 'web/gemini-4-flash', 'web/gemini-4-thinking']) {
      assert.ok(ids.includes(id), `web model not advertised: ${id}`);
    }
    const argon = j.data.find((m) => m.id === 'web/gemini-4-argon');
    assert.strictEqual(argon.owned_by, 'google-web');
    assert.strictEqual(argon.provider, 'web');
    assert.strictEqual(argon.capabilities.tools, 'emulated');
    assert.strictEqual(argon.capabilities.reliability, 'very-low');
    assert.equal(typeof argon.display_name, 'string');
    assert.ok(ids.includes('cloud/gemini-4-catalog-test'));
    assert.ok(!ids.includes('gemini-4-argon'), 'плоское имя не должно рекламироваться');
    // upstream-модели идут первыми с owned_by antigravity
    assert.strictEqual(j.data[0].owned_by, 'antigravity');
    assert.strictEqual(j.data[0].provider, 'cloud');
    assert.strictEqual(j.data[0].capabilities.tools, 'native');

    const rg = await A('/v1beta/models');
    const jg = JSON.parse(rg.text);
    const names = jg.models.map((m) => m.name);
    assert.ok(names.includes('models/web/gemini-4-argon'));
    assert.ok(names.includes('models/web/gemini-4-thinking'));
    assert.ok(names.includes('models/cloud/gemini-4-catalog-test'));
  });

  await ok('web-bridge config toggles advertise and hide Gemini 4 models', async () => {
    const off = await A('/_config', 'POST', { geminiWeb: { enabled: false } });
    assert.strictEqual(off.status, 200, off.text);
    let j = JSON.parse(off.text);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.geminiWeb.enabled, false, 'нет geminiWeb в ответе /_config');

    let r = await A('/v1/models');
    let ids = JSON.parse(r.text).data.map((m) => m.id);
    assert.ok(!ids.includes('web/gemini-4-argon'), 'web/gemini-4-argon должен исчезнуть при выключенном мосте');

    // запрос web/gemini-4-argon при выключенном мосте -> понятная 400
    const bad = await A('/v1/chat/completions', 'POST', { model: 'web/gemini-4-argon', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(bad.status, 400, bad.text);
    assert.strictEqual(JSON.parse(bad.text).error.type, 'invalid_request_error');
    assert.strictEqual(JSON.parse(bad.text).error.code, 'web_bridge_disabled');

    const on = await A('/_config', 'POST', { geminiWeb: { enabled: true, cookie: 'SAPISID=test-cookie-value; OTHER=1', temporaryChats: true } });
    j = JSON.parse(on.text);
    assert.strictEqual(j.geminiWeb.enabled, true);
    assert.strictEqual(j.geminiWeb.cookieSet, true, 'cookieSet не поднялся');
    assert.strictEqual(j.geminiWeb.temporaryChats, true);

    r = await A('/v1/models');
    ids = JSON.parse(r.text).data.map((m) => m.id);
    assert.ok(ids.includes('web/gemini-4-argon'), 'включение моста должно рекламировать web/gemini-4-argon');

    const lim = await A('/_limits');
    assert.strictEqual(JSON.parse(lim.text).geminiWeb.enabled, true, '/_limits не отдаёт geminiWeb');

    // вернуть нейтральное состояние моста для следующих тестов
    const reset = await A('/_config', 'POST', { geminiWeb: { cookie: '', temporaryChats: false } });
    assert.strictEqual(JSON.parse(reset.text).geminiWeb.cookieSet, false);
  });

  await ok('web-bridge: cookie_file загружается при пустом cookie (как сохраняет GUI)', async () => {
    const file = path.join(__dirname, '..', 'test_cookie_file_runtime.txt');
    fs.writeFileSync(file, 'SAPISID=file-cookie-sapisid; SID=s;');
    try {
      const r = await A('/_config', 'POST', {
        geminiWeb: { cookie: '', cookie_file: 'test_cookie_file_runtime.txt' },
      });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(JSON.parse(r.text).geminiWeb.cookieSet, true,
        'cookie_file проигнорирован при пустом cookie');

      const missing = await A('/_config', 'POST', {
        geminiWeb: { cookie: '', cookie_file: 'missing_cookie_file_runtime.txt' },
      });
      assert.strictEqual(JSON.parse(missing.text).geminiWeb.cookieSet, false,
        'несуществующий файл не должен считаться cookie');

      const reset = await A('/_config', 'POST', { geminiWeb: { cookie: '', cookie_file: '' } });
      assert.strictEqual(JSON.parse(reset.text).geminiWeb.cookieSet, false);
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  });

  await ok('web-bridge: countTokens для web/gemini-4 работает без сети', async () => {
    await new Promise((r) => setTimeout(r, 1300)); // cooldown после 429-теста
    const r = await A('/v1beta/models/web/gemini-4:countTokens', 'POST', { contents: [{ role: 'user', parts: [{ text: 'abcdefghij' }] }] });
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.totalTokens, 3); // 10 символов / 4 = 2.5 -> 3
  });

  await ok('web/* generation routes through web bridge with mode=8 (stubbed network)', async () => {
    const { GeminiWebBridge } = require('../lib/web_bridge.js');
    const orig = GeminiWebBridge.prototype.sendStreamRequestResilient;
    const seenPayloads = [];
    const STUB_TEXT = 'hello from stub: this is a deliberately long piece of generated text so the fake wrb.fr line passes the bridge length filter (150+ chars).';
    GeminiWebBridge.prototype.sendStreamRequestResilient = async function (bodyStr) {
      seenPayloads.push(bodyStr);
      const inner2 = [null, null, null, null, [[null, [STUB_TEXT]]]];
      const line = JSON.stringify([['wrb.fr', null, JSON.stringify(inner2)]]);
      async function* gen() { yield line + '\n'; }
      return gen();
    };
    try {
      for (const model of ['web/gemini-4-argon', 'web/gemini-4', 'web/gemini-4-pro', 'web/gemini-4-thinking']) {
        const r = await A('/v1/chat/completions', 'POST', {
          model, stream: false, messages: [{ role: 'user', content: 'test' }],
        });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(JSON.parse(r.text).choices[0].message.content, STUB_TEXT);
      }
      // обычный web-чат — чистый чат: tools клиента игнорируются, протокол не подмешивается
      const beforeTools = seenPayloads.length;
      const plain = await A('/v1/chat/completions', 'POST', {
        model: 'web/gemini-4-argon', stream: false,
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ type: 'function', function: { name: 'client_marker_tool', description: 'x', parameters: { type: 'object', properties: {} } } }],
      });
      assert.strictEqual(plain.status, 200, plain.text);
      const injected = seenPayloads.slice(beforeTools)
        .map((bodyStr) => JSON.parse(new URLSearchParams(bodyStr).get('f.req'))).join(' ');
      assert.ok(!injected.includes('client_marker_tool'), 'web-чат не должен инжектить tools клиента');

      // стримминг тоже идёт через мост
      const rs = await A('/v1/chat/completions', 'POST', {
        model: 'web/gemini-4-argon', stream: true, messages: [{ role: 'user', content: 'test' }],
      });
      assert.strictEqual(rs.status, 200, rs.text);
      assert.ok(rs.headers['content-type'].includes('text/event-stream'));
      const streamed = rs.sse
        .filter((c) => c.choices && c.choices[0].delta && c.choices[0].delta.content)
        .map((c) => c.choices[0].delta.content).join('');
      assert.strictEqual(streamed, STUB_TEXT);
      // нативный Gemini-эндпоинт тоже идёт через мост
      const g = await A('/v1beta/models/web/gemini-4-argon:generateContent', 'POST', {
        contents: [{ role: 'user', parts: [{ text: 'test' }] }],
      });
      assert.strictEqual(g.status, 200, g.text);
      // проверяем, что в веб-протокол ушёл именно mode=8 (Argon)
      assert.ok(seenPayloads.length > 0, 'bridge never sent a payload');
      for (const bodyStr of seenPayloads) {
        const outer = JSON.parse(new URLSearchParams(bodyStr).get('f.req'));
        const inner = JSON.parse(outer[1]);
        assert.strictEqual(inner[79], 8, 'web payload must select mode=8 (Argon)');
      }
    } finally {
      GeminiWebBridge.prototype.sendStreamRequestResilient = orig;
    }
  });

  await ok('cloud catalog IDs stay cloud/ even when bridge disabled', async () => {
    const model = 'cloud/gemini-4-catalog-test';
    await A('/_config', 'POST', { geminiWeb: { enabled: false } });
    try {
      for (const stream of [false, true]) {
        const r = await A('/v1/chat/completions', 'POST', {
          model, stream, messages: [{ role: 'user', content: 'test' }],
        });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(mockUp.state.lastBody.model, 'gemini-4-catalog-test');
      }
      for (const method of ['generateContent', 'streamGenerateContent', 'countTokens']) {
        const r = await A(`/v1beta/models/${model}:${method}`, 'POST', {
          contents: [{ role: 'user', parts: [{ text: 'test' }] }],
        });
        assert.strictEqual(r.status, 200, r.text);
        if (method === 'countTokens') assert.strictEqual(JSON.parse(r.text).totalTokens, 42);
      }
    } finally {
      await A('/_config', 'POST', { geminiWeb: { enabled: true } });
    }
  });

  await ok('namespace: unknown flat names -> 400, known catalog ids auto-resolve', async () => {
    const legacy = await A('/v1/chat/completions', 'POST', { model: 'not-a-real-model', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(legacy.status, 400, legacy.text);
    const lj = JSON.parse(legacy.text);
    assert.strictEqual(lj.error.type, 'invalid_request_error');
    assert.strictEqual(lj.error.code, 'model_namespace_required');
    assert.ok(Array.isArray(lj.error.hint.examples) && lj.error.hint.examples.includes('cloud/gemini-3-flash'));

    const flat = await A('/v1/chat/completions', 'POST', { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'echo' }] });
    assert.strictEqual(flat.status, 200, flat.text);
    const fj = JSON.parse(flat.text);
    assert.strictEqual(fj.model, 'cloud/gemini-3-flash');
    assert.strictEqual(fj.choices[0].message.content, 'Привет, мир');

    const unknown = await A('/v1/chat/completions', 'POST', { model: 'web/gemini-9-nope', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(unknown.status, 400, unknown.text);
    assert.strictEqual(JSON.parse(unknown.text).error.code, 'model_not_found');

    const ns = await A('/v1/chat/completions', 'POST', { model: 'gpt/whatever', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(ns.status, 400, ns.text);
    assert.strictEqual(JSON.parse(ns.text).error.code, 'model_namespace_invalid');

    const native = await A('/v1beta/models/not-a-real-model:generateContent', 'POST', { contents: [{ role: 'user', parts: [{ text: 'x' }] }] });
    assert.strictEqual(native.status, 400, native.text);
    assert.strictEqual(JSON.parse(native.text).error.code, 'model_namespace_required');

    const flatNative = await A('/v1beta/models/gemini-3-flash:generateContent', 'POST', { contents: [{ role: 'user', parts: [{ text: 'привет' }] }] });
    assert.strictEqual(flatNative.status, 200, flatNative.text);
    assert.strictEqual(JSON.parse(flatNative.text).candidates[0].content.parts[0].text, 'Привет, мир');

    // %2F в пути маршрута тоже распознаётся как разделитель namespace.
    const enc = await A('/v1beta/models/cloud%2Fgemini-3-flash:countTokens', 'POST', { contents: [{ role: 'user', parts: [{ text: 'привет' }] }] });
    assert.strictEqual(enc.status, 200, enc.text);
    assert.strictEqual(JSON.parse(enc.text).totalTokens, 42);
  });

  await ok('GET single model: OpenAI и Gemini SDK получают карточку модели', async () => {
    const oa = await A('/v1/models/cloud%2Fgemini-3-flash');
    assert.strictEqual(oa.status, 200, oa.text);
    const oj = JSON.parse(oa.text);
    assert.strictEqual(oj.id, 'cloud/gemini-3-flash');
    assert.strictEqual(oj.object, 'model');

    const gm = await A('/v1beta/models/cloud%2Fgemini-3-flash');
    assert.strictEqual(gm.status, 200, gm.text);
    const gj = JSON.parse(gm.text);
    assert.strictEqual(gj.name, 'models/cloud/gemini-3-flash');
    assert.ok(gj.supportedGenerationMethods.includes('generateContent'));

    const gmPrefix = await A('/v1beta/models/models%2Fcloud%2Fgemini-3-flash');
    assert.strictEqual(gmPrefix.status, 200, gmPrefix.text);

    const missing = await A('/v1/models/cloud%2Fnope');
    assert.strictEqual(missing.status, 404, missing.text);
    assert.strictEqual(JSON.parse(missing.text).error.code, 'model_not_found');
  });

  await ok('валидация: model и непустые messages обязательны', async () => {
    const noModel = await A('/v1/chat/completions', 'POST', { messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(noModel.status, 400, noModel.text);
    assert.match(JSON.parse(noModel.text).error.message, /model is required/i);

    const noMsg = await A('/v1/chat/completions', 'POST', { model: 'cloud/gemini-3-flash', messages: [] });
    assert.strictEqual(noMsg.status, 400, noMsg.text);
    assert.match(JSON.parse(noMsg.text).error.message, /non-empty/i);
  });

  await ok('cloud -agent: thought-часть не съедает финальный текст', async () => {
    const r = await A('/v1/chat/completions', 'POST', {
      model: 'cloud/echo-model-agent', messages: [{ role: 'user', content: 'THINK_AGENT' }],
    });
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.choices[0].message.content, 'Финальный ответ');
  });

  await ok('web agent: disabled by default, works only with agent.allowWebAgent=true', async () => {
    const { GeminiWebBridge } = require('../lib/web_bridge.js');
    const orig = GeminiWebBridge.prototype.sendStreamRequestResilient;
    const STUB_TEXT = 'web-agent stub answer: a long enough fake response that contains no tool_call fences, so the loop completes after the first iteration (agent text protocol emulation).';
    GeminiWebBridge.prototype.sendStreamRequestResilient = async function () {
      const line = JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [[null, [STUB_TEXT]]]])]]);
      async function* gen() { yield line + '\n'; }
      return gen();
    };
    try {
      const blocked = await A('/v1/chat/completions', 'POST', { model: 'web/gemini-4-argon-agent', messages: [{ role: 'user', content: 'test' }] });
      assert.strictEqual(blocked.status, 400, blocked.text);
      const bj = JSON.parse(blocked.text);
      assert.strictEqual(bj.error.code, 'web_agent_disabled');
      assert.match(bj.error.message, /VERY unreliable/);

      // tools:"builtin" на обычной web-модели — тоже агентский триггер и тоже заблокирован.
      const blockedBuiltin = await A('/v1/chat/completions', 'POST', {
        model: 'web/gemini-4-argon', messages: [{ role: 'user', content: 'test' }], tools: 'builtin',
      });
      assert.strictEqual(blockedBuiltin.status, 400, blockedBuiltin.text);
      assert.strictEqual(JSON.parse(blockedBuiltin.text).error.code, 'web_agent_disabled');

      const on = await A('/_config', 'POST', { agent: { allowWebAgent: true } });
      assert.strictEqual(on.status, 200, on.text);

      const run = await A('/v1/chat/completions', 'POST', { model: 'web/gemini-4-argon-agent', messages: [{ role: 'user', content: 'test' }] });
      assert.strictEqual(run.status, 200, run.text);
      const j = JSON.parse(run.text);
      assert.strictEqual(j.model, 'web/gemini-4-argon-agent');
      assert.strictEqual(j.choices[0].message.content, STUB_TEXT);
      assert.strictEqual(j.agent.provider, 'web');
      assert.strictEqual(j.agent.reliability, 'very-low');
      assert.match(j.agent.warning, /VERY unreliable/);
      assert.strictEqual(j.agent.completed, true);
      assert.strictEqual(j.agent.planner, undefined, 'веб-циклу planner не предлагается');
    } finally {
      GeminiWebBridge.prototype.sendStreamRequestResilient = orig;
      await A('/_config', 'POST', { agent: { allowWebAgent: false } });
    }
  });

  await ok('cloud -agent: native functionCall loop writes files in the sandbox', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-agent-ws-'));
    try {
      const r = await A('/v1/chat/completions', 'POST', {
        model: 'cloud/echo-model-agent',
        messages: [{ role: 'user', content: 'AGENT_WRITE' }],
        agent: { workspaceRoot: ws, auditFile: path.join(ws, 'audit.jsonl'), maxIterations: 3 },
      });
      assert.strictEqual(r.status, 200, r.text);
      const j = JSON.parse(r.text);
      assert.strictEqual(j.model, 'cloud/echo-model-agent');
      assert.strictEqual(j.agent.provider, 'cloud');
      assert.strictEqual(j.agent.reliability, 'high');
      assert.strictEqual(j.agent.completed, true);
      assert.ok(Array.isArray(j.agent.actions) && j.agent.actions.length === 1, JSON.stringify(j.agent.actions));
      assert.strictEqual(j.agent.actions[0].tool, 'write_file');
      assert.strictEqual(j.agent.actions[0].ok, true);
      assert.strictEqual(fs.readFileSync(path.join(ws, 'agent-loop.txt'), 'utf8'), 'native-loop');

      // Второй upstream-запрос: functionResponse + thought signature сохранены,
      // tools объявлены (нативный function calling, без текстовой склейки).
      const sent = mockUp.state.lastBody.request;
      const toolPart = sent.contents.find((c) => c.role === 'user' && c.parts[0].functionResponse);
      assert.ok(toolPart, 'functionResponse не передан в upstream');
      assert.strictEqual(toolPart.parts[0].functionResponse.name, 'write_file');
      const modelParts = sent.contents.filter((c) => c.role === 'model').flatMap((c) => c.parts);
      const fcPart = modelParts.find((p) => p.functionCall);
      assert.ok(fcPart, 'functionCall не сохранён в транскрипте');
      assert.strictEqual(fcPart.thoughtSignature, 'mock-agent-sig');
      assert.ok(sent.tools[0].functionDeclarations.some((d) => d.name === 'write_file'));
      assert.ok(j.agent.planner, 'planner stats должны быть в ответе cloud-цикла');
      assert.strictEqual(j.agent.planner.calls, 0);
    } finally {
      removeTree(ws);
    }
  });

  await ok('cloud -agent: параллельные вызовы -> ответы одним user-ходом', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-agent-ws-'));
    try {
      const r = await A('/v1/chat/completions', 'POST', {
        model: 'cloud/echo-model-agent',
        messages: [{ role: 'user', content: 'AGENT_PARALLEL' }],
        agent: { workspaceRoot: ws, auditFile: path.join(ws, 'audit.jsonl'), maxIterations: 3 },
      });
      assert.strictEqual(r.status, 200, r.text);
      const j = JSON.parse(r.text);
      assert.strictEqual(j.choices[0].message.content, 'Оба файла записаны.');
      assert.deepStrictEqual(j.agent.actions.map((a) => [a.tool, a.ok]), [['write_file', true], ['write_file', true]]);
      assert.strictEqual(fs.readFileSync(path.join(ws, 'p1.txt'), 'utf8'), 'один');
      assert.strictEqual(fs.readFileSync(path.join(ws, 'p2.txt'), 'utf8'), 'два');

      // Gemini требует: сколько functionCall в ходе модели, столько functionResponse в следующем ходе.
      const contents = mockUp.state.lastBody.request.contents;
      const callTurn = contents.findIndex((c) => c.role === 'model' && c.parts.some((p) => p.functionCall));
      assert.ok(callTurn >= 0, 'functionCall не сохранён в транскрипте');
      assert.strictEqual(contents[callTurn].parts.filter((p) => p.functionCall).length, 2);
      assert.strictEqual(contents[callTurn].parts[0].thoughtSignature, 'mock-parallel-sig');
      assert.strictEqual(contents[callTurn + 1].role, 'user');
      assert.deepStrictEqual(contents[callTurn + 1].parts.map((p) => p.functionResponse?.name), ['write_file', 'write_file']);
      assert.strictEqual(contents.length, callTurn + 2, 'после ответов инструментов не должно быть лишних ходов');
    } finally {
      removeTree(ws);
    }
  });

  await ok('planner: cloud loop can consult web model, stats and file write', async () => {
    const { GeminiWebBridge } = require('../lib/web_bridge.js');
    const orig = GeminiWebBridge.prototype.generate;
    const seen = [];
    GeminiWebBridge.prototype.generate = async function (prompt, modelId, thinkMode) {
      seen.push({ prompt, modelId, thinkMode });
      return '1. Прочитать задачу.\n2. Записать файл.\n3. Проверить результат.';
    };
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-planner-ws-'));
    mockUp.state.plannerSteps = 0;
    try {
      const r = await A('/v1/chat/completions', 'POST', {
        model: 'cloud/echo-model-agent',
        messages: [{ role: 'user', content: 'PLANNER_TASK' }],
        agent: { workspaceRoot: ws, auditFile: path.join(ws, 'audit.jsonl'), maxIterations: 4 },
      });
      assert.strictEqual(r.status, 200, r.text);
      const j = JSON.parse(r.text);
      assert.deepStrictEqual(j.agent.actions.map((a) => a.tool), ['ask_planner', 'write_file']);
      assert.ok(j.agent.actions.every((a) => a.ok === true), JSON.stringify(j.agent.actions));
      assert.strictEqual(j.agent.planner.calls, 1);
      assert.strictEqual(j.agent.planner.errors, 0);
      assert.strictEqual(j.agent.planner.model, 'web/gemini-4-argon-thinking');
      assert.strictEqual(seen.length, 1, 'planner должен вызвать bridge.generate ровно один раз');
      assert.ok(seen[0].prompt.includes('Question:') && seen[0].prompt.includes('Как спланировать'));
      assert.strictEqual(seen[0].modelId, 8);
      assert.strictEqual(seen[0].thinkMode, 0);
      assert.strictEqual(fs.readFileSync(path.join(ws, 'planner-loop.txt'), 'utf8'), 'после плана');
    } finally {
      GeminiWebBridge.prototype.generate = orig;
      removeTree(ws);
    }
  });

  await ok('guard: дневные+недельные лимиты, cooldown, история, персистентность', async () => {
    const { Guard, parseResetMs } = require('../lib/guard.js');
    const sf = path.join(os.tmpdir(), 'guard-state-' + Date.now() + '.json');
    // недельный лимит
    const g = new Guard({ maxRequestsPerMinute: 100, maxRequestsPerDay: 100, maxRequestsPerWeek: 3, minIntervalMs: 0, jitterMs: 0, maxConcurrent: 5 }, sf);
    assert.ok((await g.acquire('gemini-1')).ok);
    assert.ok((await g.acquire('gemini-2')).ok);
    assert.ok((await g.acquire('gemini-3')).ok);
    const fourth = await g.acquire('gemini-4');
    assert.ok(!fourth.ok && fourth.reason.includes('недельный'), fourth.reason);
    g.reportUsage(123);
    assert.strictEqual(g.summary().week.tokens, 123);
    // минутный лимит — отдельный файл состояния, чтобы не мешать недельному счёту
    const sf2 = path.join(os.tmpdir(), 'guard-state2-' + Date.now() + '.json');
    const g3 = new Guard({ maxRequestsPerMinute: 1, minIntervalMs: 0, jitterMs: 0, maxConcurrent: 5 }, sf2);
    assert.ok((await g3.acquire('gpt-1')).ok);
    const second = await g3.acquire('gpt-2');
    assert.ok(!second.ok && second.reason.includes('/мин'), second.reason);
    fs.unlinkSync(sf2);
    // cooldown по семейству claude
    g.report429('claude-x', parseResetMs('Resets in 5m'));
    const cd = g.checkImmediate('claude-x');
    assert.ok(!cd.ok && cd.reason.includes('claude'));
    // gemini не задет cooldown'ом claude (но недельный лимит активен)
    const gem = g.checkImmediate('gemini-x');
    assert.ok(!gem.ok && gem.reason.includes('недельный'));
    // персистентность: новый инстанс видит счётчики, историю и cooldown
    const g2 = new Guard({ maxRequestsPerWeek: 1000, maxRequestsPerDay: 1000 }, sf);
    const cd2 = g2.checkImmediate('claude-anything');
    assert.ok(!cd2.ok && cd2.reason.includes('claude'));
    const s = g2.summary();
    assert.strictEqual(s.requestsToday, 3, 'requestsToday');
    assert.strictEqual(s.week.requests, 3, 'week.requests');
    assert.strictEqual(s.days.length, 7);
    assert.ok(s.days[6].requests >= 3, 'история за сегодня');
    assert.ok(parseResetMs('Resets in 138h27m9s') === (138 * 3600 + 27 * 60 + 9) * 1000);
    assert.ok(parseResetMs('Resets in 30s') === 30000);
    fs.unlinkSync(sf);
  });

  await ok('413: превышение Content-Length отбивается до чтения тела', async () => {
    // Сервер обязан отдать 413 по одному заголовку, не вычитывая 17 МБ,
    // и не рвать сокет так, чтобы клиент увидел «socket hang up».
    const total = 17 * 1024 * 1024;
    const r = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const req = http.request({
        host: '127.0.0.1', port: PORT_API, path: '/v1/chat/completions', method: 'POST',
        headers: { ...AUTH(), 'content-type': 'application/json', 'content-length': String(total) },
      }, (res) => {
        const ch = [];
        res.on('data', (c) => ch.push(c));
        res.on('end', () => finish({ status: res.statusCode, text: Buffer.concat(ch).toString('utf8') }));
        res.on('error', () => finish({ status: 0 }));
      });
      req.on('error', () => finish({ status: -1 }));
      const timer = setTimeout(() => { req.destroy(); finish({ status: -2 }); }, 5000);
      req.on('close', () => clearTimeout(timer));
      req.flushHeaders(); // тело не отправляем: проверяем именно проверку заголовка
    });
    assert.strictEqual(r.status, 413, 'ожидался 413, получено: ' + r.status);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.error.code, 'body_too_large');
    assert.match(j.error.message, /МБ/);
  });

  await ok('413: потоковое тело без Content-Length тоже не вешает соединение', async () => {
    const total = 17 * 1024 * 1024;
    const r = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const req = http.request({
        host: '127.0.0.1', port: PORT_API, path: '/v1/chat/completions', method: 'POST',
        headers: { ...AUTH(), 'content-type': 'application/json' }, // chunked
      }, (res) => {
        const ch = [];
        res.on('data', (c) => ch.push(c));
        res.on('end', () => finish({ status: res.statusCode }));
        res.on('error', () => finish({ status: 0 }));
      });
      // Обрыв допустим (клиент не дочитал ответ), зависание — нет.
      req.on('error', () => setTimeout(() => finish({ status: -1 }), 500));
      const timer = setTimeout(() => { req.destroy(); finish({ status: -2 }); }, 8000);
      req.on('close', () => clearTimeout(timer));
      const chunk = Buffer.alloc(1024 * 1024, 97);
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          if (req.destroyed) return;
          sent += chunk.length;
          if (!req.write(chunk)) { req.once('drain', pump); return; }
        }
        req.end();
      };
      pump();
    });
    assert.ok(r.status === 413 || r.status === 0 || r.status === -1, 'нет ответа и нет обрыва: ' + r.status);
  });

  await ok('отмена: клиент отключается во время стрима -> апстрим обрывается, в лог 499', async () => {
    // Медленный апстрим: шлём первый чанк и держим соединение открытым.
    const closedByServer = new Promise((resolve) => {
      mockUp.state.onSlowClose = () => resolve(true);
    });
    const req = http.request({
      host: '127.0.0.1', port: PORT_API, path: '/v1/chat/completions', method: 'POST',
      headers: { ...AUTH(), 'content-type': 'application/json' },
    });
    req.on('error', () => {});
    req.write(JSON.stringify({ model: 'cloud/echo-model', stream: true, messages: [{ role: 'user', content: 'SLOW_STREAM' }] }));
    req.end();
    const res = await new Promise((r) => req.once('response', r));
    assert.strictEqual(res.statusCode, 200);
    await new Promise((r) => res.once('data', r)); // получили первый чанк
    const t0 = Date.now();
    req.destroy(); // клиент закрыл вкладку
    const aborted = await Promise.race([closedByServer, new Promise((r) => setTimeout(() => r(false), 3000))]);
    assert.strictEqual(aborted, true, 'апстрим-соединение не закрылось за 3 с');
    assert.ok(Date.now() - t0 < 3000);
  });

  await ok('отмена (Gemini-нативный стрим): апстрим обрывается при уходе клиента', async () => {
    const closedByServer = new Promise((resolve) => { mockUp.state.onSlowClose = () => resolve(true); });
    const req = http.request({
      host: '127.0.0.1', port: PORT_API, path: '/v1beta/models/cloud/echo-model:streamGenerateContent?alt=sse', method: 'POST',
      headers: { ...AUTH(), 'content-type': 'application/json' },
    });
    req.on('error', () => {});
    req.write(JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'SLOW_STREAM' }] }] }));
    req.end();
    const res = await new Promise((r) => req.once('response', r));
    assert.strictEqual(res.statusCode, 200);
    await new Promise((r) => res.once('data', r));
    req.destroy();
    const aborted = await Promise.race([closedByServer, new Promise((r) => setTimeout(() => r(false), 3000))]);
    assert.strictEqual(aborted, true, 'апстрим-соединение не закрылось за 3 с');
  });

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  if (failures.length) for (const f of failures) console.error(`\n=== ${f.name}\n`, f.e);

  await new Promise((r) => api1.server.close(r));
  mockOAuth.server.closeIdleConnections?.();
  mockOAuth.server.close();
  mockUp.server.closeIdleConnections?.();
  mockUp.server.close();
  try { fs.unlinkSync(authFile); } catch {}
  try { fs.unlinkSync(usageFile); } catch {}
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

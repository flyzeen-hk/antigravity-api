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

const { start } = require('../server.js');

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
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const text = JSON.stringify(body.request);
      const isCallTool = text.includes('CALL_TOOL');

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

  await ok('GET /v1/models: каталог + фильтрация tab_*/chat_*', async () => {
    const r = await A('/v1/models');
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    const ids = j.data.map((m) => m.id);
    assert.ok(ids.includes('gemini-3-flash'));
    assert.ok(ids.includes('claude-sonnet-4-6'));
    assert.ok(!ids.includes('chat_20706'));
    assert.ok(!ids.includes('tab_flash_lite_preview'));
    assert.strictEqual(j.data[0].owned_by, 'antigravity');
  });

  await ok('chat/completions non-stream: текст + usage + finish', async () => {
    const r = await A('/v1/chat/completions', 'POST', {
      model: 'gemini-3-flash',
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
      model: 'echo-model',
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
      model: 'echo-model',
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
    const r = await A('/v1/chat/completions', 'POST', { model: 'CALL_TOOL', messages: [{ role: 'user', content: 'CALL_TOOL' }] });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(j.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.deepStrictEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments), { city: 'Москва' });
    assert.strictEqual(j.choices[0].message.content, null);
    assert.strictEqual(j.choices[0].message.tool_calls[0].thought_signature, 'mock-sig-123');

    // Проверяем возврат thoughtSignature в следующем запросе (диалог продолжается)
    const returnedCall = j.choices[0].message.tool_calls[0];
    await A('/v1/chat/completions', 'POST', {
      model: 'echo-model',
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
      model: 'echo-model',
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
    const r = await A('/v1/chat/completions', 'POST', { model: 'gemini-3-flash', stream: true, messages: [{ role: 'user', content: 'привет' }] });
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
    const r = await A('/v1/chat/completions', 'POST', { model: 'echo-model', stream: true, messages: [{ role: 'user', content: 'echo' }] });
    const ev = r.sse;
    const hasThought = ev.some((c) => c.choices?.[0]?.delta?.reasoning_content !== undefined);
    assert.ok(!hasThought, 'reasoning_content не должно быть при includeThoughts=false');
    const content = ev.map((c) => c.choices?.[0]?.delta?.content).filter(Boolean).join('');
    assert.ok(content.startsWith('ECHO:'));
  });

  await ok('429 от апстрима -> rate_limit_error с сообщением о квоте', async () => {
    const r = await A('/v1/chat/completions', 'POST', { model: 'quota-model', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(r.status, 429);
    const j = JSON.parse(r.text);
    assert.strictEqual(j.error.type, 'rate_limit_error');
    assert.ok(j.error.message.includes('Resets in'), j.error.message);
  });

  await ok('Gemini-нативный: generateContent без обёртки', async () => {
    await new Promise((r) => setTimeout(r, 1300)); // ждём окончания cooldown после 429-теста (maxCooldownMs=1000)
    const r = await A('/v1beta/models/gemini-3-flash:generateContent', 'POST', { contents: [{ role: 'user', parts: [{ text: 'привет' }] }] });
    assert.strictEqual(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.ok(!j.response, 'обёртка должна быть развёрнута');
    assert.strictEqual(j.candidates[0].content.parts[0].text, 'Привет, мир');
    assert.strictEqual(j.candidates[0].finishReason, 'STOP');
  });

  await ok('Gemini-нативный: streamGenerateContent SSE развёрнутый', async () => {
    const r = await A('/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse', 'POST', { contents: [{ role: 'user', parts: [{ text: 'привет' }] }] });
    const j = r.sse;
    assert.ok(j.length >= 3);
    assert.ok(!j[0].response, 'нет обёртки');
    assert.strictEqual(j[j.length - 1].candidates[0].finishReason, 'STOP');
    assert.ok(j[j.length - 1].usageMetadata.totalTokenCount === 18);
  });

  await ok('countTokens: unwrap response', async () => {
    const r = await A('/v1beta/models/gemini-3-flash:countTokens', 'POST', { contents: [{ role: 'user', parts: [{ text: 'привет' }] }] });
    const j = JSON.parse(r.text);
    assert.strictEqual(j.totalTokens, 42);
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

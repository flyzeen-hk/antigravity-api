'use strict';

// Run: node test/test_diagnostics.js
// Real HTTP route and response parsers; only external transports are replaced.
const assert = require('assert/strict');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const REGION_REASON = 'User location is not supported for the API use';
const UPSTREAM_ONLY = 'UPSTREAM_PRIVATE_DIAGNOSTIC_73e9';
process.env.AG_SIG_FILE = path.join(os.tmpdir(), `ag-test-sigs-${process.pid}.json`);
process.on('exit', () => removeTree(process.env.AG_SIG_FILE));
const { removeTree } = require('../lib/safe_files');
const { GeminiWebBridge } = require('../lib/web_bridge');
const { start } = require('../server');

const API_MODEL = 'cloud/claude-sonnet-4-6';
const WEB_MODEL = 'web/gemini-4-argon';
const EXACT_MODEL = 'cloud/gemini-4-pro'; // cloud/ prefix wins over an identically named web alias in auto mode.
const API_BASE = API_MODEL.slice('cloud/'.length);
const EXACT_BASE = EXACT_MODEL.slice('cloud/'.length);
const MESSAGE = 'Проверка: hello, мир!';
const ANSWER = 'Связь работает ✓';
// Synthetic, deliberately recognizable credentials; never read real user secrets.
const SECRETS = {
  key: 'agk_DIAGNOSTIC_KEY_91f46cb70fdd',
  access: 'ya29.DIAGNOSTIC_ACCESS_279ac8d4e001',
  refresh: '1//DIAGNOSTIC_REFRESH_9de05b7c432a',
  cookie: 'DIAGNOSTIC_COOKIE_a760be1432fc',
  xsrf: 'DIAGNOSTIC_XSRF_c914eb3705a2',
  foreign: 'sk-DIAGNOSTIC_FOREIGN_451daca192bc',
};
const LEAK = `Authorization: Bearer ${SECRETS.access}; api_key=${SECRETS.key}; ` +
  `refresh_token=${SECRETS.refresh}; Cookie: SAPISID=${SECRETS.cookie}; ` +
  `at=${SECRETS.xsrf}; token=${SECRETS.foreign}; ${UPSTREAM_ONLY}`;

function webFrame(value) {
  return JSON.stringify([['wrb.fr', null, JSON.stringify(value)]]) + '\n';
}

function assertSafe(text) {
  assert.ok(!text.includes(UPSTREAM_ONLY), 'Error/log discloses upstream diagnostic text');
  for (const secret of Object.values(SECRETS)) {
    assert.ok(!text.includes(secret), 'Error discloses a synthetic credential');
    assert.ok(!text.includes(secret.slice(-12)), 'Error discloses a credential fragment');
  }
}

function errorContract(result, status, stage, cause) {
  assert.equal(result.status, status, result.text);
  assert.match(result.headers['content-type'] || '', /application\/json/i);
  assertSafe(result.text);
  const body = JSON.parse(result.text);
  assert.equal(body.ok, false, result.text);
  assert.ok(!Object.hasOwn(body, 'response'), 'Failure cannot also contain a successful response');
  assert.ok(body.error && typeof body.error === 'object');
  const error = body.error;
  for (const key of ['code', 'message', 'stage', 'details']) {
    assert.ok(Object.hasOwn(error, key), `Missing error.${key}`);
  }
  assert.equal(typeof error.code, 'string', 'Diagnostic code must be a stable string, not an HTTP number');
  assert.match(error.code, /^[a-z][a-z0-9_]*$/i);
  assert.equal(error.stage, stage, result.text);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.trim().length > 20, 'Explain the failure instead of only returning a status/code');
  assert.match(error.message, cause, 'Error must explain this particular cause');
  assert.match(error.message, /проверь|выбер|укаж|введ|включ|повтор|обнов|войд|дожд|использ|убер|долж[еннао]+|check|select|provide|enter|enable|retry|try|refresh|sign.?in|wait|use /i,
    'Error should tell the user what to check or do');
  // details must be explicitly null or structured safe metadata, never a raw upstream body/stack.
  assert.ok(error.details === null || (typeof error.details === 'object' && !Array.isArray(error.details)),
    'details must be null or a JSON metadata object');
  if (error.details) {
    assert.ok(!Object.hasOwn(error.details, 'stack'), 'details must not expose an exception stack');
    assert.ok(!Object.hasOwn(error.details, 'headers'), 'details must not forward upstream headers');
    if (Object.hasOwn(error.details, 'httpStatus')) {
      assert.ok(Number.isInteger(error.details.httpStatus) && error.details.httpStatus >= 400 && error.details.httpStatus <= 599,
        'details.httpStatus must be a numeric upstream error status');
    }
    if (Object.hasOwn(error.details, 'bridge')) assert.ok(['api', 'web'].includes(error.details.bridge));
    if (Object.hasOwn(error.details, 'field')) assert.ok(['model', 'message', 'bridge'].includes(error.details.field));
    assertSafe(JSON.stringify(error.details));
  }
  return error;
}

function request(port, route, body, { raw = false, authorize = true, key = SECRETS.key, method = 'POST' } = {}) {
  const text = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? null : raw ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false, headers: {
      ...(authorize ? { authorization: 'Bearer ' + key } : {}),
      ...(text === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }),
    } }, res => {
      let wire = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { wire += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: wire }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Diagnostic regression request timed out')));
    req.on('error', reject);
    req.end(text);
  });
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-diagnostics-'));
  const savedEnv = { AG_AUTH_FILE: process.env.AG_AUTH_FILE, AG_USAGE_FILE: process.env.AG_USAGE_FILE };
  const original = { fetch: global.fetch, httpRequest: http.request, httpsRequest: https.request,
    send: GeminiWebBridge.prototype.sendStreamRequestResilient,
    fresh: GeminiWebBridge.prototype.ensureBlFresh, cookie: GeminiWebBridge.prototype.getLoadedCookie,
    xsrf: GeminiWebBridge.prototype.ensureXsrf, rotate: GeminiWebBridge.prototype.rotateCookies };
  const calls = { api: [], web: [] };
  const failures = [];
  const unexpected = [];
  const logs = [];
  const originalConsole = { log: console.log, error: console.error, warn: console.warn };
  for (const method of Object.keys(originalConsole)) {
    console[method] = (...args) => { logs.push(args.map(String).join(' ')); };
  }
  let mode = 'success';
  let api;
  let passed = 0;
  async function check(name, fn) {
    mode = 'success';
    const logStart = logs.length;
    try {
      await fn();
      assertSafe(logs.slice(logStart).join('\n'));
      passed++;
      originalConsole.log('PASS ' + name);
    } catch (error) {
      failures.push(new Error(name + ': ' + error.message));
      originalConsole.error('FAIL ' + name + ': ' + error.message);
    } finally { mode = 'success'; }
  }
  try {
    process.env.AG_AUTH_FILE = path.join(temp, 'auth.json');
    process.env.AG_USAGE_FILE = path.join(temp, 'usage.json');
    fs.writeFileSync(process.env.AG_AUTH_FILE, JSON.stringify({ access_token: SECRETS.access,
      refresh_token: SECRETS.refresh, access_expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    // Fail closed: even an unintended OAuth, BL refresh or proxy request cannot reach the network.
    https.request = (options, callback) => {
      if (mode !== 'http-region' || options.host !== 'gemini.google.com') {
        unexpected.push('https.request');
        throw new Error('External HTTPS forbidden in diagnostics tests');
      }
      const req = new EventEmitter();
      req.write = () => true;
      req.end = () => {
        const res = Readable.from([JSON.stringify({ error: { message: REGION_REASON + '. ' + LEAK } })]);
        res.statusCode = 400;
        res.headers = { 'x-upstream-private': LEAK };
        process.nextTick(() => callback(res));
      };
      req.destroy = error => req.emit('error', error);
      return req;
    };
    http.request = function (options, ...args) {
      if (!options || options.hostname !== '127.0.0.1' || !api || options.port !== api.server.address()?.port) {
        unexpected.push('http.request');
        throw new Error('Only the local diagnostic server is allowed');
      }
      return original.httpRequest.call(this, options, ...args);
    };
    global.fetch = async (url, options) => {
      const parsed = new URL(url);
      if (!['http://diagnostics.invalid', 'http://diagnostics-fallback.invalid'].includes(parsed.origin)) {
        unexpected.push('fetch origin');
        throw new Error('External fetch forbidden in diagnostics tests');
      }
      if (parsed.pathname === '/v1internal:fetchAvailableModels') {
        return new Response(JSON.stringify({ models: Object.fromEntries([API_BASE, EXACT_BASE]
          .map(id => [id, { displayName: 'Offline ' + id }])) }));
      }
      if (parsed.pathname !== '/v1internal:generateContent') {
        unexpected.push('fetch route');
        throw new Error('Unexpected offline upstream route');
      }
      const payload = JSON.parse(options.body);
      calls.api.push(payload);
      if (mode === 'refused') return new Response(JSON.stringify({ error: { code: 503,
        message: 'Service unavailable. ' + LEAK, details: { headers: LEAK, nested: [SECRETS.foreign] } } }), { status: 503 });
      if (mode === 'network' || mode === 'fallback-network') throw new Error('Network connection failed. ' + LEAK);
      if (mode === 'region') return new Response(JSON.stringify({ error: { message: REGION_REASON + '. ' + LEAK } }), { status: 400 });
      const response = { candidates: [{ content: { role: 'model', parts: mode === 'empty' ? [] : [{ text: ANSWER }] }, finishReason: 'STOP' }] };
      return new Response('data: ' + JSON.stringify({ response }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    GeminiWebBridge.prototype.ensureBlFresh = async function () { return this.bl; };
    GeminiWebBridge.prototype.ensureXsrf = async function () { return ''; };
    GeminiWebBridge.prototype.rotateCookies = async function () { return false; };
    GeminiWebBridge.prototype.getLoadedCookie = () => ({ cookieStr: `SAPISID=${SECRETS.cookie}`, sapisid: SECRETS.cookie });
    GeminiWebBridge.prototype.sendStreamRequestResilient = async function (payload, meta) {
      const inner = JSON.parse(JSON.parse(new URLSearchParams(payload).get('f.req'))[1]);
      calls.web.push({ inner, meta });
      if (mode === 'http-region') return this.sendStreamRequest(payload, meta);
      if (mode === 'region') return Readable.from([webFrame({ error: { code: 400, message: REGION_REASON + '. ' + LEAK } })]);
      if (mode === 'bard-other') return Readable.from(['BardErrorInfo [1037]\n']);
      if (mode === 'quoted-region') return Readable.from([webFrame([null, null, null, null,
        [[null, ['BardErrorInfo [1037]: ' + REGION_REASON]]]])]);
      if (mode === 'network') throw new Error('Network connection failed. ' + LEAK);
      if (mode === 'refused') return Readable.from([webFrame({ error: { code: 503,
        message: 'Service unavailable. ' + LEAK, details: { cookie: SECRETS.cookie, nested: [SECRETS.foreign] } } })]);
      return Readable.from([webFrame([null, null, null, null, [[null, [mode === 'empty' ? '' : ANSWER]]]])]);
    };
    api = start({ port: 0, host: '127.0.0.1', apiKey: SECRETS.key, upstreamHost: 'http://diagnostics.invalid',
      upstreamFallbackHost: '', userAgent: 'offline-diagnostics', retries: 0, requestTimeoutMs: 2000,
      persistConfig: false, safeMode: { enabled: false }, network: { useEnvProxy: false },
      geminiWeb: { enabled: true, cookie: `SAPISID=${SECRETS.cookie}`, atToken: SECRETS.xsrf } });
    if (!api.server.listening) await new Promise((resolve, reject) => {
      api.server.once('listening', resolve); api.server.once('error', reject);
    });
    const chat = (body, options) => request(api.server.address().port, '/api/diagnostics/chat', body, options);
    const valid = { model: API_MODEL, message: MESSAGE, bridge: 'api' };

    await check('catalog exposes selectable API and web model IDs', async () => {
      const result = await request(api.server.address().port, '/v1/models', null, { method: 'GET' });
      assert.equal(result.status, 200, result.text);
      const ids = JSON.parse(result.text).data.map(model => model.id);
      for (const id of [API_MODEL, WEB_MODEL, EXACT_MODEL]) assert.ok(ids.includes(id), 'Missing catalog ID: ' + id);
    });
    for (const [model, bridge, actual] of [[API_MODEL, 'api', 'api'], [WEB_MODEL, 'web', 'web'],
      [API_MODEL, 'auto', 'api'], [WEB_MODEL, 'auto', 'web'], [API_MODEL, undefined, 'api'],
      [WEB_MODEL, undefined, 'web'], [EXACT_MODEL, 'auto', 'api']]) {
      await check(`success: ${model}, bridge=${bridge ?? '(default)'} reports actual ${actual}`, async () => {
        const before = { api: calls.api.length, web: calls.web.length };
        const result = await chat({ model, message: MESSAGE, ...(bridge === undefined ? {} : { bridge }) });
        assert.equal(result.status, 200, result.text);
        assert.match(result.headers['content-type'] || '', /application\/json/i);
        const body = JSON.parse(result.text);
        assert.equal(body.ok, true); assert.equal(body.response, ANSWER);
        assert.equal(body.diagnostics.model, model); assert.equal(body.diagnostics.bridge, actual);
        assert.equal(typeof body.diagnostics.durationMs, 'number');
        assert.ok(Number.isFinite(body.diagnostics.durationMs) && body.diagnostics.durationMs >= 0);
        assert.ok(!Object.hasOwn(body, 'error'));
        assert.equal(calls[actual].length, before[actual] + 1, 'Exactly one generation request');
        assert.equal(calls[actual === 'api' ? 'web' : 'api'].length, before[actual === 'api' ? 'web' : 'api'], 'No silent cross-bridge fallback');
        if (actual === 'api') {
          const sent = calls.api.at(-1);
          assert.equal(sent.model, model.slice('cloud/'.length), 'Upstream payload uses the base ID');
          assert.deepEqual(sent.request.contents, [{ role: 'user', parts: [{ text: MESSAGE }] }]);
        } else {
          // Первым в индексе 0 идёт языковая инструкция («[Respond in "en"…]»),
          // первый и последний пользовательский текст должны совпасть с сообщением.
          const sentText = String(calls.web.at(-1).inner[0][0]);
          assert.ok(sentText.endsWith(MESSAGE), 'Send one user message without extra history: ' + sentText);
          const userTurns = sentText.split(MESSAGE).length - 1;
          assert.equal(userTurns, 1, 'Exactly one copy of the user message');
        }
      });
    }
    for (const [label, body, cause] of [
      ['missing model', { message: MESSAGE }, /model|модел/i],
      ['empty model', { ...valid, model: ' ' }, /model|модел/i],
      ['object model', { ...valid, model: {} }, /model|модел/i],
      ['legacy flat model', { ...valid, model: 'claude-sonnet-4-6' }, /namespac|model|модел/i],
      ['unknown namespace', { ...valid, model: 'gpt/x' }, /namespace|provider|model|модел/i],
      ['missing message', { model: API_MODEL }, /message|сообщен|текст/i],
      ['blank message', { ...valid, message: ' \n\t' }, /message|сообщен|текст/i],
      ['object message', { ...valid, message: {} }, /message|сообщен|текст/i],
      ['invalid bridge', { ...valid, bridge: 'smtp' }, /bridge|мост|режим/i],
      ['non-string bridge', { ...valid, bridge: [] }, /bridge|мост|режим/i],
    ]) {
      await check('validation: ' + label, async () => {
        const before = [calls.api.length, calls.web.length];
        const first = errorContract(await chat(body), 400, 'validation', cause);
        const second = errorContract(await chat(body), 400, 'validation', cause);
        assert.equal(first.code, second.code, 'Code remains stable across identical requests');
        assert.deepEqual([calls.api.length, calls.web.length], before, 'Invalid request never generates');
      });
    }
    for (const raw of ['{', 'null', '[]', '"text"']) {
      await check('validation: malformed/non-object JSON ' + raw, async () => {
        errorContract(await chat(raw, { raw: true }), 400, 'validation', /json|объект|запрос|body|object/i);
      });
    }
    for (const options of [{ authorize: false }, { key: SECRETS.foreign }]) {
      await check('auth: missing or invalid local key has diagnostic error shape ' + (options.key ? 'invalid' : 'missing'), async () => {
        const before = [calls.api.length, calls.web.length];
        const error = errorContract(await chat(valid, options), 401, 'auth', /ключ|key|авториз|auth/i);
        assert.equal(error.code, 'invalid_api_key');
        assert.deepEqual([calls.api.length, calls.web.length], before);
      });
    }
    for (const method of ['GET', 'PUT', 'DELETE']) {
      await check('method: ' + method + ' returns diagnostic 405 before parsing JSON', async () => {
        const before = [calls.api.length, calls.web.length];
        const result = await chat('{', { method, raw: true });
        const error = errorContract(result, 405, 'validation', /POST/i);
        assert.equal(error.code, 'method_not_allowed');
        assert.equal(result.headers.allow, 'POST');
        assert.deepEqual([calls.api.length, calls.web.length], before);
      });
    }
    await check('validation: malformed JSON has stable code and cannot echo request credentials', async () => {
      const result = await chat('{"message":"' + LEAK, { raw: true });
      assert.equal(errorContract(result, 400, 'validation', /JSON/i).code, 'invalid_json');
    });
    await check('routing: API-only model cannot silently use web', async () => {
      const result = await chat({ ...valid, bridge: 'web' });
      errorContract(result, 400, 'routing', /модел|model|мост|bridge|web/i);
    });
    for (const bridge of ['api', 'web']) {
      const body = { ...valid, model: bridge === 'web' ? WEB_MODEL : API_MODEL, bridge };
      await check(`upstream: ${bridge} refusal is structured and secret-free`, async () => {
        mode = 'refused';
        const result = await chat(body);
        assert.ok([502, 503].includes(result.status), result.text);
        errorContract(result, result.status, 'upstream', /503|отклонил|недоступ|unavailable|upstream|сервис|сервер/i);
      });
      await check(`upstream: ${bridge} network exception cannot leak credentials`, async () => {
        mode = 'network';
        errorContract(await chat(body), 502, 'upstream', /соедин|сеть|сетев|connect|network|upstream|сервер/i);
      });
      await check(`response: ${bridge} empty upstream answer is not success`, async () => {
        mode = 'empty';
        errorContract(await chat(body), 502, 'response', /пуст|empty|текст|text|ответ|response/i);
      });
    }
    for (const bridge of ['api', 'web']) {
      for (const refusal of bridge === 'web' ? ['region', 'http-region'] : ['region']) {
        await check(`region: ${bridge} ${refusal} retains HTTP 400 and structured code`, async () => {
          mode = refusal;
          const result = await chat({ ...valid, bridge, model: bridge === 'web' ? WEB_MODEL : API_MODEL });
          const error = errorContract(result, 400, 'upstream', /регион/i);
          assert.equal(error.code, 'region_not_supported');
          assert.equal(error.details.bridge, bridge);
          assert.ok(!result.text.includes(REGION_REASON), 'Do not copy the raw upstream reason');
          assert.doesNotMatch(error.message, /VPN|unknown/i);
        });
      }
    }
    await check('region: quoted refusal and BardErrorInfo in successful web text remain a successful answer', async () => {
      mode = 'quoted-region';
      const result = await chat({ ...valid, model: WEB_MODEL, bridge: 'web' });
      assert.equal(result.status, 200, result.text);
      assert.equal(JSON.parse(result.text).response, 'BardErrorInfo [1037]: ' + REGION_REASON);
    });
    await check('region: unrelated BardErrorInfo does not imply regional failure', async () => {
      mode = 'bard-other';
      const error = errorContract(await chat({ ...valid, model: WEB_MODEL, bridge: 'web' }), 502, 'upstream', /мост|Google/i);
      assert.notEqual(error.code, 'region_not_supported');
    });
    for (const [route, body] of [
      ['/v1/chat/completions', { model: WEB_MODEL, messages: [{ role: 'user', content: MESSAGE }] }],
      [`/v1beta/models/${WEB_MODEL}:generateContent`, { contents: [{ role: 'user', parts: [{ text: MESSAGE }] }] }],
    ]) {
      await check('public web error boundary does not echo upstream text: ' + route, async () => {
        mode = 'refused';
        const result = await request(api.server.address().port, route, body);
        assert.equal(result.status, 502, result.text);
        assertSafe(result.text);
      });
      await check('public web region retains agreed HTTP status/type/code: ' + route, async () => {
        mode = 'region';
        const result = await request(api.server.address().port, route, body);
        assert.equal(result.status, 400, result.text);
        assertSafe(result.text);
        const error = JSON.parse(result.text).error;
        assert.equal(error.code, 'region_not_supported');
        assert.equal(error.type, 'invalid_request_error');
      });
    }
    await check('network: fallback transport must not log exception text or credentials', async () => {
      mode = 'fallback-network';
      api.config.upstreamFallbackHost = 'http://diagnostics-fallback.invalid';
      try { errorContract(await chat(valid), 502, 'upstream', /соедин/i); }
      finally { api.config.upstreamFallbackHost = ''; }
    });
    await check('recovery: upstream refusals do not break subsequent API requests', async () => {
      const result = await chat(valid);
      assert.equal(result.status, 200, result.text);
      assert.equal(JSON.parse(result.text).response, ANSWER);
    });
    await check('isolation: no unexpected external transport was attempted', () => assert.deepEqual(unexpected, []));
  } finally {
    if (api) { api.server.closeAllConnections?.(); await new Promise(resolve => api.server.close(resolve)); }
    global.fetch = original.fetch; http.request = original.httpRequest; https.request = original.httpsRequest;
    GeminiWebBridge.prototype.sendStreamRequestResilient = original.send;
    GeminiWebBridge.prototype.ensureBlFresh = original.fresh; GeminiWebBridge.prototype.getLoadedCookie = original.cookie;
    GeminiWebBridge.prototype.ensureXsrf = original.xsrf; GeminiWebBridge.prototype.rotateCookies = original.rotate;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    removeTree(temp);
    Object.assign(console, originalConsole);
  }
  console.log(`${passed} diagnostic regression scenarios passed; ${failures.length} failed`);
  if (failures.length) throw new AggregateError(failures, 'Diagnostic route regressions failed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });

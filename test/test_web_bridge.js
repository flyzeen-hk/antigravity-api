'use strict';

const assert = require('assert');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
process.env.AG_SIG_FILE = path.join(os.tmpdir(), `ag-test-sigs-${process.pid}.json`);
process.on('exit', () => removeTree(process.env.AG_SIG_FILE));
const { removeTree } = require('../lib/safe_files');
const { GeminiWebBridge, WEB_MODELS } = require('../lib/web_bridge');

// декодирование payload обратно в inner-массив: f.req=[null,str] -> inner=str
function decodePayload(payloadStr) {
  const params = new URLSearchParams(payloadStr);
  const outer = JSON.parse(params.get('f.req'));
  return JSON.parse(outer[1]);
}

const bridge = new GeminiWebBridge({ enabled: true });
// summary() не должен зависеть от настоящего cookie.txt пользователя.
bridge.getLoadedCookie = () => ({ cookieStr: '', sapisid: null });

// 1. Model detection
assert.strictEqual(bridge.isWebModel('gemini-4-argon'), true);
assert.strictEqual(bridge.isWebModel('gemini-4-argon-thinking'), true);
assert.strictEqual(bridge.isWebModel('gemini-4'), true);
assert.strictEqual(bridge.isWebModel('gemini-4-pro'), true);
assert.strictEqual(bridge.isWebModel('gemini-4-flash'), true);
assert.strictEqual(bridge.isWebModel('gemini-4-thinking'), true);
assert.strictEqual(bridge.isWebModel('gemini-3.8-flash-tiered'), false);
assert.strictEqual(bridge.isWebModel('gemini-4-argonx'), false);
assert.strictEqual(bridge.isWebModel('gemini-9-nope'), false);
assert.strictEqual(bridge.isWebModel('claude-sonnet-4-6'), false);
// Алиасы — только точные ключи каталога: никакого catch-all по префиксу.
assert.strictEqual(bridge.isWebModelName('gemini-4-anything-else'), false);
assert.throws(() => bridge.getModelMeta('gemini-9-nope'), (e) => e.status === 400
  && e.code === 'model_not_found' && /Unknown web model/.test(e.message));

// isWebModelName не зависит от флага enabled
assert.strictEqual(bridge.isWebModelName('gemini-4'), true);

// 2. Model catalog
const models = bridge.getModelsList();
assert.strictEqual(models.length, 6);
assert.strictEqual(models.some(m => m.id === 'gemini-4-argon'), true);
assert.strictEqual(models.some(m => m.id === 'gemini-4-argon-thinking'), true);
assert.strictEqual(models.some(m => m.id === 'gemini-4-pro'), true);
assert.strictEqual(models.find(m => m.id === 'gemini-4-argon').display_name, 'Gemini 4 Argon');
assert.strictEqual(models.find(m => m.id === 'gemini-4-argon').displayName, 'Gemini 4 Argon');
// все gemini-4* должны выбирать режим 8 (Argon) веб-протокола
for (const m of models) {
  assert.strictEqual(bridge.getModelMeta(m.id).modelId, 8, `${m.id} must use mode=8`);
}
assert.strictEqual(bridge.getModelMeta('gemini-4-argon-thinking').thinkMode, 0);

// 3. summary()
const s = bridge.summary();
assert.strictEqual(s.enabled, true);
assert.strictEqual(s.cookieSet, false);
assert.strictEqual(s.models.length, 6);
assert.strictEqual(s.generationAvailable, true);
assert.match(s.bl, /^boq_[a-z0-9_-]+_\d{8}\.\d+_p\d+$/i);
delete bridge.getLoadedCookie;

// 4. Prompt conversion
const prompt = bridge.messagesToPrompt([
  { role: 'system', content: 'You are an AI assistant.' },
  { role: 'user', content: 'Hello world' },
]);
assert.ok(prompt.includes('[System instruction]: You are an AI assistant.'));
assert.ok(prompt.includes('Hello world'));

// contentsToPrompt: systemInstruction + роли
const nativePrompt = bridge.contentsToPrompt({
  systemInstruction: { parts: [{ text: 'Be terse.' }] },
  contents: [
    { role: 'user', parts: [{ text: 'q1' }] },
    { role: 'model', parts: [{ text: 'a1' }] },
  ],
});
assert.ok(nativePrompt.startsWith('[System instruction]: Be terse.'));
assert.ok(nativePrompt.includes('[User]: q1'));
assert.ok(nativePrompt.includes('[Assistant]: a1'));

// 5. Tool call parsing
const sample = 'Checking weather...\n```tool_call\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n```\nDone!';
const { cleanText, toolCalls } = bridge.parseToolCalls(sample);
assert.strictEqual(toolCalls.length, 1);
assert.strictEqual(toolCalls[0].function.name, 'get_weather');
assert.strictEqual(cleanText.includes('```tool_call'), false);

// 6. Cookie & SAPISID hash
bridge.updateConfig({ cookie: 'SAPISID=test_secret_sapisid_value; other=123' });
const { cookieStr, sapisid } = bridge.getLoadedCookie();
assert.strictEqual(sapisid, 'test_secret_sapisid_value');
assert.strictEqual(cookieStr.includes('other=123'), true);
const hash = bridge.makeSapisidHash(sapisid);
assert.ok(hash.startsWith('SAPISIDHASH '));

// 7. Открытый payload: modelId в [79], thinkMode в [17], флаги персистентности [41]/[45]
bridge.updateConfig({ enabled: true, temporaryChats: false });
let inner = decodePayload(bridge.buildPayload('x', 3, 0));
assert.strictEqual(inner[79], 3);
assert.deepStrictEqual(inner[17], [[0]]);
assert.deepStrictEqual(inner[41], [2]);
assert.strictEqual(inner[45], null);

bridge.updateConfig({ temporaryChats: true });
inner = decodePayload(bridge.buildPayload('x', 1, 4));
assert.deepStrictEqual(inner[41], [1]);
assert.strictEqual(inner[45], 1);
assert.strictEqual(inner[79], 1);
bridge.updateConfig({ temporaryChats: false });

// 8. Префикс мультиаккаунта /u/N и заголовок X-Goog-AuthUser
bridge.updateConfig({ authUser: 2 });
assert.strictEqual(bridge.accountPrefix(), '/u/2');
bridge.updateConfig({ authUser: null });
assert.strictEqual(bridge.accountPrefix(), '');

// 9. cookie_file алиас и JSON-обёртка
const b2 = new GeminiWebBridge({ cookie: '{"cookie": "SAPISID=json_cookie; x=1"}' });
assert.strictEqual(b2.getLoadedCookie().sapisid, 'json_cookie');

// 9a. Пустой cookie не должен затенять cookie_file (так сохраняет GUI)
const tmpCookieDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wb-cookies-'));
const prevAgDataDir = process.env.AG_DATA_DIR;
process.env.AG_DATA_DIR = tmpCookieDir;
function writeTmpCookieFile(name, content) {
  const p = path.join(tmpCookieDir, name);
  fs.writeFileSync(p, content);
  return p;
}
try {
  writeTmpCookieFile('test_cookie_file_rel.txt', 'SAPISID=file_sapisid; SID=s1;');
  const b3 = new GeminiWebBridge({ cookie: '', cookie_file: 'test_cookie_file_rel.txt' });
  assert.strictEqual(b3.getLoadedCookie().sapisid, 'file_sapisid', 'cookie_file должен читаться при пустом cookie');

  const b4 = new GeminiWebBridge({ cookie: 'old' });
  b4.updateConfig({ cookie: '', cookie_file: 'test_cookie_file_rel.txt' });
  assert.strictEqual(b4.getLoadedCookie().sapisid, 'file_sapisid', 'updateConfig должен подхватывать cookie_file');
  assert.strictEqual(b4.summary().cookieSet, true);

  // Абсолютный путь в cookie (как сохраняет GUI для полного пути)
  const abs = path.join(tmpCookieDir, 'test_cookie_file_rel.txt');
  assert.strictEqual(new GeminiWebBridge({ cookie: abs }).getLoadedCookie().sapisid, 'file_sapisid');

  // Netscape-экспорт (cookies.txt из расширений браузера)
  writeTmpCookieFile('test_cookie_file_netscape.txt',
    '# Netscape HTTP Cookie File\n' +
    '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1799999999\tSAPISID\tnetscape_sapisid\n' +
    '.google.com\tTRUE\t/\tFALSE\t1799999999\tSID\ts2\n');
  const b5 = new GeminiWebBridge({ cookie: 'test_cookie_file_netscape.txt' });
  const n5 = b5.getLoadedCookie();
  assert.strictEqual(n5.sapisid, 'netscape_sapisid');
  assert.strictEqual(n5.cookieStr.includes('# Netscape'), false);

  // JSON-массив Cookie-Editor (чужие домены отфильтрованы)
  writeTmpCookieFile('test_cookie_file_export.json', JSON.stringify([
    { name: 'SAPISID', value: 'json_file_sapisid', domain: '.google.com' },
    { name: 'SID', value: 's3', domain: '.google.com' },
    { name: 'tracker', value: 'nope', domain: '.example.com' },
  ]));
  const b6 = new GeminiWebBridge({ cookie: 'test_cookie_file_export.json' });
  const n6 = b6.getLoadedCookie();
  assert.strictEqual(n6.sapisid, 'json_file_sapisid');
  assert.strictEqual(n6.cookieStr.includes('tracker='), false);

  // Несуществующий файл не должен отправляться как заголовок Cookie
  const b7 = new GeminiWebBridge({ cookie: 'no_such_cookie_file_12345.txt' });
  assert.deepStrictEqual(b7.getLoadedCookie(), { cookieStr: '', sapisid: null });
  assert.strictEqual(b7.summary().cookieSet, false);
} finally {
  if (prevAgDataDir === undefined) delete process.env.AG_DATA_DIR;
  else process.env.AG_DATA_DIR = prevAgDataDir;
  try { removeTree(tmpCookieDir); } catch {}
}

// 10. Disable bridge
bridge.updateConfig({ enabled: false });
assert.strictEqual(bridge.isWebModel('gemini-4'), false);
assert.strictEqual(bridge.isWebModelName('gemini-4'), true, 'имя модели не зависит от enabled');
assert.strictEqual(bridge.getModelsList().length, 0);

// 11. Ошибки upstream: подменяем только транспорт, а не обработчик ошибки.
const REGION_REASON = 'User location is not supported for the API use';
const TEST_COOKIE = 'regression_cookie_do_not_disclose';
const TEST_TOKEN = 'regression_token_do_not_disclose';

function errorBridge() {
  const instance = new GeminiWebBridge({ enabled: true, atToken: TEST_TOKEN });
  // Не читаем пользовательский cookie.txt и не обращаемся к прокси окружения.
  instance.getLoadedCookie = () => ({ cookieStr: `SAPISID=${TEST_COOKIE}`, sapisid: TEST_COOKIE });
  instance.getAgent = () => ({ agent: undefined });
  return instance;
}

async function withHttpResponse(status, body, check) {
  const originalRequest = https.request;
  https.request = (_options, callback) => {
    const req = new EventEmitter();
    req.write = () => true;
    req.end = () => {
      const res = Readable.from([Buffer.from(body)]);
      res.statusCode = status;
      res.headers = {};
      process.nextTick(() => callback(res));
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
  try {
    await check();
  } finally {
    https.request = originalRequest;
  }
}

function assertRegionMessage(message) {
  assert.strictEqual(typeof message, 'string');
  assert.match(message, /region|location|регион|местополож/i, 'сообщение должно объяснять региональный отказ');
  assert.doesNotMatch(message, /unknown/i, 'известная причина не должна превращаться в unknown');
  assert.ok(!message.includes(TEST_COOKIE), 'cookie не должен попадать в сообщение');
  assert.ok(!message.includes(TEST_TOKEN), 'XSRF-токен не должен попадать в сообщение');
}

function assertRegionError(error) {
  assert.strictEqual(error.status, 400);
  assert.strictEqual(error.type, 'invalid_request_error');
  assert.strictEqual(error.code, 'region_not_supported');
  assertRegionMessage(error.message);
  return true;
}

// Фрейм wrb.fr содержит JSON-строку: причина должна пережить оба уровня JSON.
function regionalStream(withBardInfo = true) {
  const payload = JSON.stringify({ error: {
    code: 400,
    message: REGION_REASON,
    diagnostics: { cookie: TEST_COOKIE, at: TEST_TOKEN },
    ...(withBardInfo ? { details: [{ '@type': 'type.googleapis.com/google.internal.bard.v1.BardErrorInfo' }] } : {}),
  } });
  const frame = JSON.stringify([['wrb.fr', null, payload]]) + '\n';
  // Разрезаем в середине причины, чтобы не зависеть от границ сетевых чанков.
  const split = frame.indexOf('location') + 4;
  return Readable.from([Buffer.from(frame.slice(0, split)), Buffer.from(frame.slice(split))]);
}

function quotedRegionStream(text = `The error says: ${REGION_REASON}`) {
  const payload = JSON.stringify([null, null, null, null, [[null, [text]]]]);
  return Readable.from([JSON.stringify([['wrb.fr', null, payload]]) + '\n']);
}

async function consumeResponse(instance, res) {
  for await (const _delta of instance.streamResponse(res)) {
    assert.fail('upstream rejection must not produce a successful text delta');
  }
}

async function runErrorRegressions() {
  const instance = errorBridge();
  const meta = instance.getModelMeta('gemini-4');

  // HTTP 400 с исходной фразой -> общий контракт, без полей диагностики/секретов.
  await withHttpResponse(400, JSON.stringify({ error: {
    message: REGION_REASON,
    status: 'INVALID_ARGUMENT',
    diagnostics: { cookie: TEST_COOKIE, at: TEST_TOKEN },
  } }), async () => {
    await assert.rejects(instance.sendStreamRequest('f.req=test', meta), assertRegionError);
  });

  // Та же региональная причина внутри структурированной upstream-ошибки — HTTP 400.
  await assert.rejects(consumeResponse(instance, regionalStream()), assertRegionError);

  // Фраза в обычном ответе модели — текст, а не региональный отказ.
  const quoted = [];
  for await (const delta of instance.streamResponse(quotedRegionStream())) quoted.push(delta);
  assert.strictEqual(quoted.join(''), `The error says: ${REGION_REASON}`);
  const quotedBard = `BardErrorInfo [1037] — ${REGION_REASON}`;
  const quotedBardDeltas = [];
  for await (const delta of instance.streamResponse(quotedRegionStream(quotedBard))) quotedBardDeltas.push(delta);
  assert.strictEqual(quotedBardDeltas.join(''), quotedBard, 'цитата диагностического текста не является отказом');

  // Проверяем фактические SSE-сообщения обработчика, не подменяя streamResponse.
  instance.sendStreamRequestResilient = async () => (async function* () {
    // Ошибка после первого текста: SSE уже открыт, поэтому статус остаётся 200.
    yield webFrame('Начало ответа');
    yield* regionalStream();
  })();
  const chunks = [];
  let status;
  let ended = false;
  const clientRes = {
    writeHead(value) { status = value; },
    write(chunk) { chunks.push(chunk); return true; },
    end() { ended = true; },
  };
  await instance.handleOpenAIChat({ model: 'gemini-4', messages: [{ role: 'user', content: 'test' }] }, true, clientRes);
  assert.strictEqual(status, 200, 'после открытия SSE HTTP-статус уже зафиксирован');
  assert.strictEqual(ended, true);
  const wire = chunks.join('');
  const events = wire.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)));
  const messages = events.flatMap(event => [
    event.error?.message,
    ...(event.choices || []).map(choice => choice.delta?.content),
  ]).filter(Boolean);
  const regionMessage = messages.find(message => /region|location|регион|местополож/i.test(message));
  assert.ok(regionMessage, 'SSE должен сообщать региональную причину отказа');
  assertRegionMessage(regionMessage);
  const errorEvent = events.find(event => event.error?.code === 'region_not_supported');
  assert.ok(errorEvent, 'открытый SSE должен содержать структурированную региональную ошибку');
  assert.strictEqual(errorEvent.error.type, 'invalid_request_error');
  assertRegionMessage(errorEvent.error.message);
  assert.ok(!wire.includes(TEST_COOKIE), 'SSE не должен раскрывать cookie');
  assert.ok(!wire.includes(TEST_TOKEN), 'SSE не должен раскрывать токен');
  assert.doesNotMatch(wire, /unknown/i);
  assert.ok(wire.includes('data: [DONE]\n\n'), 'SSE должен корректно завершаться');

  // Нерегиональная HTTP-ошибка не должна получать региональный код/причину.
  const otherReason = 'Request is missing required authentication credential';
  await withHttpResponse(403, JSON.stringify({ error: { message: otherReason } }), async () => {
    await assert.rejects(instance.sendStreamRequest('f.req=test', meta), error => {
      assert.strictEqual(error.status, 403);
      assert.strictEqual(error.message, 'Gemini Web HTTP 403', 'прежнее сообщение HTTP-ошибки должно сохраняться');
      assert.notStrictEqual(error.code, 'region_not_supported');
      assert.doesNotMatch(error.message, /region|location|регион|местополож/i);
      return true;
    });
  });

  // Существующее распознавание числового BardErrorInfo остаётся прежним.
  await assert.rejects(consumeResponse(instance, Readable.from(['BardErrorInfo [1037]\n'])), error => {
    assert.strictEqual(error.message, 'Gemini Web upstream rejected request (BardErrorInfo [1037])');
    assert.notStrictEqual(error.code, 'region_not_supported');
    return true;
  });

  // 1060 в бандле фронтенда Gemini = LOCATION_REJECTED: отдаём региональную ошибку.
  await assert.rejects(consumeResponse(instance, Readable.from(['BardErrorInfo [1060]\n'])), error => {
    assert.strictEqual(error.code, 'region_not_supported');
    assert.match(error.message, /location|cookie/i);
    return true;
  });
}

// 12. Настоящие HTTP-маршруты; подменяем только внешние транспорты.
function webFrame(text) {
  return JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [[null, [text]]]])]]) + '\n';
}

function parseEvents(wire) {
  return wire.split('\n').filter(line => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map(line => JSON.parse(line.slice(5).trim()));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ': timeout (possible buffering)')), 2000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function requestApi(port, route, body, onData) {
  const data = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // agent:false — отдельный сокет на запрос: keep-alive + req.setTimeout
    // оставляли таймер на сокете из пула и могли оборвать следующий запрос.
    const req = http.request({ host: '127.0.0.1', port, path: route, agent: false,
      method: data === null ? 'GET' : 'POST', headers: {
        authorization: 'Bearer regression-api-key',
        ...(data === null ? {} : { 'content-type': 'application/json' }),
      },
    }, res => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', chunk => {
        text += chunk;
        if (onData) onData(text);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Regression API request timed out')));
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

async function runRouteRegressions() {
  const { start } = require('../server');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-web-regression-'));
  const env = { AG_AUTH_FILE: process.env.AG_AUTH_FILE, AG_USAGE_FILE: process.env.AG_USAGE_FILE };
  const originalFetch = global.fetch;
  const prototype = GeminiWebBridge.prototype;
  const originalSend = prototype.sendStreamRequestResilient;
  const originalFresh = prototype.ensureBlFresh;
  const originalCookie = prototype.getLoadedCookie;
  const calls = { cloud: [], web: [] };
  const failures = [];
  let api;
  let mode = 'success';
  let gate;
  const google = 'gemini-2.5-flash-thinking';
  const exactGoogle = 'gemini-4-catalog-regression';
  const other = 'claude-sonnet-4-6';
  const catalogIds = [google, exactGoogle, other, 'gpt-oss-120b'];
  const firstText = 'Привет';
  const fullText = 'Привет, мир';
  const openAIBody = model => ({ model, messages: [{ role: 'user', content: 'test' }] });
  const nativeBody = { contents: [{ role: 'user', parts: [{ text: 'test' }] }] };
  const nativePath = method => `/v1beta/models/web/gemini-4-argon:${method}`;
  const webBody = extra => ({ ...openAIBody('web/gemini-4-argon'), ...extra });
  const textFrom = (events, native) => events.flatMap(event => native
    ? (event.candidates || []).flatMap(candidate => candidate.content?.parts || []).map(part => part.text || '')
    : (event.choices || []).map(choice => choice.delta?.content || '')).join('');
  async function scenario(name, fn) {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (error) {
      failures.push(new Error(name + ': ' + error.message));
      console.error('FAIL  ' + name + ': ' + error.message);
    }
  }
  try {
    process.env.AG_AUTH_FILE = path.join(temp, 'auth.json');
    process.env.AG_USAGE_FILE = path.join(temp, 'usage.json');
    fs.writeFileSync(process.env.AG_AUTH_FILE, JSON.stringify({ access_token: 'offline-access',
      access_expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'offline-refresh' }));
    // Любая неожиданная внешняя попытка завершается локально, без OAuth/Google.
    global.fetch = async (url, options) => {
      assert.strictEqual(new URL(url).origin, 'http://regression.invalid');
      const route = new URL(url).pathname;
      if (route === '/v1internal:fetchAvailableModels') {
        return new Response(JSON.stringify({ models: Object.fromEntries([
          ...catalogIds.map(id => [id, { displayName: 'Offline fixture ' + id }]),
          ['tab_flash_lite_preview', { displayName: null }], ['chat_20706', { displayName: null }],
        ]) }), { headers: { 'content-type': 'application/json' } });
      }
      assert.strictEqual(route, '/v1internal:generateContent');
      const body = JSON.parse(options.body);
      calls.cloud.push(body.model);
      assert.ok(catalogIds.includes(body.model), 'unexpected Cloud Code model: ' + body.model);
      const response = { candidates: [{ content: { role: 'model', parts: [{ text: 'cloud:' + body.model }] }, finishReason: 'STOP' }] };
      return new Response('data: ' + JSON.stringify({ response }) + '\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    prototype.ensureBlFresh = async function () { return this.bl; };
    prototype.getLoadedCookie = () => ({ cookieStr: `SAPISID=${TEST_COOKIE}`, sapisid: TEST_COOKIE });
    prototype.sendStreamRequestResilient = async function (payload, meta) {
      calls.web.push({ inner: decodePayload(payload), meta });
      if (mode === 'http-region') return this.sendStreamRequest(payload, meta);
      if (mode === 'region') return regionalStream(false);
      if (mode === 'structured-error') {
        return Readable.from([JSON.stringify([['wrb.fr', null, JSON.stringify({ error: {
          code: 503, message: 'Offline Google upstream unavailable', status: 'UNAVAILABLE',
        } })]]) + '\n']);
      }
      if (mode === 'stream') {
        const currentGate = gate;
        return (async function* () {
          yield webFrame(firstText);
          await currentGate.promise;
          yield webFrame(fullText);
        })();
      }
      // wrb.fr не обязательно первый элемент batch; короткий ответ допустим.
      const frame = JSON.parse(webFrame(fullText))[0];
      return Readable.from([JSON.stringify([['di', 17], frame]) + '\n']);
    };
    api = start({ port: 0, host: '127.0.0.1', apiKey: 'regression-api-key',
      upstreamHost: 'http://regression.invalid', upstreamFallbackHost: '',
      userAgent: 'offline-regression', retries: 0, requestTimeoutMs: 5000, persistConfig: false,
      safeMode: { enabled: false }, network: { useEnvProxy: false },
      geminiWeb: { enabled: true, atToken: TEST_TOKEN },
    });
    if (!api.server.listening) await new Promise((resolve, reject) => {
      api.server.once('listening', resolve);
      api.server.once('error', reject);
    });
    const A = (route, body, onData) => requestApi(api.server.address().port, route, body, onData);

    await scenario('control: Claude responds independently of Google web transport', async () => {
      const r = await A('/v1/chat/completions', openAIBody('cloud/' + other));
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(JSON.parse(r.text).choices[0].message.content, 'cloud:' + other);
      assert.strictEqual(calls.cloud.at(-1), other);
      assert.strictEqual(calls.web.length, 0);
    });
    await scenario('catalog: public Google and other-company IDs survive both API catalogs', async () => {
      for (const [route, field, key, prefix, provider] of [
        ['/v1/models', 'data', 'id', 'cloud/', 'cloud'], ['/v1beta/models', 'models', 'name', 'models/cloud/', 'cloud'],
      ]) {
        const r = await A(route);
        assert.strictEqual(r.status, 200, r.text);
        const entries = JSON.parse(r.text)[field];
        const ids = entries.map(item => item[key]);
        for (const id of [...catalogIds]) {
          assert.ok(ids.includes(prefix + id), `${route}: missing ${id} despite working Claude`);
        }
        const webPrefix = route === '/v1/models' ? 'web/' : 'models/web/';
        assert.ok(ids.includes(webPrefix + 'gemini-4-argon'), `${route}: missing web/gemini-4-argon`);
        assert.ok(!ids.includes(prefix + 'tab_flash_lite_preview'));
        assert.ok(!ids.includes(prefix + 'chat_20706'));
        if (route === '/v1/models') {
          assert.strictEqual(entries.find(m => m.id === 'web/gemini-4-argon').provider, 'web');
          assert.strictEqual(entries.find(m => m.id === 'cloud/' + other).provider, provider);
        }
      }
    });
    await scenario('routing: exact Google Cloud Code IDs are never replaced by web aliases or Claude', async () => {
      const beforeWeb = calls.web.length;
      for (const model of [google, exactGoogle]) {
        const r = await A('/v1/chat/completions', openAIBody('cloud/' + model));
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(JSON.parse(r.text).choices[0].message.content, 'cloud:' + model);
        assert.strictEqual(calls.cloud.at(-1), model);
        const g = await A(`/v1beta/models/cloud/${model}:generateContent`, nativeBody);
        assert.strictEqual(g.status, 200, g.text);
        assert.strictEqual(JSON.parse(g.text).candidates[0].content.parts[0].text, 'cloud:' + model);
        assert.strictEqual(calls.cloud.at(-1), model);
      }
      assert.strictEqual(calls.web.length, beforeWeb);
    });
    await scenario('response: short Google web answer in a non-first wrb.fr frame, both non-stream routes', async () => {
      const beforeCloud = calls.cloud.length;
      const r = await A('/v1/chat/completions', openAIBody('web/gemini-4-argon'));
      assert.strictEqual(r.status, 200, r.text);
      const answer = JSON.parse(r.text);
      assert.strictEqual(answer.model, 'gemini-4-argon');
      assert.strictEqual(answer.choices[0].message.content, fullText);
      const g = await A(nativePath('generateContent'), nativeBody);
      assert.strictEqual(g.status, 200, g.text);
      assert.strictEqual(JSON.parse(g.text).candidates[0].content.parts[0].text, fullText);
      assert.strictEqual(calls.cloud.length, beforeCloud, 'web request must not silently fall back to Claude/Cloud Code');
      for (const call of calls.web) {
        assert.strictEqual(call.inner[79], 8);
        assert.strictEqual(call.meta.modelId, 8);
        assert.match(call.inner[0][0], /test/);
      }
    });
    for (const native of [false, true]) {
      await scenario(`response: ${native ? 'Gemini' : 'OpenAI'} web SSE exposes text before upstream EOF`, async () => {
        mode = 'stream';
        gate = deferred();
        const observed = deferred();
        let settled = false;
        const pending = A(native ? nativePath('streamGenerateContent') : '/v1/chat/completions',
          native ? nativeBody : webBody({ stream: true }), wire => {
            if (textFrom(parseEvents(wire.slice(0, wire.lastIndexOf('\n\n') + 2)), native) === firstText) observed.resolve();
          });
        pending.then(() => { settled = true; }, () => { settled = true; });
        try {
          await within(observed.promise, 'first Google content delta before releasing second frame');
          assert.strictEqual(settled, false, 'response must still be open after first content');
          gate.resolve();
          const r = await pending;
          assert.strictEqual(r.status, 200, r.text);
          assert.match(r.headers['content-type'], /text\/event-stream/);
          const events = parseEvents(r.text);
          assert.strictEqual(textFrom(events, native), fullText, 'spaces and Unicode must survive cumulative frames');
          assert.ok(events.some(event => native ? event.candidates?.[0]?.finishReason === 'STOP'
            : event.choices?.[0]?.finish_reason === 'stop'));
          if (!native) {
            assert.ok(events.every(event => event.id === events[0].id && event.model === 'gemini-4-argon'));
            assert.ok(r.text.includes('data: [DONE]\n\n'));
          }
        } finally {
          gate.resolve();
          await pending.catch(() => {});
          mode = 'success';
        }
      });
    }
    await scenario('response: structured Google error without BardErrorInfo cannot become an empty success', async () => {
      mode = 'structured-error';
      try {
        for (const [route, body] of [
          ['/v1/chat/completions', webBody({})],
          [nativePath('generateContent'), nativeBody],
        ]) {
          const r = await A(route, body);
          assert.ok(r.status >= 400, 'Google upstream error was returned as HTTP ' + r.status + ': ' + r.text);
          const error = JSON.parse(r.text).error;
          assert.ok(error && typeof error.message === 'string');
          assert.match(error.message, /unavailable|503|UNAVAILABLE/i);
          assert.notStrictEqual(error.code, 'region_not_supported');
        }
      } finally { mode = 'success'; }
    });
    for (const refusal of ['http-region', 'region']) {
      for (const [route, body] of [
        ['/v1/chat/completions', webBody({})],
        ['/v1/chat/completions', webBody({ stream: true })],
        [nativePath('generateContent'), nativeBody],
        [nativePath('streamGenerateContent'), nativeBody],
      ]) {
        await scenario(`region: ${refusal}, ${route}, stream=${!!body.stream || route.includes('streamGenerate')}`, async () => {
          mode = refusal;
          try {
            // Прогоняем реальный HTTP-парсер моста, а не подбрасываем готовый Error.
            await withHttpResponse(400, JSON.stringify({ error: { message: REGION_REASON,
              diagnostics: { cookie: TEST_COOKIE, at: TEST_TOKEN } } }), async () => {
              const r = await A(route, body);
              assert.strictEqual(r.status, 400, 'region refusal before first content: ' + r.text);
              const error = JSON.parse(r.text).error;
              assertRegionError({ ...error, status: r.status });
              assert.ok(!r.text.includes(TEST_COOKIE));
              assert.ok(!r.text.includes(TEST_TOKEN));
            });
          } finally { mode = 'success'; }
        });
      }
    }
    await scenario('control: Google refusals do not break subsequent Claude requests', async () => {
      const r = await A('/v1/chat/completions', openAIBody('cloud/' + other));
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(JSON.parse(r.text).choices[0].message.content, 'cloud:' + other);
    });
  } finally {
    gate?.resolve();
    if (api) {
      api.server.closeAllConnections?.();
      await new Promise(resolve => api.server.close(resolve));
    }
    global.fetch = originalFetch;
    prototype.sendStreamRequestResilient = originalSend;
    prototype.ensureBlFresh = originalFresh;
    prototype.getLoadedCookie = originalCookie;
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeTree(temp);
  }
  if (failures.length) throw new AggregateError(failures, 'Google catalog/routing/response regressions failed');
}

// Язык ответа: ru/en не меняются, добавлены языки с однозначной письменностью.
function languageTests() {
  const b = Object.create(GeminiWebBridge.prototype);
  const cases = [
    ['Привет, как дела?', 'ru'],
    ['Почему этот код не работает?', 'ru'],
    ['Спасибо за помощь', 'ru'],
    ['Hello, how are you?', 'en'],
    ['show me code: const x = 1;', 'en'],
    ['Як справи? Дякую, все гаразд.', 'uk'],
    ['Добрий день, що нового?', 'uk'],
    ['Дякую за допомогу', 'uk'],
    ['こんにちは、元気ですか？', 'ja'],
    ['你好，今天怎么样？', 'zh'],
    ['안녕하세요 반갑습니다', 'ko'],
    ['مرحبا كيف حالك', 'ar'],
    ['שלום מה שלומך', 'he'],
    ['Γειά σου, τι κάνεις', 'el'],
    ['नमस्ते आप कैसे हैं', 'hi'],
    ['สวัสดีครับ สบายดีไหม', 'th'],
    ['გამარჯობა როგორ ხართ', 'ka'],
    ['Բարեւ ինչպես ես', 'hy'],
  ];
  for (const [text, expected] of cases) {
    const got = b.detectLangFromText(text);
    if (got !== expected) throw new Error(`lang ${JSON.stringify(text)}: ${got} != ${expected}`);
  }
  // Короткий мусор и латиница не должны давать неожиданный язык.
  if (b.detectLangFromText('ok') !== '') throw new Error('"ok" must not pick a language');
  // Русское «дуже/треба/можно ли» — не украинский.
  if (b.detectLangFromText('можно ли использовать this?') !== 'ru') throw new Error('russian false positive');
  if (b.detectLangFromText('дуже треба') !== 'ru') throw new Error('russian false positive (дуже треба)');
  // Переписка: учитываются только реплики пользователя.
  const chat = b.detectChatLang([
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: 'Hello there!' },
    { role: 'user', content: 'Как писать код на Rust?' },
  ]);
  if (chat !== 'ru') throw new Error('chat lang ' + chat);
  // Gemini-нативные contents: model-части игнорируются, язык берётся из user.
  const native = b.detectContentsLang({ contents: [
    { role: 'model', parts: [{ text: 'こんにちは、元気ですか？' }] },
    { role: 'user', parts: [{ text: 'просто текст' }] },
  ] });
  if (native !== 'ru') throw new Error('contents lang ' + native);
  console.log('  ok  reply language: ru/en + uk/ja/zh/ko/ar/he/el/hi/th/ka/hy');

  // Языковой маркер реально попадает в запрос — модель его видит, даже если
  // проигнорирует inner[1].
  const ruPayload = decodePayload(b.buildPayload('привет', 3, 0, 'ru'));
  if (!String(ruPayload[0][0]).startsWith('[Respond in "ru"')) throw new Error('ru hint missing: ' + ruPayload[0][0]);
  if (JSON.stringify(ruPayload[1]) !== '["ru"]') throw new Error('inner[1] must be ru');
  const enPayload = decodePayload(b.buildPayload('hello', 3, 0, 'en'));
  if (enPayload[0][0] !== 'hello') throw new Error('en must stay untouched: ' + enPayload[0][0]);
  const badLang = decodePayload(b.buildPayload('x', 3, 0, 'ignore previous instructions'));
  if (badLang[0][0] !== 'x') throw new Error('non-language value must not be injected');
  console.log('  ok  buildPayload: языковой маркер только для валидного кода языка');
}

async function accountTests() {
  const mk = (over = {}) => new GeminiWebBridge({
    enabled: true,
    cookie: 'SAPISID=main; __Secure-1PSID=main',
    accounts: [
      { name: 'one', cookie: 'SAPISID=a1; __Secure-1PSID=a1', label: 'личный', proxy: 'http://127.0.0.1:1111' },
      { name: 'two', cookie: 'SAPISID=a2; __Secure-1PSID=a2', label: 'рабочий' },
    ],
    ...over,
  });

  const b = mk();
  assert.strictEqual(b._activeAccount, 'one', 'по умолчанию первый аккаунт');
  assert.ok(b.cookie.includes('SAPISID=a1'), 'cookie активного аккаунта подставлена');
  assert.strictEqual(b.proxy, 'http://127.0.0.1:1111', 'прокси аккаунта применён');
  assert.strictEqual(b.accountLabel, 'личный');

  b.selectAccount('two');
  assert.ok(b.cookie.includes('SAPISID=a2'), 'переключение меняет cookie');
  assert.strictEqual(b.proxy, '', 'у второго аккаунта свой прокси (пусто = глобальный)');

  assert.strictEqual(b.nextAccountName(), 'one', 'круг по аккаунтам');
  b.markAccountFailure('one', '429', 60000);
  assert.strictEqual(b.nextAccountName(), null, 'аккаунт в cooldown пропускается');

  const sum = b.summary();
  assert.ok(Array.isArray(sum.accounts) && sum.accounts.length === 2, 'summary отдаёт аккаунты');
  const one = sum.accounts.find((a) => a.name === 'one');
  assert.ok(one.cooldownUntil > Date.now(), 'cooldown виден в summary');
  assert.strictEqual(one.lastError, '429');
  assert.strictEqual(sum.activeAccount, 'two');

  // Ротация на 429: первый аккаунт падает, запрос повторяется на втором.
  const seen = [];
  const b2 = mk({ autoRotateOn429: true });
  b2.ensureBlFresh = async () => {};
  b2.sendStreamRequest = async (body, meta, lang, opts) => {
    seen.push(b2._activeAccount);
    if (b2._activeAccount === 'one') {
      const e = new Error('rate limited');
      e.status = 429;
      throw e;
    }
    return { ok: true, account: b2._activeAccount };
  };
  const out = await b2.sendStreamRequestResilient('{}', { modelId: 3, thinkMode: 0 }, 'en');
  assert.deepStrictEqual(seen, ['one', 'two'], 'после 429 запрос ушёл с другого аккаунта');
  assert.strictEqual(out.account, 'two');
  assert.ok(b2.accountStat('one').cooldownUntil > Date.now(), 'упавший аккаунт остужается');

  // Без autoRotateOn429 429 не переключает аккаунт.
  const seen2 = [];
  const b3 = mk({ autoRotateOn429: false });
  b3.ensureBlFresh = async () => {};
  b3.sendStreamRequest = async () => {
    seen2.push(b3._activeAccount);
    const e = new Error('rate limited');
    e.status = 429;
    throw e;
  };
  await assert.rejects(() => b3.sendStreamRequestResilient('{}', { modelId: 3, thinkMode: 0 }, 'en'), /rate limited/);
  assert.deepStrictEqual(seen2, ['one'], 'без флага аккаунт не меняется');

  // 401 (протухшая cookie) переключает всегда — это не лимит, а поломка.
  const seen3 = [];
  const b4 = mk();
  b4.ensureBlFresh = async () => {};
  b4.sendStreamRequest = async () => {
    seen3.push(b4._activeAccount);
    if (b4._activeAccount === 'one') {
      const e = new Error('unauthorized');
      e.status = 401;
      throw e;
    }
    return { ok: true };
  };
  await b4.sendStreamRequestResilient('{}', { modelId: 3, thinkMode: 0 }, 'en');
  assert.deepStrictEqual(seen3, ['one', 'two'], '401 переключает аккаунт');

  // Одиночная cookie (без accounts) работает как раньше.
  const b5 = new GeminiWebBridge({ enabled: true, cookie: 'SAPISID=solo' });
  assert.deepStrictEqual(b5.accounts, []);
  assert.strictEqual(b5.summary().accounts, undefined);
  console.log('  ok  мультиаккаунт: выбор, cooldown, ротация на 429/401, совместимость');
}

// В Docker cookie.txt лежит в томе данных, а не рядом с кодом: относительный
// путь из cookie/cookie_file должен находиться в AG_DATA_DIR.
function dataDirCookieTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cookie-data-'));
  const prev = process.env.AG_DATA_DIR;
  process.env.AG_DATA_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'cookie.txt'), 'SAPISID=abc123; __Secure-1PSID=xyz');
    const b = new GeminiWebBridge({ enabled: true, cookie: 'cookie.txt' });
    const resolved = b._resolveCookieFile('cookie.txt');
    assert.ok(resolved && resolved.startsWith(dir), 'относительный путь не найден в AG_DATA_DIR: ' + resolved);
    assert.ok(b.getLoadedCookie().cookieStr.includes('SAPISID=abc123'), 'cookie не прочитана из AG_DATA_DIR');
    // JSON-форма с cookie_file тоже должна искать в томе данных.
    const b2 = new GeminiWebBridge({ enabled: true, cookie: '{"cookie_file":"cookie.txt"}' });
    assert.ok(b2.getLoadedCookie().cookieStr.includes('SAPISID=abc123'), 'JSON cookie_file не найден в AG_DATA_DIR');
    console.log('  ok  cookie.txt и cookie_file находятся в AG_DATA_DIR (Docker)');
  } finally {
    if (prev === undefined) delete process.env.AG_DATA_DIR; else process.env.AG_DATA_DIR = prev;
    try { removeTree(dir); } catch {}
  }
}

runErrorRegressions().then(runRouteRegressions).then(async () => {
  await accountTests();
  languageTests();
  dataDirCookieTests();
  console.log('ALL GEMINI 4 WEB BRIDGE UNIT TESTS PASSED!');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});

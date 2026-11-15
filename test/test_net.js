'use strict';

/*
 * Юнит-тесты сетевого слоя: разбор прокси, DoH, HTTP CONNECT, SOCKS5.
 * Только loopback-серверы, без внешней сети.
 * Запуск: node test/test_net.js
 */

const assert = require('assert');
const http = require('http');
const net = require('net');
const https = require('https');

const {
  NetworkManager, normalizeNetworkConfig, parseProxyUrl, redactProxy,
  isBypassed, createDohLookup, socks5Connect, httpProxyConnect,
} = require('../lib/net');
const { removeTree } = require('../lib/safe_files');

const servers = [];
const sockets = new Set();

function track(socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  return socket;
}

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeAll() {
  for (const server of servers.splice(0)) {
    try { server.close(); } catch {}
  }
  for (const socket of sockets) {
    try { socket.destroy(); } catch {}
  }
}

function lookupAll(lookup, hostname, options = {}) {
  return new Promise((resolve, reject) => lookup(hostname, options, (err, list) => (err ? reject(err) : resolve(list))));
}

function lookupOne(lookup, hostname, family = 0) {
  return new Promise((resolve, reject) => lookup(hostname, family, (err, address, fam) => (
    err ? reject(err) : resolve({ address, family: fam })
  )));
}

function httpConnect(proxy, targetHost, targetPort, timeout = 3000) {
  return new Promise((resolve, reject) => {
    httpProxyConnect(proxy, targetHost, targetPort, null, timeout, (err, socket) => {
      if (err) reject(err); else resolve(track(socket));
    });
  });
}

function exchange(socket, payload, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(new Error('echo timeout')), timeout);
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length >= payload.length) {
        clearTimeout(timer);
        resolve(data);
      }
    });
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    socket.write(payload);
  });
}

function makeEchoServer() {
  const server = net.createServer((socket) => {
    track(socket);
    socket.pipe(socket); // echo
  });
  return server;
}

function makeHttpProxy({ requireAuth = false, username = 'u', password = 'p' } = {}) {
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    track(clientSocket);
    if (requireAuth) {
      const expected = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      if (req.headers['proxy-authorization'] !== expected) {
        clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
    }
    const [host, port] = req.url.split(':');
    const upstream = track(net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }));
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return server;
}

function makeSocks5Server({ requireAuth = false, username = 'u', password = 'p' } = {}) {
  return net.createServer((socket) => {
    track(socket);
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const count = buffer[1];
        if (buffer.length < 2 + count) return;
        buffer = buffer.subarray(2 + count);
        stage = requireAuth ? 'auth' : 'request';
        socket.write(Buffer.from(requireAuth ? [0x05, 0x02] : [0x05, 0x00]));
      }
      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const ulen = buffer[1];
        if (buffer.length < 2 + ulen + 1) return;
        const plen = buffer[2 + ulen];
        if (buffer.length < 2 + ulen + 1 + plen) return;
        const user = buffer.subarray(2, 2 + ulen).toString('utf8');
        const pass = buffer.subarray(2 + ulen + 1, 2 + ulen + 1 + plen).toString('utf8');
        buffer = buffer.subarray(2 + ulen + 1 + plen);
        stage = 'request';
        socket.write(Buffer.from([0x01, user === username && pass === password ? 0x00 : 0x01]));
        if (user !== username || pass !== password) return;
      }
      if (stage === 'request') {
        if (buffer.length < 5) return;
        let offset = 4;
        let host;
        if (buffer[3] === 0x01) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join('.');
          offset = 8;
        } else if (buffer[3] === 0x03) {
          const len = buffer[4];
          if (buffer.length < 5 + len + 2) return;
          host = buffer.subarray(5, 5 + len).toString('utf8');
          offset = 5 + len;
        } else {
          return socket.destroy();
        }
        const port = buffer.readUInt16BE(offset);
        stage = 'done';
        const upstream = track(net.connect(port, host, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          upstream.pipe(socket);
          socket.pipe(upstream);
        }));
        upstream.on('error', () => socket.destroy());
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
}

async function main() {
  // ---- parse / redact / config ----
  const socks = parseProxyUrl('socks5://user:pass@127.0.0.1:1080');
  assert.deepStrictEqual(
    { type: socks.type, host: socks.host, port: socks.port, username: socks.username },
    { type: 'socks5', host: '127.0.0.1', port: 1080, username: 'user' },
  );
  assert.strictEqual(parseProxyUrl('127.0.0.1:8080').type, 'http');
  assert.strictEqual(parseProxyUrl('ftp://host:21'), null);
  assert.strictEqual(redactProxy('http://user:secret@127.0.0.1:3128'), 'http://***@127.0.0.1:3128');
  assert.strictEqual(redactProxy('ftp://host:21'), '(invalid proxy)');

  const oldNoProxy = process.env.NO_PROXY;
  process.env.NO_PROXY = '.google.com,example.org:8080';
  try {
    assert.strictEqual(isBypassed('gemini.google.com'), true);
    assert.strictEqual(isBypassed('google.com'), true);
    assert.strictEqual(isBypassed('notgoogle.com'), false);
    assert.strictEqual(isBypassed('localhost'), true);
  } finally {
    if (oldNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = oldNoProxy;
  }

  const normalized = normalizeNetworkConfig({
    dnsServers: ['1.1.1.1', 'bad', '2001:4860:4860::8888'],
    network: { proxy: ' http://127.0.0.1:9 ', useEnvProxy: false },
    geminiWeb: { proxy: 'socks5://127.0.0.1:1080' },
  });
  assert.strictEqual(normalized.proxy, 'http://127.0.0.1:9');
  assert.strictEqual(normalized.webProxy, 'socks5://127.0.0.1:1080');
  assert.deepStrictEqual(normalized.dnsServers, ['1.1.1.1', '2001:4860:4860::8888']);
  assert.strictEqual(normalized.useEnvProxy, false);

  const manager = new NetworkManager({
    network: { proxy: 'http://u:p@127.0.0.1:9', useEnvProxy: false },
    geminiWeb: { proxy: 'socks5://127.0.0.1:1080' },
  });
  assert.strictEqual(manager.summary().proxy, 'http://***@127.0.0.1:9');
  assert.strictEqual(manager.summary().webProxy, 'socks5://127.0.0.1:1080');
  assert.ok(manager.agentFor('upstream', 'example.com') instanceof https.Agent);
  assert.strictEqual(manager.proxyForHost('web', 'gemini.google.com').type, 'socks5');
  assert.strictEqual(manager.proxyForHost('upstream', 'example.com').type, 'http');
  await new Promise((resolve) => { manager.updateConfig({ network: { useEnvProxy: false } }); resolve(); });
  assert.strictEqual(manager.summary().proxy, '');
  // useEnvProxy:false must ignore the Windows system proxy too — tests stay hermetic.
  assert.strictEqual(manager.proxyForHost('upstream', 'example.com'), null);
  assert.strictEqual(manager.summary().systemProxy, '');

  // AGUnlocker relay: только Cloud Code SNI идут в обход прокси.
  const { isRelayHost } = require('../lib/net');
  assert.strictEqual(isRelayHost('daily-cloudcode-pa.googleapis.com'), true);
  assert.strictEqual(isRelayHost('gemini.google.com'), false);
  assert.strictEqual(isRelayHost('oauth2.googleapis.com'), false);
  const relayed = new NetworkManager({ network: { useEnvProxy: true, proxy: 'http://127.0.0.1:9' } });
  relayed._relayIp = '127.65.71.2';
  assert.strictEqual(relayed.proxyForHost('upstream', 'daily-cloudcode-pa.googleapis.com'), null);
  assert.strictEqual(relayed.proxyForHost('web', 'gemini.google.com').type, 'http');
  assert.strictEqual(relayed.proxyForHost('upstream', 'oauth2.googleapis.com').type, 'http');

  // ---- DoH lookup (local JSON endpoint) ----
  let dohRequests = 0;
  const dohServer = http.createServer((req, res) => {
    dohRequests++;
    const url = new URL(req.url, 'http://localhost');
    const type = url.searchParams.get('type');
    res.writeHead(200, { 'content-type': 'application/dns-json' });
    res.end(JSON.stringify({
      Status: 0,
      Answer: type === 'A' ? [{ type: 1, TTL: 60, data: '127.0.0.1' }] : [],
    }));
  });
  const dohPort = await listen(dohServer);
  const dohLookup = createDohLookup(`http://127.0.0.1:${dohPort}/dns-query`, { timeoutMs: 2000 });
  const all = await lookupAll(dohLookup, 'example.test', { all: true });
  assert.deepStrictEqual(all, [{ address: '127.0.0.1', family: 4 }]);
  const one = await lookupOne(dohLookup, 'example.test', 4);
  assert.deepStrictEqual(one, { address: '127.0.0.1', family: 4 });
  const before = dohRequests;
  await lookupOne(dohLookup, 'example.test', 4);
  assert.strictEqual(dohRequests, before, 'DoH должен кэшировать ответ');

  // ---- HTTP CONNECT proxy (auth) ----
  const echoServer = makeEchoServer();
  const echoPort = await listen(echoServer);

  const authProxy = makeHttpProxy({ requireAuth: true });
  const authProxyPort = await listen(authProxy);
  await assert.rejects(
    httpConnect(parseProxyUrl(`http://127.0.0.1:${authProxyPort}`), '127.0.0.1', echoPort),
    /CONNECT failed: 407/,
  );
  const viaAuth = await httpConnect(
    parseProxyUrl(`http://u:p@127.0.0.1:${authProxyPort}`), '127.0.0.1', echoPort);
  assert.strictEqual(await exchange(viaAuth, 'ping'), 'ping');

  // ---- SOCKS5 (no auth + auth) ----
  const socksServer = makeSocks5Server();
  const socksPort = await listen(socksServer);
  const viaSocks = await socks5Connect(
    parseProxyUrl(`socks5://127.0.0.1:${socksPort}`), '127.0.0.1', echoPort, null, 3000);
  track(viaSocks);
  assert.strictEqual(await exchange(viaSocks, 'socks'), 'socks');

  const socksAuth = makeSocks5Server({ requireAuth: true });
  const socksAuthPort = await listen(socksAuth);
  const viaSocksAuth = await socks5Connect(
    parseProxyUrl(`socks5://u:p@127.0.0.1:${socksAuthPort}`), '127.0.0.1', echoPort, null, 3000);
  track(viaSocksAuth);
  assert.strictEqual(await exchange(viaSocksAuth, 'auth'), 'auth');

  await assert.rejects(
    socks5Connect(parseProxyUrl(`socks5://u:wrong@127.0.0.1:${socksAuthPort}`), '127.0.0.1', echoPort, null, 3000),
    /authentication failed/,
  );

  // ---- прокси-путь: таймаут должен действовать и на тело ответа ----
  // Прокси-агент держит TLS поверх CONNECT; после заголовков таймер сокета
  // раньше сбрасывался в 0, и медленное тело висело бесконечно.
  const { execFileSync } = require('child_process');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-net-tls-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(tlsDir, 'key.pem'), '-out', path.join(tlsDir, 'cert.pem'),
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  const tlsOpts = { key: fs.readFileSync(path.join(tlsDir, 'key.pem')), cert: fs.readFileSync(path.join(tlsDir, 'cert.pem')) };
  const slowTls = https.createServer(tlsOpts, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    // тело не закрываем — проверяем именно пассивный таймаут
  });
  const slowTlsPort = await listen(slowTls);
  const connectProxy = makeHttpProxy();
  const connectPort = await listen(connectProxy);
  const netMgr = new NetworkManager({ network: { proxy: `http://127.0.0.1:${connectPort}`, useEnvProxy: false } });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const started = Date.now();
  let bodyErr = null;
  try {
    const slowRes = await netMgr.fetch(`https://127.0.0.1:${slowTlsPort}/slow`, { timeoutMs: 500 });
    for await (const _ of slowRes.body) { /* ждём данных, которые сервер не пришлёт */ }
  } catch (e) {
    bodyErr = e;
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
  assert.ok(bodyErr, 'медленное тело должно оборваться по таймауту');
  assert.ok(Date.now() - started < 5000, 'таймаут сработал за ' + (Date.now() - started) + ' мс');
  assert.ok(/timed out|aborted|socket hang up/i.test(String(bodyErr.message || bodyErr)), 'ошибка таймаута: ' + bodyErr.message);
  removeTree(tlsDir);
  console.log('ALL NETWORK UNIT TESTS PASSED!');
}

main()
  .then(() => { closeAll(); process.exit(0); })
  .catch((err) => {
    console.error(err);
    closeAll();
    process.exit(1);
  });

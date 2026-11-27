'use strict';

const assert = require('assert');
const net = require('net');
const { execFileSync } = require('child_process');
const path = require('path');
const proxyDetect = require('../lib/proxy_detect');

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  console.log('  ok ', name);
  passed++;
}

async function main() {
  console.log('== test_proxy_detect');

  ok(proxyDetect.maskProxyUrl('http://alice:secret@127.0.0.1:8080') === 'http://***@127.0.0.1:8080', 'maskProxyUrl redacts credentials');
  ok(proxyDetect.maskProxyUrl('socks5://127.0.0.1:1080') === 'socks5://127.0.0.1:1080', 'maskProxyUrl keeps plain URL unchanged');

  const p = proxyDetect.parseProxyUrl('socks5h://bob:pw@127.0.0.1:10808');
  ok(p && p.scheme === 'socks5' && p.port === 10808 && p.username === 'bob' && p.password === 'pw', 'parseProxyUrl handles socks5h and creds');

  const winList = proxyDetect.parseWindowsProxyServer('http=127.0.0.1:8080;https=127.0.0.1:8443');
  ok(winList.length === 2 && winList[1].url === 'http://127.0.0.1:8443', 'parseWindowsProxyServer parses per-scheme entries');

  // Test real local SOCKS5 greeting probe on ephemeral loopback server
  const srv = net.createServer((sock) => {
    sock.once('data', (d) => {
      if (d[0] === 0x05) sock.write(Buffer.from([0x05, 0x00]));
      sock.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const okSocks = await proxyDetect.probeSocks5('127.0.0.1', port, 1000);
    ok(okSocks === true, 'probeSocks5 succeeds against local SOCKS5 mock');
  } finally {
    srv.close();
  }

  const cliOut = execFileSync(process.execPath, [path.join(__dirname, '..', 'lib', 'proxy_detect.js'), '--json'], { encoding: 'utf8' });
  const arr = JSON.parse(cliOut);
  ok(Array.isArray(arr), 'proxy_detect --json returns valid JSON array');

  console.log(`passed: ${passed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

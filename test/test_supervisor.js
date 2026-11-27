'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  console.log('  ok ', name);
  passed++;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    const headers = Object.assign({}, opts.headers || {});
    if (body && !headers['content-type']) headers['content-type'] = 'application/json';
    if (body) headers['content-length'] = Buffer.byteLength(body);
    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
      timeout: opts.timeout || 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('== test_supervisor');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sup-test-'));
  const gatewayPort = await getFreePort();
  process.env.AG_DATA_DIR = tmpDir;
  process.env.AG_NO_CLOUD = '1';

  fs.writeFileSync(path.join(tmpDir, 'admin.key'), 'sup_admin_secret_123');
  fs.writeFileSync(path.join(tmpDir, 'apikey.txt'), 'sup_api_secret_123');
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    configVersion: 2,
    port: gatewayPort,
    host: '127.0.0.1',
    autoStartServer: false,
    apiKey: 'sup_api_secret_123',
    adminKey: 'sup_admin_secret_123',
  }, null, 2));

  const { startSupervisor } = require('../scripts/ui_supervisor');
  let sup = null;
  let sessionCookie = '';

  try {
    sup = await startSupervisor({ autoStart: false });
    const base = `http://127.0.0.1:${sup.uiPort}`;
    const statePath = path.join(tmpDir, '.ui-supervisor.json');
    ok(fs.existsSync(statePath), '.ui-supervisor.json written to AG_DATA_DIR');
    const stateFile = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    ok(typeof stateFile.supToken === 'string' && stateFile.supToken.length >= 16, 'supToken present in state file');

    const health = await request(`${base}/_supervisor/health`);
    ok(health.status === 200 && health.json?.ok === true, 'unauthenticated /_supervisor/health returns 200 ok');

    const unauth = await request(`${base}/_supervisor/status`);
    ok(unauth.status === 401, 'unauthenticated /_supervisor/status returns 401');

    const nonceRes = await request(`${base}/_supervisor/nonce`, {
      method: 'POST',
      headers: { 'x-supervisor-token': stateFile.supToken },
    });
    ok(nonceRes.status === 200 && typeof nonceRes.json?.nonce === 'string', 'POST /_supervisor/nonce mints launch nonce');

    const launchRes = await request(`${base}/?launch=${encodeURIComponent(nonceRes.json.nonce)}`);
    ok(launchRes.status === 302, '/?launch=<nonce> returns 302 redirect');
    const setCookie = [].concat(launchRes.headers['set-cookie'] || [])[0] || '';
    sessionCookie = setCookie.split(';')[0];
    ok(sessionCookie.startsWith('ag_sup_session='), '/?launch=<nonce> sets ag_sup_session cookie');

    const headers = { cookie: sessionCookie };
    const st0 = await request(`${base}/_supervisor/status`, { headers });
    ok(st0.status === 200 && st0.json?.state === 'stopped' && st0.json?.running === false, 'initial server state is stopped');

    const offlineRoutes = ['/_status', '/_config', '/_keys', '/_installs', '/_usage', '/_limits', '/_backups', '/v1/models'];
    for (const p of offlineRoutes) {
      const r = await request(`${base}${p}`, { headers });
      ok(r.status === 200, `offline ${p} returns 200 while gateway stopped`);
    }
    const statusOff = await request(`${base}/_status`, { headers });
    ok(statusOff.json?.supervised === true && statusOff.json?.serverRunning === false, '/_status reports supervised=true serverRunning=false offline');

    const chatStopped = await request(`${base}/api/diagnostics/chat`, {
      method: 'POST',
      headers,
      body: { model: 'gemini-2.5-flash', prompt: 'hi' },
    });
    ok(chatStopped.status === 503 && chatStopped.json?.error?.code === 'server_stopped', 'chat while stopped returns 503 server_stopped');

    const startRes = await request(`${base}/_supervisor/start`, { method: 'POST', headers });
    ok(startRes.status === 200 && startRes.json?.state === 'running' && startRes.json?.port === gatewayPort, 'POST /_supervisor/start boots gateway on configured port');

    const gwHealth = await request(`http://127.0.0.1:${gatewayPort}/_health`);
    ok(gwHealth.status === 200 && gwHealth.json?.ok === true, 'started gateway responds directly on configured port');

    const statusRun = await request(`${base}/_status`, { headers });
    ok(statusRun.status === 200 && statusRun.json?.port === gatewayPort && statusRun.json?.serverRunning !== false, 'proxied /_status responds from live gateway');

    const chatProxied = await request(`${base}/api/diagnostics/chat`, {
      method: 'POST',
      headers,
      body: { model: 'gemini-2.5-flash', prompt: '' },
    });
    ok(chatProxied.status === 400, 'proxied chat reaches live server validation instead of 503 server_stopped');

    const stopRes = await request(`${base}/_supervisor/stop`, { method: 'POST', headers });
    ok(stopRes.status === 200 && stopRes.json?.state === 'stopped' && stopRes.json?.running === false, 'POST /_supervisor/stop stops gateway cleanly');

    let gwConnRefused = false;
    try {
      await request(`http://127.0.0.1:${gatewayPort}/_health`, { timeout: 1000 });
    } catch {
      gwConnRefused = true;
    }
    ok(gwConnRefused, 'gateway port is closed after stop');

    const uiAfterStop = await request(`${base}/_status`, { headers });
    ok(uiAfterStop.status === 200 && uiAfterStop.json?.serverRunning === false, 'supervisor UI stays online after gateway stop');

    console.log(`\nALL PASSED (${passed} checks)`);
  } finally {
    if (sup && sup.uiPort && sessionCookie) {
      await request(`http://127.0.0.1:${sup.uiPort}/_supervisor/stop`, {
        method: 'POST',
        headers: { cookie: sessionCookie },
        timeout: 4000,
      }).catch(() => {});
    }
    if (sup && sup.httpServer) {
      await new Promise((resolve) => sup.httpServer.close(() => resolve()));
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

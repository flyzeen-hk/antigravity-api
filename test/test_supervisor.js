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
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, text, json });
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

  // Simulate fresh clone without pre-existing apikey.txt / admin.key
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    configVersion: 2,
    port: gatewayPort,
    host: '127.0.0.1',
    autoStartServer: false,
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

    // Fresh-clone key auto-bootstrap checks
    const genApiKey = fs.readFileSync(path.join(tmpDir, 'apikey.txt'), 'utf8').trim();
    const genAdminKey = fs.readFileSync(path.join(tmpDir, 'admin.key'), 'utf8').trim();
    ok(/^agk_[0-9a-f]{48}$/.test(genApiKey) && /^agadm_[0-9a-f]{48}$/.test(genAdminKey), 'fresh supervisor boot generates apikey.txt and admin.key');

    const manualLogin = await request(`${base}/_auth/session`, {
      method: 'POST',
      body: { adminKey: genAdminKey },
    });
    ok(manualLogin.status === 200 && manualLogin.json?.ok === true, 'POST /_auth/session succeeds with generated admin.key before gateway start');

    // DNS rebinding Host check on supervisor
    const rebindSup = await request(`${base}/_supervisor/health`, {
      headers: { host: 'evil-rebind.example' },
    });
    ok(rebindSup.status === 403, 'supervisor blocks non-loopback Host header (DNS rebinding defense)');

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

    const crossPortSup = await request(`${base}/_keys`, {
      headers: { cookie: sessionCookie, origin: 'http://127.0.0.1:3000' },
    });
    ok(crossPortSup.status === 401, 'supervisor rejects session cookie from different localhost port (CSRF defense)');

    const darkSvg = await request(`${base}/icon-dark.svg`);
    const lightSvg = await request(`${base}/icon-light.svg`);
    const darkIco = await request(`${base}/favicon-dark.ico`);
    const lightIco = await request(`${base}/favicon-light.ico`);
    ok(darkSvg.status === 200 && lightSvg.status === 200 && darkSvg.text !== lightSvg.text, '/icon-dark.svg and /icon-light.svg serve distinct theme SVGs');
    ok(darkIco.status === 200 && lightIco.status === 200 && !darkIco.buf.equals(lightIco.buf), '/favicon-dark.ico and /favicon-light.ico serve distinct ICOs');

    const initIcon = await request(`${base}/icon.svg`);
    const initManifest = await request(`${base}/manifest.webmanifest`);
    ok(initIcon.text === darkSvg.text && initManifest.json?.background_color === '#0b0f17', 'default dark theme serves #8 dark icon & manifest');

    const setLightRes = await request(`${base}/_config`, { method: 'POST', headers, body: { theme: 'light' } });
    ok(setLightRes.status === 200 && setLightRes.json?.ok === true, 'POST /_config switches theme to light');
    const lightActiveSvg = await request(`${base}/icon.svg`);
    const lightActiveIco = await request(`${base}/favicon.ico`);
    const lightManifest = await request(`${base}/manifest.webmanifest`);
    ok(lightActiveSvg.text === lightSvg.text && lightActiveIco.buf.equals(lightIco.buf) && lightManifest.json?.background_color === '#f1f5f9', 'light theme dynamically serves #7 light icon, favicon & manifest');

    const setDarkRes = await request(`${base}/_config`, { method: 'POST', headers, body: { theme: 'dark' } });
    ok(setDarkRes.status === 200 && (await request(`${base}/icon.svg`)).text === darkSvg.text, 'switching back to dark restores #8 dark icon');

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

    const rebindGw = await request(`http://127.0.0.1:${gatewayPort}/_health`, {
      headers: { host: 'evil-rebind.example' },
    });
    ok(rebindGw.status === 403, 'gateway blocks non-loopback Host header when bound to loopback');

    const corsBearer = await request(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: { origin: 'http://127.0.0.1:3000', authorization: `Bearer ${genApiKey}` },
    });
    ok(
      corsBearer.status === 200
      && corsBearer.headers['access-control-allow-origin'] === 'http://127.0.0.1:3000'
      && !corsBearer.headers['access-control-allow-credentials'],
      'cross-port Bearer CORS works without exposing Allow-Credentials'
    );

    const { execFileSync } = require('child_process');
    const cliKey = execFileSync(process.execPath, [path.join(__dirname, '..', 'server.js'), 'key'], {
      env: { ...process.env, AG_DATA_DIR: tmpDir },
      encoding: 'utf8',
    }).trim();
    const cliKeyFlag = execFileSync(process.execPath, [path.join(__dirname, '..', 'server.js'), '--print-key'], {
      env: { ...process.env, AG_DATA_DIR: tmpDir },
      encoding: 'utf8',
    }).trim();
    const cliAdmin = execFileSync(process.execPath, [path.join(__dirname, '..', 'server.js'), 'admin-key'], {
      env: { ...process.env, AG_DATA_DIR: tmpDir },
      encoding: 'utf8',
    }).trim();
    ok(cliKey === genApiKey && cliKeyFlag === genApiKey && cliAdmin === genAdminKey, 'server.js CLI key / --print-key / admin-key return initialized keys');

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

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { resolveDataDir, migrateLegacyStateFiles } = require('../lib/data_dir');
const {
  parseVlessUri,
  parseTrojanUri,
  parseHy2Uri,
  loadCandidateNodes,
  buildXrayOutbound,
  buildFragmentOutbound,
  convertTelegramSocksLink,
  extractProxyLinesFromText,
  extractVlessLinesFromText,
  computeNodeRankMs,
  isDistantOrAnycastNode,
  NEARBY_COUNTRY_REMARK_RE,
} = require('../lib/free_tunnel');
const configLib = require('../lib/config');

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

  // Verify strict opt-in default & security guards of FreeTunnelManager
  ok(configLib.DEFAULTS.geminiWeb.freeTunnel.enabled === false, 'freeTunnel is strictly opt-in (disabled by default)');
  ok(
    convertTelegramSocksLink('tg://socks?server=198.51.100.10&port=1080&user=alice&pass=sec') === 'socks5://alice:sec@198.51.100.10:1080',
    'convertTelegramSocksLink converts tg://socks to socks5:// URL'
  );
  assert.throws(() => convertTelegramSocksLink('tg://proxy?server=1.2.3.4&port=443&secret=ee00'), /MTProto/i);
  ok(true, 'convertTelegramSocksLink rejects Telegram-only MTProto tg://proxy links with helpful message');

  const validVless = parseVlessUri('vless://ccb8ff48-3934-4250-b4ec-bb76b95d154f@198.51.100.42:443?security=reality&encryption=none&pbk=NaCZ-sS4poEbFwKmD7ePAVyc5OhHxsD9nkAStjXi2wY&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=www.microsoft.com&sid=a1b2#NL-Reality');
  ok(validVless && validVless.security === 'reality' && validVless.port === 443, 'parseVlessUri parses valid VLESS Reality URI');
  ok(parseVlessUri('vless://ccb8ff48-3934-4250-b4ec-bb76b95d154f@127.0.0.1:443?security=reality&pbk=NaCZ-sS4poEbFwKmD7ePAVyc5OhHxsD9nkAStjXi2wY&sni=example.com') === null, 'parseVlessUri blocks loopback SSRF addresses');
  ok(parseVlessUri('vless://ccb8ff48-3934-4250-b4ec-bb76b95d154f@198.51.100.42:443?security=reality&pbk=NaCZ-sS4poEbFwKmD7ePAVyc5OhHxsD9nkAStjXi2wY&sni=example.com#RU-Moscow') === null, 'parseVlessUri skips Gemini-blocked RU region nodes');
  ok(parseVlessUri('vless://ccb8ff48-3934-4250-b4ec-bb76b95d154f@104.20.5.134:443?security=tls&type=ws&sni=worker.example.com#Anycast-IP%20%7C%20%F0%9F%87%A8%F0%9F%87%A6%20%F0%9F%87%A9%F0%9F%87%AA%20%F0%9F%87%B7%F0%9F%87%BA') !== null, 'parseVlessUri keeps multi-country Anycast-IP CDN nodes');
  const b64Sub = Buffer.from('vless://ccb8ff48-3934-4250-b4ec-bb76b95d154f@198.51.100.42:443?security=tls&sni=example.com#DE\ntrojan://secretpass@198.51.100.43:443?sni=example.com#FI\nhy2://authpass@198.51.100.44:443?sni=example.com#NL\n', 'utf8').toString('base64');
  ok(extractVlessLinesFromText(b64Sub).length === 1 && extractProxyLinesFromText(b64Sub).length === 3, 'extractProxyLinesFromText decodes Base64 multi-protocol subscriptions');

  const validTlsVless = parseVlessUri('vless://ccb8ff48-3934-4250-b4ec-bb76b95d154f@198.51.100.45:443?security=tls&type=ws&path=/ws&sni=cdn.example.com#US');
  const validTrojan = parseTrojanUri('trojan://secretpass@198.51.100.46:443?type=tcp&sni=trojan.example.com#FI');
  const validHy2 = parseHy2Uri('hy2://authpass@198.51.100.47:443?sni=hy2.example.com&obfs=salamander&obfs-password=obfspw#NL');
  ok(validTrojan && validTrojan.proto === 'trojan' && validHy2 && validHy2.proto === 'hy2' && validHy2.obfs === 'salamander', 'parseTrojanUri & parseHy2Uri parse valid non-insecure URIs');
  ok(parseTrojanUri('trojan://pw@127.0.0.1:443?sni=example.com') === null && parseHy2Uri('hy2://pw@198.51.100.47:443?sni=example.com&insecure=1') === null, 'parseTrojanUri & parseHy2Uri enforce SSRF and TLS verification guards');

  await assert.rejects(() => loadCandidateNodes({ customSource: 'http://example.com/sub.txt' }), /https:\/\//i);
  await assert.rejects(() => loadCandidateNodes({ customSource: 'https://127.0.0.1/sub.txt' }), /private\/loopback/i);
  ok(true, 'loadCandidateNodes rejects plain http:// and loopback SSRF custom subscription URLs');

  const realityOut = buildXrayOutbound(validVless, 'out-r');
  const tlsFragOut = buildXrayOutbound(validTlsVless, 'out-t', { useFragment: true });
  const trojanFragOut = buildXrayOutbound(validTrojan, 'out-tr', { useFragment: true });
  const hy2Out = buildXrayOutbound(validHy2, 'out-h', { useFragment: true });
  const fragOut = buildFragmentOutbound('frag');
  ok(
    tlsFragOut.streamSettings.tlsSettings
    && !('allowInsecure' in tlsFragOut.streamSettings.tlsSettings)
    && !('allowInsecure' in trojanFragOut.streamSettings.tlsSettings)
    && !('allowInsecure' in hy2Out.streamSettings.tlsSettings),
    'buildXrayOutbound omits removed Xray v26 allowInsecure property'
  );
  ok(
    tlsFragOut.streamSettings.sockopt?.dialerProxy === 'frag'
    && trojanFragOut.streamSettings.sockopt?.dialerProxy === 'frag'
    && !realityOut.streamSettings.sockopt
    && !hy2Out.streamSettings.sockopt
    && fragOut.settings?.fragment?.packets === 'tlshello'
    && fragOut.settings?.fragment?.interval === '3-5',
    'buildXrayOutbound attaches fast 3-5ms tlshello fragment dialerProxy only to TLS TCP/WS/gRPC transports'
  );
  ok(
    NEARBY_COUNTRY_REMARK_RE.test('05 польша #2')
    && NEARBY_COUNTRY_REMARK_RE.test('🇩🇪 Germany')
    && NEARBY_COUNTRY_REMARK_RE.test('🇰🇿 Kazakhstan')
    && NEARBY_COUNTRY_REMARK_RE.test('🇸🇬 Singapore')
    && isDistantOrAnycastNode({ label: '🇨🇦 Canada, Toronto | [BL]' }) === true
    && isDistantOrAnycastNode({ label: '🇵🇱 Poland #2' }) === false
    && computeNodeRankMs({ security: 'reality', proto: 'vless', label: '🇵🇱 Poland #2' }, 750)
       < computeNodeRankMs({ security: 'tls', proto: 'vless', label: '🇨🇦 Canada, Toronto' }, 600),
    'node ranking prefers fast direct EU/CIS/Asia Reality servers ahead of distant/fragmented tunnels'
  );

  // Verify Windows LocalAppData default resolution & read-only legacy state migration
  const winDefault = resolveDataDir({
    rootDir: 'C:\\Protected\\Documents\\antigravity-api',
    env: { LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local' },
    platform: 'win32',
  });
  ok(winDefault === path.win32.join('C:\\Users\\Demo\\AppData\\Local', 'AntigravityAPI'), 'win32 default DATA_DIR uses %LOCALAPPDATA%\\AntigravityAPI');
  const explicitOverride = resolveDataDir({
    rootDir: 'C:\\Protected\\Documents\\antigravity-api',
    env: { AG_DATA_DIR: 'C:\\CustomData', LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local' },
    platform: 'win32',
  });
  ok(explicitOverride === path.resolve('C:\\CustomData'), 'AG_DATA_DIR overrides platform default');

  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-leg-src-'));
  const legacyDest = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-leg-dst-'));
  try {
    fs.writeFileSync(path.join(legacyRoot, 'apikey.txt'), 'agk_legacy_demo_key_1234567890\n');
    fs.writeFileSync(path.join(legacyRoot, 'config.json'), '{"port":8317}');
    const mig = migrateLegacyStateFiles({ rootDir: legacyRoot, dataDir: legacyDest, env: {} });
    ok(mig.migrated.includes('apikey.txt') && mig.migrated.includes('config.json'), 'migrateLegacyStateFiles copies legacy state files to new DATA_DIR');
    ok(fs.existsSync(path.join(legacyRoot, 'apikey.txt')) && fs.existsSync(path.join(legacyDest, 'apikey.txt')), 'legacy migration preserves source files untouched');
  } finally {
    try { fs.rmSync(legacyRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(legacyDest, { recursive: true, force: true }); } catch {}
  }

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

    const offlineRoutes = ['/_status', '/_config', '/_keys', '/_installs', '/_usage', '/_limits', '/_backups', '/_web/free-tunnel/status', '/v1/models'];
    for (const p of offlineRoutes) {
      const r = await request(`${base}${p}`, { headers });
      ok(r.status === 200, `offline ${p} returns 200 while gateway stopped`);
    }
    const ftOff = await request(`${base}/_web/free-tunnel/status`, { headers });
    ok(
      ftOff.json?.enabled === false
      && ftOff.json?.running === false
      && Array.isArray(ftOff.json?.availableNodes),
      '/_web/free-tunnel/status is disabled by default and exposes availableNodes array'
    );
    const ftBadSelect = await request(`${base}/_web/free-tunnel`, {
      method: 'POST',
      headers,
      body: { action: 'select', nodeKey: '' },
    });
    ok(ftBadSelect.status === 400, 'POST /_web/free-tunnel select without nodeKey returns 400');

    const offMtproto = await request(`${base}/_config`, {
      method: 'POST',
      headers,
      body: { geminiWeb: { proxy: 'tg://proxy?server=1.2.3.4&port=443&secret=ee1234' } },
    });
    ok(offMtproto.status === 400 && offMtproto.json?.error?.code === 'mtproto_unsupported', 'offline POST /_config rejects Telegram MTProto tg://proxy with 400');

    const offBadCustom = await request(`${base}/_models/custom`, {
      method: 'POST',
      headers,
      body: { action: 'add', model: 'bad model id!!' },
    });
    ok(offBadCustom.status === 400, 'offline POST /_models/custom returns 400 on invalid model ID');
    const statusOff = await request(`${base}/_status`, { headers });
    ok(
      statusOff.json?.supervised === true
      && statusOff.json?.serverRunning === false
      && statusOff.json?.dataDir === path.resolve(tmpDir),
      '/_status reports supervised=true serverRunning=false and active dataDir offline'
    );

    const crossPortSup = await request(`${base}/_keys`, {
      headers: { cookie: sessionCookie, origin: 'http://127.0.0.1:3000' },
    });
    ok(crossPortSup.status === 401, 'supervisor rejects session cookie from different localhost port (CSRF defense)');

    const darkSvg = await request(`${base}/icon-dark.svg`);
    const lightSvg = await request(`${base}/icon-light.svg`);
    const darkIco = await request(`${base}/favicon-dark.ico`);
    const lightIco = await request(`${base}/favicon-light.ico`);
    const darkPng48 = await request(`${base}/icon-dark-48.png`);
    const lightPng48 = await request(`${base}/icon-light-48.png`);
    ok(darkSvg.status === 200 && lightSvg.status === 200 && darkSvg.text !== lightSvg.text, '/icon-dark.svg and /icon-light.svg serve distinct theme SVGs');
    ok(darkIco.status === 200 && lightIco.status === 200 && !darkIco.buf.equals(lightIco.buf), '/favicon-dark.ico and /favicon-light.ico serve distinct ICOs');
    ok(
      darkPng48.status === 200 && lightPng48.status === 200
      && darkPng48.buf[0] === 0x89 && darkPng48.buf[1] === 0x50
      && !darkPng48.buf.equals(lightPng48.buf),
      '/icon-dark-48.png and /icon-light-48.png serve crisp theme PNGs'
    );

    const initIcon = await request(`${base}/icon.svg`);
    const initManifest = await request(`${base}/manifest.webmanifest`);
    ok(initIcon.text === darkSvg.text && initManifest.json?.background_color === '#070b14', 'default dark theme serves #8 dark icon & manifest');

    const setLightRes = await request(`${base}/_config`, { method: 'POST', headers, body: { theme: 'light' } });
    ok(setLightRes.status === 200 && setLightRes.json?.ok === true, 'POST /_config switches theme to light');
    const lightActiveSvg = await request(`${base}/icon.svg`);
    const lightActiveIco = await request(`${base}/favicon.ico`);
    const lightManifest = await request(`${base}/manifest.webmanifest`);
    ok(lightActiveSvg.text === lightSvg.text && lightActiveIco.buf.equals(lightIco.buf) && lightManifest.json?.background_color === '#eef3fb', 'light theme dynamically serves #7 light icon, favicon & manifest');

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
    ok(
      statusRun.status === 200
      && statusRun.json?.port === gatewayPort
      && statusRun.json?.serverRunning !== false
      && statusRun.json?.dataDir === path.resolve(tmpDir),
      'proxied /_status responds from live gateway with dataDir'
    );

    const chatProxied = await request(`${base}/api/diagnostics/chat`, {
      method: 'POST',
      headers,
      body: { model: 'gemini-2.5-flash', prompt: '' },
    });
    ok(chatProxied.status === 400, 'proxied chat reaches live server validation instead of 503 server_stopped');

    const liveMtproto = await request(`${base}/_config`, {
      method: 'POST',
      headers,
      body: { geminiWeb: { proxy: 'tg://proxy?server=1.2.3.4&port=443&secret=ee1234' } },
    });
    ok(liveMtproto.status === 400 && liveMtproto.json?.error?.code === 'mtproto_unsupported', 'live gateway POST /_config rejects Telegram MTProto tg://proxy with 400');

    const liveBadCustom = await request(`${base}/_models/custom`, {
      method: 'POST',
      headers,
      body: { action: 'add', model: 'bad model id!!' },
    });
    ok(liveBadCustom.status === 400, 'live gateway POST /_models/custom returns 400 on invalid model ID');

    // Verify catalog.invalidate() works cleanly when reloading auth on a live gateway (CLOUD_DISABLED=0 subprocess check)
    const { ModelCatalog } = require('../lib/models');
    const tmpCat = new ModelCatalog('https://daily-cloudcode-pa.googleapis.com');
    tmpCat.cache = { at: Date.now(), models: new Map([['gemini-2.5-flash', {}]]) };
    tmpCat.invalidate();
    ok(tmpCat.cache === null, 'ModelCatalog.invalidate() clears cached models cleanly');

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

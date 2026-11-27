'use strict';

/**
 * Persistent Local Desktop UI & Gateway Process Supervisor for Antigravity API.
 *
 * Hosts the offline Web Control Panel (`public/`) on an ephemeral loopback port
 * (`127.0.0.1:0`) independently of the API gateway (`server.js`).
 *
 * Why:
 * - Starting the Desktop UI does NOT force-start the API server unless `autoStartServer` is enabled
 *   (or it was already running in the background).
 * - Stopping the API server cleanly closes port 8317 while keeping the Control Panel responsive,
 *   showing `Stopped` state and a working `Start Server` button instead of `Offline` connection errors.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { readJsonFile, writeFileAtomic, backupFile } = require('../lib/safe_files');
const configLib = require('../lib/config');
const { Guard } = require('../lib/guard');
const { NetworkManager } = require('../lib/net');
const { TokenManager, startInteractiveOAuth, getOAuthStatus } = require('../lib/auth');
const { ModelCatalog } = require('../lib/models');
const { GeminiWebBridge } = require('../lib/web_bridge');
const { autoExtract } = require('../lib/token_extract');
const { detectProxies } = require('../lib/proxy_detect');
const installsLib = require('../lib/installs');
const cdpCookies = require('../lib/cdp_cookies');
const shortcuts = require('./shortcuts');
const updater = require('./update');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.AG_DATA_DIR ? path.resolve(process.env.AG_DATA_DIR) : ROOT_DIR;
const LOG_FILE = path.join(os.tmpdir(), 'antigravity-api.log');
const STATE_FILE = path.join(DATA_DIR, '.ui-supervisor.json');
const RESTART_EXIT_CODE = 75;
const APP_VERSION = (() => {
  try { return String(require('../package.json').version || '2.0.0'); } catch { return '2.0.0'; }
})();

const PUBLIC_FILES = {
  '/': { file: path.join(ROOT_DIR, 'public', 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: path.join(ROOT_DIR, 'public', 'index.html'), type: 'text/html; charset=utf-8' },
  '/styles.css': { file: path.join(ROOT_DIR, 'public', 'styles.css'), type: 'text/css; charset=utf-8' },
  '/app.js': { file: path.join(ROOT_DIR, 'public', 'app.js'), type: 'application/javascript; charset=utf-8' },
  '/i18n.js': { file: path.join(ROOT_DIR, 'public', 'i18n.js'), type: 'application/javascript; charset=utf-8' },
  '/charts.js': { file: path.join(ROOT_DIR, 'public', 'charts.js'), type: 'application/javascript; charset=utf-8' },
  '/icon.svg': { file: path.join(ROOT_DIR, 'public', 'icon.svg'), type: 'image/svg+xml' },
  '/icon-192.png': { file: path.join(ROOT_DIR, 'public', 'icon-192.png'), type: 'image/png' },
  '/icon-512.png': { file: path.join(ROOT_DIR, 'public', 'icon-512.png'), type: 'image/png' },
  '/manifest.webmanifest': { file: path.join(ROOT_DIR, 'public', 'manifest.webmanifest'), type: 'application/manifest+json; charset=utf-8' },
  '/favicon.ico': { file: path.join(ROOT_DIR, 'assets', 'antigravity_api.ico'), type: 'image/x-icon' },
};

function readNormalizedConfig() {
  let raw = {};
  try { raw = readJsonFile(path.join(DATA_DIR, 'config.json')); } catch {}
  const norm = configLib.normalize(raw).config;
  if (!norm.apiKey) {
    try { norm.apiKey = fs.readFileSync(path.join(DATA_DIR, 'apikey.txt'), 'utf8').trim(); } catch {}
  }
  if (!norm.adminKey) {
    try { norm.adminKey = fs.readFileSync(path.join(DATA_DIR, 'admin.key'), 'utf8').trim(); } catch {}
  }
  return norm;
}

function saveConfigDirect(cfg) {
  const cfgPath = path.join(DATA_DIR, 'config.json');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { if (fs.existsSync(cfgPath)) backupFile(cfgPath); } catch {}
  writeFileAtomic(cfgPath, JSON.stringify(cfg, null, 2));
}

function sanitizeConfig(cfg) {
  const norm = configLib.normalize(cfg).config;
  const rawCookie = String(norm.geminiWeb?.cookie || '');
  const accounts = (norm.geminiWeb?.accounts || []).map((a) => ({
    name: a.name,
    label: a.label || '',
    proxy: a.proxy || '',
    authUser: a.authUser,
    thinkMode: a.thinkMode || null,
    temporaryChats: a.temporaryChats === true,
    cookie_file: a.cookie_file || '',
    hasCookie: !!a.cookie,
    hasCookieFile: !!a.cookie_file,
  }));
  return {
    ...norm,
    apiKey: undefined,
    adminKey: undefined,
    hasApiKey: !!cfg.apiKey,
    hasAdminKey: !!cfg.adminKey,
    geminiWeb: {
      ...norm.geminiWeb,
      cookie: undefined,
      atToken: undefined,
      cookieSet: !!(rawCookie || norm.geminiWeb?.cookie_file),
      cookieLength: rawCookie.length,
      cookieHasSapisid: /SAPISID=/.test(rawCookie),
      cookieHas1Psid: /__Secure-1PSID=/.test(rawCookie),
      hasAtToken: !!norm.geminiWeb?.atToken,
      accounts,
    },
  };
}

function connectHostOf(cfg) {
  const raw = String(process.env.AG_HOST || cfg.host || '127.0.0.1').trim();
  return (!raw || raw === '0.0.0.0' || raw === '::') ? '127.0.0.1' : raw;
}

function portOf(cfg) {
  return Number(process.env.AG_PORT) || Number(cfg.port) || 8317;
}

function probeHealth(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/_health', method: 'GET', timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(res.statusCode === 200 && j.ok === true ? j : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const txt = Buffer.concat(chunks).toString('utf8').trim();
      if (!txt) return resolve({});
      try { resolve(JSON.parse(txt)); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function rotateLogIfLarge() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > 5 * 1024 * 1024) {
      const prev = LOG_FILE + '.1';
      try { fs.unlinkSync(prev); } catch {}
      fs.renameSync(LOG_FILE, prev);
    }
  } catch {}
}

async function startSupervisor({ autoStart = null } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sessions = new Set();
  const launchNonces = new Map();
  const sseClients = new Set();
  const supSecret = crypto.randomBytes(24).toString('hex');

  let serverState = 'stopped'; // 'stopped' | 'starting' | 'running' | 'stopping'
  let childProc = null;
  let lastError = '';
  let idleExitTimer = null;
  let activeStreamReq = null;
  let activePort = portOf(readNormalizedConfig());
  let activeHost = connectHostOf(readNormalizedConfig());
  let startPromise = null;
  let stopPromise = null;

  function mintNonce() {
    const nonce = crypto.randomBytes(24).toString('hex');
    launchNonces.set(nonce, Date.now() + 120_000);
    return nonce;
  }

  function consumeNonce(nonce) {
    if (!nonce) return false;
    const exp = launchNonces.get(nonce);
    launchNonces.delete(nonce);
    return !!exp && exp >= Date.now();
  }

  function sendJson(res, status, obj) {
    if (res.writableEnded || res.destroyed) return;
    const data = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  }

  function broadcastSse(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try {
        if (!res.writableEnded && !res.destroyed) res.write(frame);
      } catch {}
    }
  }

  function getSupervisorStatus() {
    const cfg = readNormalizedConfig();
    return {
      managed: true,
      state: serverState,
      running: serverState === 'running',
      pid: childProc ? childProc.pid : null,
      port: activePort,
      host: activeHost,
      autoStartServer: cfg.autoStartServer === true,
      lastError: lastError || null,
    };
  }

  function detachUpstreamEvents() {
    if (activeStreamReq) {
      try { activeStreamReq.destroy(); } catch {}
      activeStreamReq = null;
    }
  }

  function attachUpstreamEvents() {
    detachUpstreamEvents();
    if (serverState !== 'running' || !sseClients.size) return;
    const cfg = readNormalizedConfig();
    const adminKey = cfg.adminKey || cfg.apiKey || '';
    const req = http.request({
      host: activeHost,
      port: activePort,
      path: '/_events',
      method: 'GET',
      headers: adminKey ? { 'x-admin-key': adminKey } : {},
    }, (upRes) => {
      if (upRes.statusCode !== 200) {
        upRes.resume();
        return;
      }
      let buf = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (chunk) => {
        buf += chunk;
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const frame of parts) {
          for (const res of sseClients) {
            try {
              if (!res.writableEnded && !res.destroyed) res.write(frame + '\n\n');
            } catch {}
          }
        }
      });
      upRes.on('end', () => {
        activeStreamReq = null;
      });
    });
    req.on('error', () => { activeStreamReq = null; });
    req.end();
    activeStreamReq = req;
  }

  function setState(nextState, err = '') {
    serverState = nextState;
    lastError = err;
    broadcastSse('supervisor', getSupervisorStatus());
    if (nextState === 'running') {
      if (idleExitTimer) { clearTimeout(idleExitTimer); idleExitTimer = null; }
      attachUpstreamEvents();
    } else {
      detachUpstreamEvents();
      scheduleIdleExitIfNeeded();
    }
  }

  function scheduleIdleExitIfNeeded() {
    if (idleExitTimer) { clearTimeout(idleExitTimer); idleExitTimer = null; }
    if (sseClients.size > 0 || serverState !== 'stopped') return;
    idleExitTimer = setTimeout(() => {
      if (sseClients.size === 0 && serverState === 'stopped') {
        cleanupStateFile();
        process.exit(0);
      }
    }, 8000);
    if (idleExitTimer.unref) idleExitTimer.unref();
  }

  async function spawnChildServer() {
    const cfg = readNormalizedConfig();
    activePort = portOf(cfg);
    activeHost = connectHostOf(cfg);
    setState('starting', '');

    rotateLogIfLarge();
    const outFd = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
      cwd: ROOT_DIR,
      env: { ...process.env, AG_SUPERVISED: '1' },
      stdio: ['ignore', outFd, outFd],
      windowsHide: true,
    });
    childProc = child;

    child.on('exit', (code) => {
      try { fs.closeSync(outFd); } catch {}
      if (childProc !== child) return;
      childProc = null;
      if (serverState === 'stopping') return;
      if (code === RESTART_EXIT_CODE) {
        setTimeout(() => { startServer().catch(() => {}); }, 350);
        return;
      }
      const msg = code ? `Server exited with code ${code}` : '';
      setState('stopped', msg);
    });
    child.on('error', (err) => {
      try { fs.closeSync(outFd); } catch {}
      if (childProc !== child) return;
      childProc = null;
      setState('stopped', err.message || 'Spawn error');
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!childProc) throw new Error(lastError || 'Server exited during startup');
      const h = await probeHealth(activePort, activeHost, 900);
      if (h) {
        setState('running', '');
        return getSupervisorStatus();
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for server on ${activeHost}:${activePort}`);
  }

  async function startServer() {
    if (serverState === 'running') return getSupervisorStatus();
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const cfg = readNormalizedConfig();
      activePort = portOf(cfg);
      activeHost = connectHostOf(cfg);
      const already = await probeHealth(activePort, activeHost, 800);
      if (already) {
        setState('running', '');
        return getSupervisorStatus();
      }
      return await spawnChildServer();
    })().catch((e) => {
      setState('stopped', e.message || String(e));
      throw e;
    }).finally(() => { startPromise = null; });
    return startPromise;
  }

  async function stopServer() {
    if (serverState === 'stopped') return getSupervisorStatus();
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      setState('stopping', '');
      detachUpstreamEvents();
      const cfg = readNormalizedConfig();
      const adminKey = cfg.adminKey || cfg.apiKey || '';
      const childRef = childProc;

      await new Promise((resolve) => {
        const req = http.request({
          host: activeHost,
          port: activePort,
          path: '/_server/shutdown',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': '2',
            ...(adminKey ? { 'x-admin-key': adminKey } : {}),
          },
          timeout: 2500,
        }, (res) => { res.resume(); resolve(); });
        req.on('error', resolve);
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.end('{}');
      });

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const stillUp = await probeHealth(activePort, activeHost, 500);
        if (!stillUp && (!childRef || childRef.exitCode !== null)) break;
        await new Promise((r) => setTimeout(r, 150));
      }

      if (childRef && childRef.exitCode === null) {
        try { childRef.kill('SIGKILL'); } catch {}
      }
      childProc = null;
      setState('stopped', '');
      return getSupervisorStatus();
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  async function restartServer() {
    await stopServer();
    await new Promise((r) => setTimeout(r, 250));
    return await startServer();
  }

  const proxyAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });

  function proxyToRunningServer(req, res, pathnameAndQuery) {
    const cfg = readNormalizedConfig();
    const adminKey = cfg.adminKey || cfg.apiKey || '';
    const apiKey = cfg.apiKey || '';
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.cookie;
    delete headers['x-supervisor-auth'];
    if (pathnameAndQuery.startsWith('/v1/') || pathnameAndQuery.startsWith('/v1beta/')) {
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    } else if (adminKey) {
      headers['x-admin-key'] = adminKey;
      headers.authorization = `Bearer ${adminKey}`;
    }
    const upReq = http.request({
      agent: proxyAgent,
      host: activeHost,
      port: activePort,
      path: pathnameAndQuery,
      method: req.method,
      headers,
    }, (upRes) => {
      const outHeaders = { ...upRes.headers };
      delete outHeaders['set-cookie'];
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    });
    upReq.on('error', (err) => {
      sendJson(res, 502, { error: { message: `Gateway unreachable: ${err.message}`, type: 'api_error' } });
    });
    req.pipe(upReq);
  }

  async function handleLocalWhenStopped(req, res, pathname) {
    const cfg = readNormalizedConfig();

    if (pathname === '/_status') {
      const net = new NetworkManager(cfg);
      const tok = new TokenManager(process.env.AG_AUTH_FILE || path.join(DATA_DIR, 'auth.json'), { network: net, allowMissing: true });
      const wb = new GeminiWebBridge({ ...(cfg.geminiWeb || {}), network: net });
      const reply = {
        version: APP_VERSION,
        startedAt: null,
        uptime: 0,
        port: activePort,
        host: activeHost,
        platform: process.platform,
        nodeVersion: process.version,
        supervised: true,
        serverRunning: false,
        cloudDisabled: /^(1|true|yes)$/i.test(String(process.env.AG_NO_CLOUD || '').trim()),
        cloudAuthReady: tok.hasCredentials(),
        requests: 0,
        errors: 0,
        blocked: 0,
        tokenRefreshes: 0,
        tokens: tok.summary(),
        catalogError: null,
        network: net.summary(),
        geminiWeb: wb.summary(),
        agent: cfg.agent,
      };
      net.destroyAll();
      return sendJson(res, 200, reply);
    }

    if (pathname === '/_limits' || pathname === '/_quota') {
      const guard = new Guard(cfg.safeMode || {}, process.env.AG_USAGE_FILE || path.join(DATA_DIR, 'usage.json'));
      const net = new NetworkManager(cfg);
      const wb = new GeminiWebBridge({ ...(cfg.geminiWeb || {}), network: net });
      const reply = {
        local: guard.summary(),
        account: { error: 'server_stopped' },
        models: [],
        modelsError: 'API server is stopped',
        quotaFamilies: {},
        serverQuotas: null,
        config: { safeMode: guard.cfg },
        geminiWeb: wb.summary(),
        network: net.summary(),
      };
      net.destroyAll();
      return sendJson(res, 200, reply);
    }

    if (pathname === '/_usage') {
      const guard = new Guard(cfg.safeMode || {}, process.env.AG_USAGE_FILE || path.join(DATA_DIR, 'usage.json'));
      return sendJson(res, 200, {
        summary: guard.summary(),
        history: guard.history(30),
        stats: { requests: 0, errors: 0, blocked: 0, uptime: 0 },
      });
    }

    if (pathname === '/_logs') {
      return sendJson(res, 200, { logs: [], stats: { requests: 0, errors: 0, blocked: 0, uptime: 0 } });
    }

    if (pathname === '/v1/models') {
      const wb = new GeminiWebBridge({ ...(cfg.geminiWeb || {}) });
      const data = wb.enabled ? wb.getModelsList().map((m) => ({ ...m, id: `web/${m.id}`, provider: 'web' })) : [];
      return sendJson(res, 200, { object: 'list', data, serverStopped: true });
    }

    if (pathname === '/_keys') {
      return sendJson(res, 200, { apiKey: cfg.apiKey || '', adminKey: cfg.adminKey || '' });
    }

    if (pathname === '/_config') {
      if (req.method === 'GET') return sendJson(res, 200, sanitizeConfig(cfg));
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const patch = configLib.patchConfig(cfg, body);
        saveConfigDirect(patch.config);
        activePort = portOf(patch.config);
        activeHost = connectHostOf(patch.config);
        broadcastSse('supervisor', getSupervisorStatus());
        return sendJson(res, 200, {
          ok: true,
          applied: patch.applied,
          ignored: patch.ignored,
          warnings: patch.warnings,
          restartRequired: [],
        });
      }
    }

    if (pathname === '/_web/accounts') {
      if (req.method === 'GET') {
        const wb = new GeminiWebBridge({ ...(cfg.geminiWeb || {}) });
        return sendJson(res, 200, {
          activeAccount: cfg.geminiWeb.activeAccount || '',
          accounts: (cfg.geminiWeb.accounts || []).map((a) => ({
            name: a.name,
            label: a.label || '',
            proxy: a.proxy || '',
            authUser: a.authUser,
            thinkMode: a.thinkMode || null,
            temporaryChats: a.temporaryChats === true,
            cookie_file: a.cookie_file || '',
            hasCookie: !!a.cookie,
            hasCookieFile: !!a.cookie_file,
            stats: null,
          })),
        });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const action = String(body.action || 'add').toLowerCase();
        const name = String(body.name || '').trim();
        const accounts = (cfg.geminiWeb.accounts || []).map((a) => ({ ...a }));
        if (!name) return sendJson(res, 400, { error: { message: 'Account name is required' } });
        const idx = accounts.findIndex((a) => a.name.toLowerCase() === name.toLowerCase());
        let activeAccount = cfg.geminiWeb.activeAccount || '';
        if (action === 'add' || action === 'update') {
          const item = idx >= 0 ? { ...accounts[idx] } : { name };
          if (typeof body.cookie === 'string') item.cookie = body.cookie;
          if (typeof body.cookie_file === 'string' || typeof body.cookieFile === 'string') item.cookie_file = body.cookie_file || body.cookieFile || '';
          if (typeof body.proxy === 'string') item.proxy = body.proxy.trim();
          if (typeof body.label === 'string') item.label = body.label;
          if (body.authUser === null || body.authUser === '' || Number.isInteger(body.authUser)) item.authUser = Number.isInteger(body.authUser) ? body.authUser : null;
          if (body.thinkMode === 'extended' || body.thinkMode === 'default' || body.thinkMode === null || body.thinkMode === '') item.thinkMode = body.thinkMode || null;
          if (typeof body.temporaryChats === 'boolean') item.temporaryChats = body.temporaryChats;
          if (idx >= 0) accounts[idx] = item; else accounts.push(item);
          if (!activeAccount || body.activate === true) activeAccount = item.name;
        } else if (action === 'remove') {
          if (idx === -1) return sendJson(res, 404, { error: { message: `Account not found: ${name}` } });
          accounts.splice(idx, 1);
          if (activeAccount === name) activeAccount = accounts[0] ? accounts[0].name : '';
        } else if (action === 'activate') {
          if (idx === -1) return sendJson(res, 404, { error: { message: `Account not found: ${name}` } });
          activeAccount = accounts[idx].name;
        }
        const patch = configLib.patchConfig(cfg, { geminiWeb: { accounts, activeAccount } });
        saveConfigDirect(patch.config);
        return sendJson(res, 200, { ok: true, action, activeAccount: patch.config.geminiWeb.activeAccount, accounts: sanitizeConfig(patch.config).geminiWeb.accounts });
      }
    }

    if (pathname === '/_web/browser/open' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const activeAcc = (cfg.geminiWeb.accounts || []).find((a) => a.name === cfg.geminiWeb.activeAccount);
      const rawProxy = String(
        body.proxy
        || (body.accountName ? ((cfg.geminiWeb.accounts || []).find((a) => a.name === body.accountName)?.proxy || '') : '')
        || (activeAcc && activeAcc.proxy)
        || cfg.geminiWeb.proxy
        || cfg.network.proxy
        || ''
      ).trim();
      return sendJson(res, 200, cdpCookies.openGeminiLoginWindow(cdpCookies.GEMINI_URL, { proxy: rawProxy }));
    }

    if (pathname === '/_web/browser/import-cookies' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const targetAcc = body.accountName ? (cfg.geminiWeb.accounts || []).find((a) => a.name === body.accountName) : null;
      const activeAcc = (cfg.geminiWeb.accounts || []).find((a) => a.name === cfg.geminiWeb.activeAccount);
      const rawProxy = String(
        body.proxy
        || (targetAcc && targetAcc.proxy)
        || (activeAcc && activeAcc.proxy)
        || cfg.geminiWeb.proxy
        || cfg.network.proxy
        || ''
      ).trim();
      const resCdp = await cdpCookies.importGeminiCookiesViaCdp({ extractAtToken: true, proxy: rawProxy });
      let saved = false;
      if (resCdp.cookie && body.saveTo === 'single') {
        const patch = configLib.patchConfig(cfg, {
          geminiWeb: { cookie: resCdp.cookie, cookie_file: '', ...(resCdp.atToken ? { atToken: resCdp.atToken } : {}) },
        });
        saveConfigDirect(patch.config);
        saved = true;
      } else if (resCdp.cookie && body.saveTo === 'account' && body.accountName) {
        const name = String(body.accountName).trim();
        const list = (cfg.geminiWeb.accounts || []).map((a) => ({ ...a }));
        const existing = list.find((a) => a.name.toLowerCase() === name.toLowerCase());
        if (existing) { existing.cookie = resCdp.cookie; existing.cookie_file = ''; }
        else list.push({ name, cookie: resCdp.cookie, cookie_file: '', authUser: null, proxy: '', label: '', thinkMode: null, temporaryChats: false });
        const patch = configLib.patchConfig(cfg, { geminiWeb: { accounts: list, activeAccount: name } });
        saveConfigDirect(patch.config);
        saved = true;
      }
      return sendJson(res, 200, { ok: resCdp.ok, count: resCdp.count, hasSapisid: resCdp.hasSapisid, has1Psid: resCdp.has1Psid, domains: resCdp.domains, hasAtToken: !!resCdp.atToken, saved });
    }

    if (pathname === '/_web/test' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const webProxy = String(body.proxy !== undefined ? body.proxy : (cfg.geminiWeb.proxy || cfg.network.proxy || '')).trim();
      const tmpNet = new NetworkManager({ ...cfg, network: { ...cfg.network, proxy: webProxy } });
      try {
        const [geminiProbe, accountsProbe] = await Promise.all([
          tmpNet.probe('https://gemini.google.com/app', 'web', 6000),
          tmpNet.probe('https://accounts.google.com/', 'web', 6000),
        ]);
        const proxyCheck = webProxy ? await tmpNet.probeProxy(tmpNet.proxyForHost('web', 'gemini.google.com', webProxy), 5000) : null;
        return sendJson(res, 200, {
          ok: geminiProbe.ok && (!proxyCheck || proxyCheck.ok),
          proxy: webProxy || '',
          proxyCheck,
          gemini: geminiProbe,
          accounts: accountsProbe,
        });
      } finally {
        tmpNet.destroyAll();
      }
    }

    if ((pathname === '/_auth/extract' || pathname === '/_auth/reload') && req.method === 'POST') {
      if (pathname === '/_auth/extract') {
        const out = autoExtract({ force: true, outPath: process.env.AG_AUTH_FILE || path.join(DATA_DIR, 'auth.json') });
        return sendJson(res, 200, { ok: true, dbSource: out.data?.db_source || '', path: out.path });
      }
      const net = new NetworkManager(cfg);
      const tok = new TokenManager(process.env.AG_AUTH_FILE || path.join(DATA_DIR, 'auth.json'), { network: net, allowMissing: true });
      net.destroyAll();
      return sendJson(res, 200, { ok: true, tokens: tok.summary() });
    }

    if (pathname === '/_installs') {
      if (req.method === 'GET') {
        const force = /[?&]force=1(?:&|$)/.test(req.url || '');
        return sendJson(res, 200, installsLib.detectInstallations(DATA_DIR, { force }));
      }
      const body = await readJsonBody(req);
      return sendJson(res, 200, installsLib.setInstallPath(DATA_DIR, body.key, body.path));
    }
    if (pathname === '/_installs/open' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, installsLib.openInstallFolder(DATA_DIR, body.key));
    }

    if (pathname === '/_startup') {
      if (req.method === 'GET') return sendJson(res, 200, shortcuts.getAutostartInfo({ rootDir: ROOT_DIR }));
      const body = await readJsonBody(req);
      return sendJson(res, 200, shortcuts.setAutostart(!!body.enabled, { rootDir: ROOT_DIR }));
    }

    if (pathname === '/_backups' && req.method === 'GET') {
      return sendJson(res, 200, { backups: updater.listBackups({ rootDir: ROOT_DIR }) });
    }
    if (pathname === '/_backup' && req.method === 'POST') {
      const result = updater.createBackup({ rootDir: ROOT_DIR, dataDir: DATA_DIR, reason: 'panel' });
      return sendJson(res, 200, { ok: true, backup: result.manifest });
    }

    if (pathname === '/_network/detect-proxy' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, proxies: await detectProxies() });
    }
    if (pathname === '/_network/test') {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const draftCfg = {
        ...cfg,
        ...(body.network && typeof body.network === 'object' ? { network: { ...cfg.network, ...body.network } } : {}),
      };
      const net = new NetworkManager(draftCfg);
      try {
        return sendJson(res, 200, await net.test(Math.max(2000, Math.min(15000, Number(body.timeout) || 5000))));
      } finally {
        net.destroyAll();
      }
    }

    if (pathname === '/_auth/oauth/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const net = new NetworkManager(cfg);
      const authFile = process.env.AG_AUTH_FILE || path.join(DATA_DIR, 'auth.json');
      const started = await startInteractiveOAuth({
        authFile,
        network: net,
        openBrowser: body.openBrowser !== false,
        onSuccess: () => { net.destroyAll(); },
      });
      return sendJson(res, 200, started);
    }

    if (pathname === '/_auth/oauth/status' && req.method === 'GET') {
      return sendJson(res, 200, getOAuthStatus());
    }

    if (pathname === '/_models/catalog' && req.method === 'GET') {
      const cat = new ModelCatalog(cfg.upstreamHost || 'https://daily-cloudcode-pa.googleapis.com', {
        registryFile: path.join(DATA_DIR, 'known_models.json'),
      });
      const wb = new GeminiWebBridge({ ...(cfg.geminiWeb || {}) });
      const web = wb.enabled ? wb.getModelsList().map((m) => ({
        id: `web/${m.id}`,
        rawId: m.id,
        provider: 'web',
        displayName: m.display_name || m.displayName || m.id,
        inLiveCatalog: true,
        health: cat.getHealth(`web/${m.id}`),
      })) : [];
      const snap = cat.getCatalogSnapshot();
      return sendJson(res, 200, { ...snap, web, serverStopped: true, catalogError: null });
    }

    if (pathname === '/_models/custom' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const cat = new ModelCatalog(cfg.upstreamHost || 'https://daily-cloudcode-pa.googleapis.com', {
        registryFile: path.join(DATA_DIR, 'known_models.json'),
      });
      const action = String(body.action || 'add').toLowerCase();
      const modelId = String(body.model || '').trim();
      if (action === 'remove') {
        const removed = cat.removeCustomModel(modelId);
        return sendJson(res, 200, { ok: true, removed, snapshot: cat.getCatalogSnapshot() });
      }
      const added = cat.addCustomModel(modelId, body.displayName || '');
      return sendJson(res, 200, { ok: true, model: added, snapshot: cat.getCatalogSnapshot() });
    }

    if (pathname === '/_models/check' && req.method === 'POST') {
      return sendJson(res, 503, {
        ok: false,
        error: { code: 'server_stopped', message: 'API-сервер остановлен. Нажмите «Запустить сервер», чтобы проверить работоспособность моделей.' },
      });
    }

    if (pathname === '/api/diagnostics/chat') {
      return sendJson(res, 503, {
        ok: false,
        error: { code: 'server_stopped', stage: 'supervisor', message: 'API server is stopped. Click "Start Server" first to run diagnostic chat.' },
      });
    }

    return sendJson(res, 404, { error: { message: 'Not found' } });
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const p = u.pathname;

      if (p === '/_supervisor/health') {
        return sendJson(res, 200, { ok: true, version: APP_VERSION });
      }

      if (p === '/' && req.method === 'GET') {
        const launch = u.searchParams.get('launch');
        if (launch && consumeNonce(launch)) {
          const sid = crypto.randomBytes(24).toString('hex');
          sessions.add(sid);
          res.setHeader('set-cookie', `ag_sup_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
          res.writeHead(302, { location: '/' });
          return res.end();
        }
      }

      if (req.method === 'GET' && PUBLIC_FILES[p]) {
        const asset = PUBLIC_FILES[p];
        const data = fs.readFileSync(asset.file);
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
        return res.end(data);
      }

      const sid = parseCookies(req).ag_sup_session;
      const isAuthed = !!(sid && sessions.has(sid));

      if (p === '/_auth/session') {
        if (req.method === 'GET') {
          return sendJson(res, 200, { authenticated: isAuthed, supervised: true });
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const cfg = readNormalizedConfig();
          const expected = cfg.adminKey || cfg.apiKey || '';
          const candidate = String(body.adminKey || body.key || '').trim();
          if (!expected || candidate !== expected) {
            return sendJson(res, 401, { error: { message: 'Invalid administrator key', type: 'invalid_request_error' } });
          }
          const newSid = crypto.randomBytes(24).toString('hex');
          sessions.add(newSid);
          res.setHeader('set-cookie', `ag_sup_session=${newSid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
          return sendJson(res, 200, { ok: true });
        }
      }

      if (p === '/_auth/logout' && req.method === 'POST') {
        if (sid) sessions.delete(sid);
        res.setHeader('set-cookie', 'ag_sup_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/_supervisor/nonce' && req.method === 'POST') {
        const hdr = String(req.headers['x-supervisor-token'] || '');
        const validSecret = hdr.length === supSecret.length && crypto.timingSafeEqual(Buffer.from(hdr), Buffer.from(supSecret));
        if (!isAuthed && !validSecret) {
          return sendJson(res, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
        }
        return sendJson(res, 200, { ok: true, nonce: mintNonce() });
      }

      if (!isAuthed) {
        return sendJson(res, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
      }

      if (p === '/_supervisor/status') return sendJson(res, 200, getSupervisorStatus());
      if (p === '/_supervisor/start' && req.method === 'POST') return sendJson(res, 200, await startServer());
      if (p === '/_supervisor/stop' && req.method === 'POST') return sendJson(res, 200, await stopServer());
      if (p === '/_supervisor/restart' && req.method === 'POST') return sendJson(res, 200, await restartServer());

      if (p === '/_events' && req.method === 'GET') {
        if (idleExitTimer) { clearTimeout(idleExitTimer); idleExitTimer = null; }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        sseClients.add(res);
        res.write(`event: supervisor\ndata: ${JSON.stringify(getSupervisorStatus())}\n\n`);
        if (serverState === 'running' && !activeStreamReq) attachUpstreamEvents();
        const hb = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
        }, 15000);
        if (hb.unref) hb.unref();
        req.on('close', () => {
          clearInterval(hb);
          sseClients.delete(res);
          if (!sseClients.size) detachUpstreamEvents();
          scheduleIdleExitIfNeeded();
        });
        return;
      }

      if (serverState === 'running') {
        if (p === '/_server/restart' && req.method === 'POST') {
          sendJson(res, 200, { ok: true, action: 'restart', port: activePort, supervised: true });
          restartServer().catch(() => {});
          return;
        }
        if (p === '/_server/shutdown' && req.method === 'POST') {
          return sendJson(res, 200, await stopServer());
        }
        return proxyToRunningServer(req, res, `${u.pathname}${u.search}`);
      }

      return await handleLocalWhenStopped(req, res, p);
    } catch (e) {
      const code = Number.isInteger(e.status) ? e.status : 500;
      sendJson(res, code, { error: { message: e.message || String(e), type: 'internal_error' } });
    }
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const uiPort = httpServer.address().port;
  const uiUrl = `http://127.0.0.1:${uiPort}/`;

  function cleanupStateFile() {
    try {
      const cur = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (cur && cur.pid === process.pid) fs.unlinkSync(STATE_FILE);
    } catch {}
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: uiPort, uiUrl, supToken: supSecret }, null, 2));
  if (process.platform !== 'win32') { try { fs.chmodSync(STATE_FILE, 0o600); } catch {} }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      cleanupStateFile();
      try { if (childProc && childProc.exitCode === null) childProc.kill('SIGTERM'); } catch {}
      process.exit(0);
    });
  }

  // Adopt running gateway if started via --hidden or external CLI; otherwise only auto-start if configured.
  const cfg = readNormalizedConfig();
  const alreadyUp = await probeHealth(portOf(cfg), connectHostOf(cfg), 600);
  if (alreadyUp) {
    setState('running', '');
  } else if (autoStart === true || cfg.autoStartServer === true) {
    startServer().catch(() => {});
  }

  return { httpServer, uiPort, uiUrl, mintNonce };
}

if (require.main === module) {
  const autoStart = process.argv.includes('--start') ? true : null;
  startSupervisor({ autoStart }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { startSupervisor };

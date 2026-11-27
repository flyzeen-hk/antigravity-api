'use strict';

/**
 * Cross-platform Desktop Launcher & Background Supervisor for Antigravity API.
 *
 * Modes:
 * - Default (`npm run ui` / Desktop shortcut / `run.bat`):
 *   Ensures the lightweight UI Supervisor (`scripts/ui_supervisor.js`) is running on loopback,
 *   mints a one-time launch nonce, and opens the offline Web Control Panel inside an isolated
 *   Edge/Chrome app window (`--user-data-dir` prevents browser profile avatar badges on taskbar).
 *   The API server (`server.js`) stays stopped until clicked, or auto-starts if `autoStartServer: true`.
 * - `--hidden`: starts `server.js` daemon in background (used by OS startup shortcut).
 * - `--daemon`: direct headless supervisor loop for `server.js`.
 * - `--browser`: opens Control Panel in default browser instead of `--app` window.
 * - `--start`: auto-starts the API server immediately alongside opening the UI.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { readJsonFile } = require('../lib/safe_files');
const { findBrowserExecutable } = require('../lib/cdp_cookies');
const { openExternalUrl } = require('../lib/auth');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.AG_DATA_DIR ? path.resolve(process.env.AG_DATA_DIR) : ROOT_DIR;
const RESTART_EXIT_CODE = 75;
const LOG_FILE = path.join(os.tmpdir(), 'antigravity-api.log');
const SUP_STATE_FILE = path.join(DATA_DIR, '.ui-supervisor.json');

function readListenTarget() {
  let cfg = {};
  try { cfg = readJsonFile(path.join(DATA_DIR, 'config.json')); } catch {}
  const port = Number(process.env.AG_PORT) || Number(cfg.port) || 8317;
  const hostRaw = String(process.env.AG_HOST || cfg.host || '127.0.0.1').trim();
  const connectHost = (!hostRaw || hostRaw === '0.0.0.0' || hostRaw === '::') ? '127.0.0.1' : hostRaw;
  let adminKey = String(cfg.adminKey || '').trim();
  if (!adminKey) {
    try { adminKey = fs.readFileSync(path.join(DATA_DIR, 'admin.key'), 'utf8').trim(); } catch {}
  }
  return { port, host: connectHost, adminKey };
}

function httpJson(method, port, reqPath, { headers = {}, body = null, timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode, body: { raw: data } });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function probeHealth(port, reqPath = '/_health') {
  try {
    const res = await httpJson('GET', port, reqPath, { timeoutMs: 1200 });
    return res.status === 200 && res.body && res.body.ok === true;
  } catch {
    return false;
  }
}

async function mintLaunchNonce(port, adminKey) {
  if (!adminKey) return '';
  try {
    const res = await httpJson('POST', port, '/_auth/launch', {
      headers: { 'x-admin-key': adminKey },
      timeoutMs: 1500,
    });
    if (res.status === 200 && res.body && res.body.nonce) return res.body.nonce;
  } catch {}
  return '';
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

function openUiWindow(url, { preferBrowser = false } = {}) {
  if (!preferBrowser) {
    const browserExe = findBrowserExecutable();
    if (browserExe) {
      const appProfile = path.join(os.tmpdir(), 'antigravity-api-ui-profile');
      try { fs.mkdirSync(appProfile, { recursive: true }); } catch {}
      // Dedicated --user-data-dir keeps Chromium/Edge in single-profile app mode so
      // Windows taskbar shows our icon cleanly without a browser profile avatar badge.
      const child = spawn(browserExe, [
        `--user-data-dir=${appProfile}`,
        `--app=${url}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-features=TranslateUI',
        '--window-size=1320,880',
      ], { detached: true, stdio: 'ignore' });
      child.unref();
      return { mode: 'app', exe: browserExe };
    }
  }

  if (!openExternalUrl(url)) {
    const psScript = `Start-Process -FilePath '${String(url).replace(/'/g, "''")}'`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  }
  return { mode: 'browser' };
}

async function runDaemon(initialNonce = '') {
  const pidFile = path.join(DATA_DIR, '.launcher.pid');
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try { fs.writeFileSync(pidFile, String(process.pid), 'utf8'); } catch {}

  let currentChild = null;
  let shuttingDown = false;

  const cleanup = () => { try { fs.unlinkSync(pidFile); } catch {} };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      shuttingDown = true;
      if (currentChild) { try { currentChild.kill('SIGTERM'); } catch {} }
    });
  }

  let nextNonce = initialNonce;
  while (!shuttingDown) {
    rotateLogIfLarge();
    const outFd = fs.openSync(LOG_FILE, 'a');
    const env = {
      ...process.env,
      AG_SUPERVISED: '1',
      ...(nextNonce ? { AG_LAUNCH_NONCE: nextNonce } : {}),
    };
    nextNonce = '';

    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
        cwd: ROOT_DIR,
        env,
        stdio: ['ignore', outFd, outFd],
        windowsHide: true,
      });
      currentChild = child;
      child.on('exit', (code) => {
        currentChild = null;
        try { fs.closeSync(outFd); } catch {}
        resolve(code ?? 0);
      });
      child.on('error', () => {
        currentChild = null;
        try { fs.closeSync(outFd); } catch {}
        resolve(1);
      });
    });

    if (exitCode !== RESTART_EXIT_CODE || shuttingDown) {
      cleanup();
      process.exit(exitCode);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  cleanup();
}

async function ensureHiddenServer() {
  const target = readListenTarget();
  if (await probeHealth(target.port)) return;
  const child = spawn(process.execPath, [__filename, '--daemon'], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await probeHealth(target.port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function readAliveSupervisor() {
  try {
    const info = JSON.parse(fs.readFileSync(SUP_STATE_FILE, 'utf8'));
    if (info && info.port && (await probeHealth(info.port, '/_supervisor/health'))) {
      return info;
    }
  } catch {}
  return null;
}

async function launchSupervisedUi({ preferBrowser = false, autoStartFlag = false } = {}) {
  let info = await readAliveSupervisor();
  if (!info) {
    const supScript = path.join(__dirname, 'ui_supervisor.js');
    const args = autoStartFlag ? [supScript, '--start'] : [supScript];
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      info = await readAliveSupervisor();
      if (info) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!info) {
      throw new Error(`UI supervisor failed to start cleanly. Check ${LOG_FILE}`);
    }
  }

  let uiUrl = info.uiUrl || `http://127.0.0.1:${info.port}/`;
  try {
    const res = await httpJson('POST', info.port, '/_supervisor/nonce', {
      headers: info.supToken ? { 'x-supervisor-token': info.supToken } : {},
      timeoutMs: 1200,
    });
    if (res.status === 200 && res.body && res.body.nonce) {
      uiUrl = `${uiUrl}?launch=${encodeURIComponent(res.body.nonce)}`;
    }
  } catch {}
  openUiWindow(uiUrl, { preferBrowser });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--daemon')) {
    const idx = argv.indexOf('--nonce');
    const nonce = idx !== -1 && argv[idx + 1] ? argv[idx + 1] : '';
    await runDaemon(nonce);
    return;
  }

  if (argv.includes('--hidden')) {
    await ensureHiddenServer();
    return;
  }

  const preferBrowser = argv.includes('--browser');
  const autoStartFlag = argv.includes('--start');
  await launchSupervisedUi({ preferBrowser, autoStartFlag });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = {
  readListenTarget,
  probeHealth,
  mintLaunchNonce,
  openUiWindow,
  RESTART_EXIT_CODE,
};

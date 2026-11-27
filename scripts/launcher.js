'use strict';

/**
 * Cross-platform Desktop Launcher & Background Supervisor for Antigravity API.
 *
 * Modes:
 * - Default: checks if server is already healthy; if not, launches `--daemon` supervisor
 *   in the background, waits for `/_health`, and opens the Web Control Panel in an
 *   isolated desktop app window (Edge/Chrome `--app=...`) or default browser.
 * - `--hidden`: starts server in the background without opening a UI window.
 * - `--browser`: forces opening in the default browser tab instead of `--app` window.
 * - `--daemon`: internal background supervisor that keeps `server.js` running and
 *   automatically restarts it (re-reading `config.json`) on graceful restart exit code 75.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readJsonFile } = require('../lib/safe_files');
const { findBrowserExecutable } = require('../lib/cdp_cookies');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.AG_DATA_DIR || ROOT_DIR;
const RESTART_EXIT_CODE = 75;
const LOG_FILE = path.join(os.tmpdir(), 'antigravity-api.log');

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

async function probeHealth(port) {
  try {
    const res = await httpJson('GET', port, '/_health', { timeoutMs: 1200 });
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
      const child = spawn(browserExe, [
        `--app=${url}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,860',
      ], { detached: true, stdio: 'ignore' });
      child.unref();
      return { mode: 'app', exe: browserExe };
    }
  }

  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } else if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
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

  const cleanup = () => {
    try { fs.unlinkSync(pidFile); } catch {}
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      shuttingDown = true;
      if (currentChild) {
        try { currentChild.kill('SIGTERM'); } catch {}
      }
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
    // Brief pause for OS socket release before restart on new/same port
    await new Promise((r) => setTimeout(r, 350));
  }
  cleanup();
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--daemon')) {
    const idx = argv.indexOf('--nonce');
    const nonce = idx !== -1 && argv[idx + 1] ? argv[idx + 1] : '';
    await runDaemon(nonce);
    return;
  }

  const hidden = argv.includes('--hidden');
  const preferBrowser = argv.includes('--browser');
  const target = readListenTarget();
  let port = target.port;

  const alreadyRunning = await probeHealth(port);
  let launchNonce = '';

  if (alreadyRunning) {
    launchNonce = await mintLaunchNonce(port, target.adminKey);
  } else {
    launchNonce = crypto.randomBytes(24).toString('hex');
    const daemonArgs = [__filename, '--daemon', '--nonce', launchNonce];
    const child = spawn(process.execPath, daemonArgs, {
      cwd: ROOT_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + 12000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (await probeHealth(port)) {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!healthy) {
      console.error(`Server failed to respond on http://127.0.0.1:${port}/_health. See log: ${LOG_FILE}`);
      process.exit(1);
    }
    // Refresh adminKey in case first launch just generated config/admin.key
    const refreshed = readListenTarget();
    port = refreshed.port;
  }

  if (!hidden) {
    const baseUrl = `http://127.0.0.1:${port}/`;
    const uiUrl = launchNonce ? `${baseUrl}?launch=${encodeURIComponent(launchNonce)}` : baseUrl;
    openUiWindow(uiUrl, { preferBrowser });
  }
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
  openUiWindow,
  RESTART_EXIT_CODE,
};

'use strict';

/**
 * Pure Node.js Gemini dedicated browser launcher & CDP cookie importer.
 *
 * Replaces `scripts/gemini_browser.py` + `scripts/cookies_cdp.py` without Python:
 * - Launches Chrome/Edge/Chromium/Brave in an isolated profile directory
 * - Never enables remote debugging during sign-in (Google blocks login with DevTools open)
 * - Gently closes and restarts with loopback-only `--remote-debugging-port=0`
 *   to extract decrypted `google.com` cookies via CDP (bypassing Chrome v20 App-Bound Encryption).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const GEMINI_URL = 'https://gemini.google.com/app';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SAPISID_RE = /^[A-Za-z0-9_\-./=]+$/;
const BROWSER_PROC_NAMES = ['chrome.exe', 'msedge.exe', 'brave.exe', 'chromium.exe', 'vivaldi.exe'];
const profileLocks = new Map();

function withProfileLock(profileDir, fn) {
  const key = path.resolve(profileDir || getProfileDir());
  const prev = profileLocks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  const marker = run.catch(() => {});
  profileLocks.set(key, marker);
  marker.finally(() => {
    if (profileLocks.get(key) === marker) profileLocks.delete(key);
  });
  return run;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runHiddenPowerShell(script, timeoutMs = 8000) {
  const body = `$ProgressPreference = 'SilentlyContinue';\n${script}`;
  const encoded = Buffer.from(body, 'utf16le').toString('base64');
  return await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
  );
}

function getProfileDir() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'AntigravityAPI', 'GeminiBrowser');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AntigravityAPI', 'GeminiBrowser');
  }
  return path.join(os.homedir(), '.local', 'share', 'AntigravityAPI', 'GeminiBrowser');
}

function getWindowsDefaultChromiumExecutable() {
  if (process.platform !== 'win32') return null;
  try {
    const uc = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const pm = uc.match(/ProgId\s+REG_SZ\s+([^\r\n]+)/i);
    if (!pm) return null;
    const progId = pm[1].trim();
    if (!/^(BraveHTML|ChromeHTML|MSEdgeHTM|ChromiumHTM|VivaldiHTM)/i.test(progId)) return null;
    const cmdOut = execFileSync(
      'reg',
      ['query', `HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`, '/ve'],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const cm = cmdOut.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i);
    if (!cm) return null;
    let rawCmd = cm[1].trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
    const exe = rawCmd.startsWith('"')
      ? rawCmd.slice(1, rawCmd.indexOf('"', 1))
      : rawCmd.split(/\s+/)[0];
    return exe && fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

function findBrowserExecutable() {
  const defaultChromium = getWindowsDefaultChromiumExecutable();
  if (defaultChromium) return defaultChromium;

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const cmdNames = process.platform === 'win32'
    ? ['brave.exe', 'chrome.exe', 'msedge.exe', 'chromium.exe']
    : ['google-chrome', 'brave-browser', 'microsoft-edge', 'chromium', 'chromium-browser'];

  for (const dir of pathDirs) {
    for (const cmd of cmdNames) {
      const p = path.join(dir, cmd);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }

  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(
        path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(base, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/microsoft-edge',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/brave-browser',
      '/snap/bin/chromium',
    );
  }

  return candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseUserDataDirFromCommandLine(cmd = '') {
  const m = String(cmd || '').match(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|(\S+))/i);
  return m ? String(m[1] || m[2] || '').trim() : '';
}

function parseProxyFromCommandLine(cmd = '') {
  const m = String(cmd || '').match(/(?:^|\s)--proxy-server=(?:"([^"]+)"|(\S+))/i);
  return m ? normalizeBrowserProxy(m[1] || m[2] || '') : '';
}

function removeDevToolsActivePort(profileDir) {
  try { fs.unlinkSync(path.join(profileDir, 'DevToolsActivePort')); } catch {}
}

function classifyProfileProcesses(procs, expectedProxy = '', { hasDevToolsPortFile = false, profileDir = '' } = {}) {
  const targetDir = profileDir ? path.resolve(profileDir) : '';
  const targetNorm = process.platform === 'win32' ? targetDir.toLowerCase() : targetDir;
  const matching = (Array.isArray(procs) ? procs : []).filter((p) => {
    const cmd = String(p && p.commandLine || '');
    if (!cmd) return false;
    if (!targetDir) return true;
    const parsedDir = parseUserDataDirFromCommandLine(cmd);
    if (parsedDir) {
      const resolved = path.resolve(parsedDir);
      return (process.platform === 'win32' ? resolved.toLowerCase() : resolved) === targetNorm;
    }
    return process.platform === 'win32'
      ? cmd.toLowerCase().includes(targetNorm)
      : cmd.includes(targetDir);
  });

  const mainProcs = matching.filter((p) => !/(?:^|\s)--type=/i.test(p.commandLine));
  const hasHeadless = matching.some((p) => /(?:^|\s)--headless(?:=|\s|$)/i.test(p.commandLine));
  const hasRemoteDebugging = matching.some((p) => /(?:^|\s)--remote-debugging-port(?:=|\s|$)/i.test(p.commandLine));
  const expectedProxyNorm = normalizeBrowserProxy(expectedProxy);
  const proxyMismatch = mainProcs.some((p) => parseProxyFromCommandLine(p.commandLine) !== expectedProxyNorm);
  const orphansOnly = matching.length > 0 && mainProcs.length === 0;
  const shouldRestartForVisibleWindow = (
    hasHeadless
    || hasRemoteDebugging
    || proxyMismatch
    || orphansOnly
    || (matching.length === 0 && hasDevToolsPortFile)
  );
  return {
    matching,
    mainProcs,
    hasHeadless,
    hasRemoteDebugging,
    proxyMismatch,
    orphansOnly,
    expectedProxyNorm,
    shouldRestartForVisibleWindow,
  };
}

async function listProfileBrowserProcesses(profileDir = getProfileDir()) {
  const dir = path.resolve(profileDir);
  try {
    if (process.platform === 'win32') {
      const escaped = dir.replace(/'/g, "''");
      const namesList = BROWSER_PROC_NAMES.map((n) => `'${n}'`).join(',');
      const script = [
        `$d = '${escaped}';`,
        `$names = @(${namesList});`,
        `$json = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -and ($names -contains $_.Name.ToLowerInvariant()) -and $_.CommandLine -and ($_.CommandLine.IndexOf($d, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress;`,
        `if (-not $json) { $json = '[]' }`,
        `[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))`,
      ].join('\n');
      const { stdout } = await runHiddenPowerShell(script, 6000);
      const b64 = String(stdout || '').trim();
      if (!b64) return [];
      const decoded = Buffer.from(b64, 'base64').toString('utf8').trim();
      if (!decoded) return [];
      const parsed = JSON.parse(decoded);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return classifyProfileProcesses(
        list.map((item) => ({ pid: Number(item.ProcessId), commandLine: String(item.CommandLine || '') }))
          .filter((item) => Number.isInteger(item.pid) && item.pid > 0),
        '',
        { profileDir: dir },
      ).matching;
    }
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 4000 });
    const raw = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      raw.push({ pid: Number(m[1]), commandLine: m[2] });
    }
    return classifyProfileProcesses(raw, '', { profileDir: dir }).matching;
  } catch {
    return [];
  }
}

async function tryGracefulCdpClose(profileDir, timeoutMs = 1800) {
  const port = readDevToolsPort(profileDir);
  if (!port) return false;
  try {
    const version = await httpGetJson(port, '/json/version', 800);
    const wsUrl = version && version.webSocketDebuggerUrl;
    if (!wsUrl) return false;
    await cdpSessionCall(wsUrl, (ws) => ws.cdpCall(999, 'Browser.close', {}, 1500));
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = await listProfileBrowserProcesses(profileDir);
    if (remaining.length === 0) return true;
    await sleep(150);
  }
  return false;
}

async function _closeProfileBrowserUnlocked(profileDir = getProfileDir()) {
  const dir = path.resolve(profileDir);
  try {
    let procs = await listProfileBrowserProcesses(dir);
    if (procs.length === 0) {
      removeDevToolsActivePort(dir);
      return;
    }

    if (readDevToolsPort(dir)) {
      const closedCleanly = await tryGracefulCdpClose(dir, 1800);
      if (closedCleanly) {
        removeDevToolsActivePort(dir);
        await sleep(100);
        return;
      }
      procs = await listProfileBrowserProcesses(dir);
      if (procs.length === 0) {
        removeDevToolsActivePort(dir);
        return;
      }
    }

    if (process.platform === 'win32') {
      const nonHeadlessMains = procs.filter(
        (p) => !/(?:^|\s)--type=/i.test(p.commandLine) && !/(?:^|\s)--headless(?:=|\s|$)/i.test(p.commandLine),
      );
      if (nonHeadlessMains.length > 0) {
        const mainPids = nonHeadlessMains.map((p) => p.pid).filter(Boolean);
        if (mainPids.length > 0) {
          await runHiddenPowerShell(
            `@(${mainPids.join(',')}) | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow() } }`,
            6000,
          ).catch(() => {});
          const closeDeadline = Date.now() + 1600;
          while (Date.now() < closeDeadline) {
            await sleep(200);
            procs = await listProfileBrowserProcesses(dir);
            if (procs.length === 0) break;
          }
        }
      }

      if (procs.length > 0) {
        const pids = procs.map((p) => p.pid).filter(Boolean);
        if (pids.length > 0) {
          await runHiddenPowerShell(
            `@(${pids.join(',')}) | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
            6000,
          ).catch(() => {});
          const killDeadline = Date.now() + 1500;
          while (Date.now() < killDeadline) {
            await sleep(150);
            procs = await listProfileBrowserProcesses(dir);
            if (procs.length === 0) break;
          }
        }
      }
      await sleep(150);
    } else {
      for (const p of procs) {
        try { process.kill(p.pid, 'SIGTERM'); } catch {}
      }
      const termDeadline = Date.now() + 1600;
      while (Date.now() < termDeadline) {
        await sleep(150);
        procs = await listProfileBrowserProcesses(dir);
        if (procs.length === 0) break;
      }
      for (const p of procs) {
        try { process.kill(p.pid, 'SIGKILL'); } catch {}
      }
      if (procs.length > 0) await sleep(150);
      for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.unlinkSync(path.join(dir, lockName)); } catch {}
      }
    }
  } catch {} finally {
    removeDevToolsActivePort(dir);
  }
}

async function closeProfileBrowser(profileDir = getProfileDir()) {
  const dir = path.resolve(profileDir);
  return withProfileLock(dir, () => _closeProfileBrowserUnlocked(dir));
}

function normalizeBrowserProxy(rawProxy) {
  let raw = String(rawProxy || '').trim();
  if (!raw) return '';
  if (/^(?:tg:\/\/socks|https?:\/\/t\.me\/socks)\b/i.test(raw)) {
    try {
      const tu = new URL(raw.replace(/^tg:\/\/socks/i, 'http://t.me/socks'));
      const srv = (tu.searchParams.get('server') || '').trim();
      const prt = Number(tu.searchParams.get('port'));
      if (srv && Number.isInteger(prt) && prt >= 1 && prt <= 65535) {
        raw = `socks5://${srv}:${prt}`;
      }
    } catch {}
  }
  try {
    const withScheme = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    const u = new URL(withScheme);
    const proto = u.protocol.replace(/:$/, '').toLowerCase();
    const scheme = (proto === 'socks' || proto === 'socks5h') ? 'socks5' : proto;
    if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) return '';
    return `${scheme}://${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch {
    return '';
  }
}

function launchBrowser(executable, profileDir, { url = GEMINI_URL, remoteDebugging = false, headless = false, proxy = '' } = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const proxyArg = normalizeBrowserProxy(proxy);
  if (proxyArg) {
    args.push(`--proxy-server=${proxyArg}`);
  }
  if (headless) {
    args.push('--headless=new');
  } else {
    args.push('--new-window');
  }
  if (remoteDebugging) {
    args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0');
  }
  args.push(url);

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: headless,
  });
  child.on('error', () => {});
  child.unref();
  return child;
}

async function openGeminiLoginWindow(url = GEMINI_URL, { proxy = '', waitSpawnMs = 350, _deps = null } = {}) {
  const deps = {
    findBrowserExecutable,
    getProfileDir,
    listProfileBrowserProcesses,
    closeProfileBrowser: _closeProfileBrowserUnlocked,
    launchBrowser,
    readDevToolsPort,
    removeDevToolsActivePort,
    ...(_deps || {}),
  };
  const executable = deps.findBrowserExecutable();
  if (!executable) {
    const err = new Error('Chrome, Edge, Brave или Chromium не найден в системе.');
    err.code = 'browser_not_found';
    throw err;
  }
  const profileDir = path.resolve(deps.getProfileDir());
  const proxyUsed = normalizeBrowserProxy(proxy);

  return withProfileLock(profileDir, async () => {
    const procs = await deps.listProfileBrowserProcesses(profileDir);
    const hasDevToolsPortFile = !!deps.readDevToolsPort(profileDir);
    const state = classifyProfileProcesses(procs, proxyUsed, { hasDevToolsPortFile, profileDir });
    if (state.shouldRestartForVisibleWindow) {
      await deps.closeProfileBrowser(profileDir);
    } else if (hasDevToolsPortFile) {
      deps.removeDevToolsActivePort(profileDir);
    }

    const child = deps.launchBrowser(executable, profileDir, { url, remoteDebugging: false, proxy: proxyUsed });
    if (waitSpawnMs > 0 && child && typeof child.once === 'function') {
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (typeof child.off === 'function') {
            child.off('error', onErr);
            child.off('exit', onExit);
          } else if (typeof child.removeListener === 'function') {
            child.removeListener('error', onErr);
            child.removeListener('exit', onExit);
          }
          if (err) reject(err);
          else resolve();
        };
        const onErr = (err) => {
          const e = new Error(`Не удалось запустить браузер: ${err.message || err}`);
          e.code = 'browser_launch_failed';
          done(e);
        };
        const onExit = (code) => {
          if (typeof code === 'number' && code !== 0) {
            const e = new Error(`Браузер завершился с ошибкой (код ${code}).`);
            e.code = 'browser_launch_failed';
            done(e);
          } else {
            done(null);
          }
        };
        const timer = setTimeout(() => done(null), waitSpawnMs);
        if (timer.unref) timer.unref();
        child.once('error', onErr);
        child.once('exit', onExit);
      });
    }
    return {
      ok: true,
      executable,
      profileDir,
      url,
      proxy: proxyUsed,
      restarted: state.shouldRestartForVisibleWindow,
    };
  });
}

function readDevToolsPort(profileDir) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const port = Number(String(lines[0] || '').trim());
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function httpGetJson(port, reqPath, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`CDP HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('CDP HTTP timeout')); });
  });
}

async function waitForDevTools(profileDir, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readDevToolsPort(profileDir);
    if (port) {
      try {
        const version = await httpGetJson(port, '/json/version', 1200);
        if (version && typeof version === 'object') return { port, version };
      } catch {}
    }
    await sleep(200);
  }
  return null;
}

class MinimalWebSocket {
  constructor(socket, leftover = Buffer.alloc(0)) {
    this.socket = socket;
    this.buf = leftover;
  }

  static connect(port, wsPath, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let done = false;
      let head = Buffer.alloc(0);
      const timer = setTimeout(() => {
        if (!done) { done = true; socket.destroy(); reject(new Error('WebSocket handshake timeout')); }
      }, timeoutMs);

      socket.on('error', (err) => {
        if (!done) { done = true; clearTimeout(timer); reject(err); }
      });
      socket.on('connect', () => {
        socket.write(
          `GET ${wsPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      socket.on('data', (chunk) => {
        if (done) return;
        head = Buffer.concat([head, chunk]);
        const idx = head.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const headerText = head.subarray(0, idx).toString('latin1');
        const leftover = head.subarray(idx + 4);
        const lines = headerText.split('\r\n');
        const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        const acceptLine = lines.find((l) => l.toLowerCase().startsWith('sec-websocket-accept:'));
        const accept = acceptLine ? acceptLine.split(':').slice(1).join(':').trim() : '';
        done = true;
        clearTimeout(timer);
        if (!lines[0] || !lines[0].includes(' 101 ') || accept !== expected) {
          socket.destroy();
          return reject(new Error(`Invalid WebSocket upgrade: ${lines[0] || ''}`));
        }
        resolve(new MinimalWebSocket(socket, leftover));
      });
    });
  }

  sendText(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0xfe;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  async cdpCall(id, method, params = {}, timeoutMs = 5000) {
    this.sendText(JSON.stringify({ id, method, params }));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this._readFrame(deadline - Date.now());
      const parsed = JSON.parse(msg);
      if (parsed.id === id) {
        if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
        return parsed.result || {};
      }
    }
    throw new Error(`CDP call ${method} timed out`);
  }

  _readFrame(timeoutMs) {
    return new Promise((resolve, reject) => {
      const fragments = [];
      let fragOpcode = null;
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('data', onData);
        this.socket.off('error', onErr);
      };
      const tryParse = () => {
        while (true) {
          if (this.buf.length < 2) return false;
          const b0 = this.buf[0];
          const b1 = this.buf[1];
          const fin = !!(b0 & 0x80);
          const opcode = b0 & 0x0f;
          const masked = !!(b1 & 0x80);
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) {
            if (this.buf.length < 4) return false;
            len = this.buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (this.buf.length < 10) return false;
            len = Number(this.buf.readBigUInt64BE(2));
            off = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (this.buf.length < off + maskLen + len) return false;
          const mask = masked ? this.buf.subarray(off, off + 4) : null;
          let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
          this.buf = this.buf.subarray(off + maskLen + len);
          if (mask) {
            const unmasked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i & 3];
            payload = unmasked;
          }
          if (opcode === 0x8) {
            cleanup();
            reject(new Error('CDP WebSocket closed'));
            return true;
          }
          if (opcode === 0x9) {
            const hdr = Buffer.from([0x8a, 0x80 | Math.min(125, payload.length)]);
            const m = crypto.randomBytes(4);
            this.socket.write(Buffer.concat([hdr, m]));
            continue;
          }
          if (opcode === 0x0a) continue;
          if (opcode === 0x1 || opcode === 0x2) {
            fragments.length = 0;
            fragments.push(payload);
            fragOpcode = opcode;
          } else if (opcode === 0x0 && fragOpcode !== null) {
            fragments.push(payload);
          }
          if (fin && fragOpcode !== null) {
            const data = Buffer.concat(fragments).toString('utf8');
            cleanup();
            resolve(data);
            return true;
          }
        }
      };

      const onData = (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        tryParse();
      };
      const onErr = (err) => { cleanup(); reject(err); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('CDP recv timeout')); }, Math.max(200, timeoutMs));
      if (tryParse()) return;
      this.socket.on('data', onData);
      this.socket.on('error', onErr);
    });
  }

  close() {
    try { this.socket.destroy(); } catch {}
  }
}

async function cdpSessionCall(wsUrl, fn) {
  const u = new URL(wsUrl);
  const ws = await MinimalWebSocket.connect(Number(u.port), u.pathname + u.search, 5000);
  try {
    return await fn(ws);
  } finally {
    ws.close();
  }
}

function buildGoogleCookieHeader(cookies) {
  const byName = new Map();
  const domains = new Set();
  for (const c of cookies || []) {
    if (!c || typeof c.domain !== 'string' || typeof c.name !== 'string') continue;
    const dom = c.domain.toLowerCase().replace(/^\./, '');
    if (dom !== 'google.com' && !dom.endsWith('.google.com')) continue;
    if (!COOKIE_NAME_RE.test(c.name)) continue;
    const val = String(c.value || '').replace(/[\r\n]/g, '').trim();
    if (!val) continue;
    if (c.expires && c.expires > 0 && c.expires < Date.now() / 1000) continue;
    domains.add(dom);
    const prev = byName.get(c.name);
    if (!prev || val.length >= prev.length) byName.set(c.name, val);
  }
  const pairs = [];
  for (const [k, v] of byName.entries()) pairs.push(`${k}=${v}`);
  const sapisid = byName.get('SAPISID') || '';
  const hasSapisid = !!sapisid && SAPISID_RE.test(sapisid);
  const has1Psid = byName.has('__Secure-1PSID');
  return {
    cookie: pairs.join('; '),
    count: pairs.length,
    hasSapisid,
    has1Psid,
    domains: [...domains],
  };
}

async function importGeminiCookiesViaCdp({ timeoutMs = 12000, extractAtToken = true, proxy = '' } = {}) {
  const executable = findBrowserExecutable();
  if (!executable) {
    const err = new Error('Chrome, Edge, Brave или Chromium не найден в системе.');
    err.code = 'browser_not_found';
    throw err;
  }
  const profileDir = path.resolve(getProfileDir());
  if (!fs.existsSync(profileDir)) {
    const err = new Error('Выделенный профиль Gemini ещё не создан. Сначала откройте окно входа Gemini и авторизуйтесь.');
    err.code = 'profile_missing';
    throw err;
  }
  const proxyUsed = normalizeBrowserProxy(proxy);

  return withProfileLock(profileDir, async () => {
    let endpoint = null;
    try {
      const existingPort = readDevToolsPort(profileDir);
      if (existingPort) {
        const procs = await listProfileBrowserProcesses(profileDir);
        const state = classifyProfileProcesses(procs, proxyUsed, { hasDevToolsPortFile: true, profileDir });
        if (!state.proxyMismatch) {
          try {
            const version = await httpGetJson(existingPort, '/json/version', 900);
            if (version && typeof version === 'object') endpoint = { port: existingPort, version };
          } catch {}
        }
      }

      if (!endpoint) {
        await _closeProfileBrowserUnlocked(profileDir);
        await sleep(250);
        launchBrowser(executable, profileDir, { url: GEMINI_URL, remoteDebugging: true, headless: true, proxy: proxyUsed });
        endpoint = await waitForDevTools(profileDir, timeoutMs);
      }
      if (!endpoint) {
        const err = new Error('Не удалось подключиться к окну Gemini через DevTools. Закройте окно профиля и повторите попытку.');
        err.code = 'cdp_connect_failed';
        throw err;
      }

      const wsUrl = endpoint.version.webSocketDebuggerUrl;
      if (!wsUrl) {
        throw new Error('DevTools не вернул webSocketDebuggerUrl.');
      }

      const cookieRes = await cdpSessionCall(wsUrl, async (ws) => {
        try {
          return await ws.cdpCall(1, 'Storage.getCookies', {});
        } catch {
          return await ws.cdpCall(2, 'Network.getAllCookies', {});
        }
      });

      const built = buildGoogleCookieHeader(cookieRes.cookies || []);
      let atToken = '';
      if (extractAtToken) {
        try {
          const targets = await httpGetJson(endpoint.port, '/json/list', 2000);
          const geminiTarget = Array.isArray(targets)
            ? targets.find((t) => t.type === 'page' && /gemini\.google\.com/i.test(t.url || '') && t.webSocketDebuggerUrl)
            : null;
          if (geminiTarget) {
            const evalRes = await cdpSessionCall(geminiTarget.webSocketDebuggerUrl, (ws) =>
              ws.cdpCall(3, 'Runtime.evaluate', { expression: '(window.WIZ_global_data && window.WIZ_global_data.SNlM0e) || ""', returnByValue: true })
            );
            atToken = String(evalRes?.result?.value || '').trim();
          }
        } catch {}
      }

      return {
        ok: built.hasSapisid || built.has1Psid,
        ...built,
        atToken,
      };
    } finally {
      // Never leave a headless DevTools browser holding the profile lock after cookie import,
      // otherwise subsequent openGeminiLoginWindow() calls silently open inside headless mode.
      await _closeProfileBrowserUnlocked(profileDir).catch(() => {});
    }
  });
}

module.exports = {
  GEMINI_URL,
  getProfileDir,
  findBrowserExecutable,
  normalizeBrowserProxy,
  parseUserDataDirFromCommandLine,
  parseProxyFromCommandLine,
  classifyProfileProcesses,
  listProfileBrowserProcesses,
  closeProfileBrowser,
  openGeminiLoginWindow,
  buildGoogleCookieHeader,
  importGeminiCookiesViaCdp,
};

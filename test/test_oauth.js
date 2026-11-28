'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { buildOpenExternalCommand, startInteractiveOAuth, getOAuthStatus } = require('../lib/auth');
const {
  normalizeBrowserProxy,
  parseUserDataDirFromCommandLine,
  parseProxyFromCommandLine,
  classifyProfileProcesses,
  openGeminiLoginWindow,
} = require('../lib/cdp_cookies');
const { detectAutoPaths } = require('../lib/installs');

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  console.log('  ok ', name);
  passed++;
}

async function main() {
  console.log('== test_oauth');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-oauth-test-'));
  const authFile = path.join(tmpDir, 'auth.json');

  try {
    const sampleUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123&redirect_uri=http%3A%2F%2F127.0.0.1%3A9999%2Foauth-callback&response_type=code&prompt=select_account+consent';
    const winCmd = buildOpenExternalCommand(sampleUrl, 'win32', { preferDirectBrowser: false });
    ok(winCmd.file === 'powershell.exe', 'win32 fallback external opener uses powershell.exe instead of cmd.exe');
    const encIdx = winCmd.args.indexOf('-EncodedCommand');
    ok(encIdx >= 0 && typeof winCmd.args[encIdx + 1] === 'string', 'win32 command encodes Start-Process via -EncodedCommand');
    const decoded = Buffer.from(winCmd.args[encIdx + 1], 'base64').toString('utf16le');
    ok(decoded.includes('&response_type=code') && decoded.includes('&prompt=select_account+consent'), 'win32 decoded command preserves all query params across & without cmd splitting');

    if (process.platform === 'win32') {
      const directCmd = buildOpenExternalCommand(sampleUrl, 'win32', { preferDirectBrowser: true });
      ok(directCmd.args.includes(sampleUrl), 'win32 direct default browser command receives unsplit full OAuth URL');
    }

    assert.throws(() => buildOpenExternalCommand('javascript:alert(1)', 'win32'), /http\/https/);

    ok(normalizeBrowserProxy('http://127.0.0.1:10808') === 'http://127.0.0.1:10808', 'normalizeBrowserProxy preserves http proxy');
    ok(normalizeBrowserProxy('socks5h://user:pass@127.0.0.1:1080') === 'socks5://127.0.0.1:1080', 'normalizeBrowserProxy converts socks5h to socks5 without credentials');
    ok(normalizeBrowserProxy('127.0.0.1:8080') === 'http://127.0.0.1:8080', 'normalizeBrowserProxy adds http scheme to bare host:port');

    // Installs: Antigravity vs Antigravity IDE must stay strictly independent
    const fakeLocal = path.join(tmpDir, 'Local');
    const fakeHome = path.join(tmpDir, 'Home');
    fs.mkdirSync(path.join(fakeLocal, 'Programs', 'antigravity'), { recursive: true });
    fs.writeFileSync(path.join(fakeLocal, 'Programs', 'antigravity', 'Antigravity.exe'), 'exe');
    fs.mkdirSync(path.join(fakeLocal, 'Programs', 'Microsoft VS Code'), { recursive: true });
    fs.writeFileSync(path.join(fakeLocal, 'Programs', 'Microsoft VS Code', 'Code.exe'), 'exe');
    const det = detectAutoPaths({ platform: 'win32', env: { LOCALAPPDATA: fakeLocal, PATH: '' }, home: fakeHome, force: true });
    ok(!!det.app && !det.ide, 'Antigravity IDE is not conflated with Antigravity.exe');
    ok(!det.vscode, 'VS Code without Antigravity extension does not falsely appear as Antigravity for VS Code');

    const started = await startInteractiveOAuth({ authFile, openBrowser: false });
    ok(started.ok && started.status === 'pending', 'startInteractiveOAuth returns pending status');
    const parsed = new URL(started.authUrl);
    ok(parsed.searchParams.get('response_type') === 'code', 'authUrl contains response_type=code');
    ok(parsed.searchParams.get('prompt') === 'select_account consent', 'authUrl forces Google account selector + consent');
    ok(parsed.searchParams.get('code_challenge_method') === 'S256', 'authUrl uses PKCE S256');
    const cbUrl = new URL(parsed.searchParams.get('redirect_uri'));

    const denyRes = await new Promise((resolve, reject) => {
      http.get(`${cbUrl.origin}${cbUrl.pathname}?error=access_denied`, (res) => {
        let html = '';
        res.on('data', (c) => { html += c; });
        res.on('end', () => resolve({ status: res.statusCode, html }));
      }).on('error', reject);
    });
    ok(denyRes.status === 200 && denyRes.html.includes('access_denied') && denyRes.html.includes('Вход отменён'), 'OAuth callback reports error cleanly in Russian by default');
    const st = getOAuthStatus();
    ok(st.status === 'error' && st.error.includes('access_denied'), 'getOAuthStatus reflects error state cleanly');

    const startedEn = await startInteractiveOAuth({ authFile, openBrowser: false, lang: 'en', theme: 'light' });
    const cbUrlEn = new URL(new URL(startedEn.authUrl).searchParams.get('redirect_uri'));
    const denyResEn = await new Promise((resolve, reject) => {
      http.get(`${cbUrlEn.origin}${cbUrlEn.pathname}?error=access_denied`, (res) => {
        let html = '';
        res.on('data', (c) => { html += c; });
        res.on('end', () => resolve({ status: res.statusCode, html }));
      }).on('error', reject);
    });
    ok(
      denyResEn.status === 200
      && denyResEn.html.includes('lang="en"')
      && denyResEn.html.includes('Sign-in Cancelled')
      && !denyResEn.html.includes('Вход отменён'),
      'OAuth callback renders localized English HTML when lang=en'
    );

    // cdp_cookies: headless / remote-debugging / proxy mismatch process detection & restart guard
    const fakeProfile = path.join(tmpDir, 'GeminiBrowser');
    const otherProfile = path.join(tmpDir, 'OtherBrowser');
    ok(
      parseUserDataDirFromCommandLine(`"brave.exe" --user-data-dir="${fakeProfile}" --headless=new`) === fakeProfile,
      'parseUserDataDirFromCommandLine extracts quoted profile path'
    );
    ok(
      parseProxyFromCommandLine(`"brave.exe" --proxy-server=socks5://127.0.0.1:18480`) === 'socks5://127.0.0.1:18480',
      'parseProxyFromCommandLine normalizes proxy flag'
    );

    const headlessState = classifyProfileProcesses([
      { pid: 101, commandLine: `brave.exe --user-data-dir=${fakeProfile} --proxy-server=socks5://127.0.0.1:18480 --headless=new --remote-debugging-port=0 https://gemini.google.com/app` },
      { pid: 102, commandLine: `brave.exe --user-data-dir="${otherProfile}" --new-window` },
    ], 'socks5://127.0.0.1:18480', { profileDir: fakeProfile });
    ok(headlessState.matching.length === 1 && headlessState.hasHeadless && headlessState.shouldRestartForVisibleWindow, 'headless GeminiBrowser process triggers clean restart before opening visible window');

    const mismatchState = classifyProfileProcesses([
      { pid: 103, commandLine: `brave.exe --user-data-dir="${fakeProfile}" --new-window` },
    ], 'socks5://127.0.0.1:18480', { profileDir: fakeProfile });
    ok(mismatchState.proxyMismatch && mismatchState.shouldRestartForVisibleWindow, 'proxy change triggers restart of existing GeminiBrowser window');

    const okVisibleState = classifyProfileProcesses([
      { pid: 104, commandLine: `brave.exe --user-data-dir="${fakeProfile}" --proxy-server=socks5://127.0.0.1:18480 --new-window` },
    ], 'socks5://127.0.0.1:18480', { profileDir: fakeProfile });
    ok(!okVisibleState.shouldRestartForVisibleWindow, 'visible GeminiBrowser window with matching proxy is preserved');

    let closedCalled = 0;
    let launchedArgs = null;
    const reopened = await openGeminiLoginWindow('https://gemini.google.com/app', {
      proxy: 'socks5://127.0.0.1:18480',
      waitSpawnMs: 30,
      _deps: {
        findBrowserExecutable: () => 'C:\\Fake\\brave.exe',
        getProfileDir: () => fakeProfile,
        readDevToolsPort: () => null,
        removeDevToolsActivePort: () => {},
        listProfileBrowserProcesses: async () => [
          { pid: 201, commandLine: `brave.exe --user-data-dir="${fakeProfile}" --headless=new` },
        ],
        closeProfileBrowser: async () => { closedCalled++; },
        launchBrowser: (exe, dir, opts) => {
          launchedArgs = { exe, dir, opts };
          return new EventEmitter();
        },
      },
    });
    ok(closedCalled === 1 && reopened.restarted === true && launchedArgs && launchedArgs.opts.proxy === 'socks5://127.0.0.1:18480', 'openGeminiLoginWindow closes stale headless instance before opening visible window');

    let spawnFailErr = null;
    try {
      await openGeminiLoginWindow('https://gemini.google.com/app', {
        waitSpawnMs: 200,
        _deps: {
          findBrowserExecutable: () => 'C:\\Fake\\brave.exe',
          getProfileDir: () => path.join(tmpDir, 'MissingLock'),
          readDevToolsPort: () => null,
          removeDevToolsActivePort: () => {},
          listProfileBrowserProcesses: async () => [],
          closeProfileBrowser: async () => {},
          launchBrowser: () => {
            const ee = new EventEmitter();
            process.nextTick(() => ee.emit('exit', 1));
            return ee;
          },
        },
      });
    } catch (e) {
      spawnFailErr = e;
    }
    ok(spawnFailErr && spawnFailErr.code === 'browser_launch_failed', 'openGeminiLoginWindow surfaces immediate non-zero browser launch failure');

    console.log(`\nALL PASSED (${passed} checks)`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

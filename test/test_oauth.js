'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { buildOpenExternalCommand, startInteractiveOAuth, getOAuthStatus } = require('../lib/auth');

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
    const winCmd = buildOpenExternalCommand(sampleUrl, 'win32');
    ok(winCmd.file === 'powershell.exe', 'win32 external opener uses powershell.exe instead of cmd.exe');
    const encIdx = winCmd.args.indexOf('-EncodedCommand');
    ok(encIdx >= 0 && typeof winCmd.args[encIdx + 1] === 'string', 'win32 command encodes Start-Process via -EncodedCommand');
    const decoded = Buffer.from(winCmd.args[encIdx + 1], 'base64').toString('utf16le');
    ok(decoded.includes('&response_type=code') && decoded.includes('&prompt=select_account+consent'), 'win32 decoded command preserves all query params across & without cmd splitting');

    assert.throws(() => buildOpenExternalCommand('javascript:alert(1)', 'win32'), /http\/https/);

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
    ok(denyRes.status === 200 && denyRes.html.includes('access_denied'), 'OAuth callback reports error cleanly');
    const st = getOAuthStatus();
    ok(st.status === 'error' && st.error.includes('access_denied'), 'getOAuthStatus reflects error state cleanly');

    console.log(`\nALL PASSED (${passed} checks)`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

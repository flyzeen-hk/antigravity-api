'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isSystemPath, isProtectedDataPath, createExecutor } = require('../lib/agent');
const { Guard } = require('../lib/guard');
const { DEFAULTS } = require('../lib/config/defaults');
const { ModelCatalog } = require('../lib/models');
const { geminiToAnthropicResponse } = require('../lib/anthropic');
const { GeminiWebBridge } = require('../lib/web_bridge');

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  console.log('  ok ', name);
  passed++;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sec-fixes-'));
  try {
    console.log('== 1. Agent system & data protection');
    ok(isSystemPath('/etc/passwd') === true, 'POSIX /etc/passwd blocked');
    ok(isSystemPath('/usr/bin/node') === true, 'POSIX /usr/bin blocked');
    ok(isSystemPath('/root/.bashrc') === true, 'POSIX /root blocked');
    ok(isSystemPath('\\\\?\\C:\\Windows\\System32') === true, 'Windows \\\\?\\ prefix normalized & blocked');
    ok(isSystemPath('C:\\Program Files') === true, 'bare C:\\Program Files blocked');

    const dataDir = path.join(tmp, 'data');
    const ws = path.join(dataDir, 'agent_workspace');
    fs.mkdirSync(ws, { recursive: true });
    ok(isProtectedDataPath(path.join(dataDir, 'auth.json'), dataDir) === true, 'auth.json protected');
    ok(isProtectedDataPath(path.join(dataDir, 'config.json'), dataDir) === true, 'config.json protected');
    ok(isProtectedDataPath(path.join(dataDir, '_backups', 'b1'), dataDir) === true, '_backups protected');
    ok(isProtectedDataPath(path.join(ws, 'notes.txt'), dataDir) === false, 'workspace file allowed');

    const ex = createExecutor({ workspaceRoot: ws, allowAbsolutePaths: true, allowDelete: true, dataDir }, tmp);
    const rSecret = await ex.execute('write_file', { path: path.join(dataDir, 'auth.json'), content: '{}' });
    ok(rSecret.ok === false && /защищ/i.test(rSecret.error), 'agent cannot overwrite DATA_DIR auth.json');
    const sysTarget = process.platform === 'win32' ? '\\\\?\\C:\\Windows\\win.ini' : '/etc/passwd';
    const rSys = await ex.execute('read_file', { path: sysTarget });
    ok(rSys.ok === false && /(системн|защищ)/i.test(rSys.error), `agent blocks system read target (${sysTarget})`);

    console.log('== 2. Guard history & defaults');
    const gDirect = new Guard({}, path.join(tmp, 'u1.json'));
    ok(gDirect.cfg.enabled === true, 'direct new Guard({}, ...) stays enabled for existing API callers');
    const gCfg = new Guard(DEFAULTS.safeMode, path.join(tmp, 'u2.json'));
    ok(gCfg.cfg.enabled === false, 'DEFAULTS.safeMode disables guard by default');
    const hist = gDirect.history(14);
    ok(Array.isArray(hist) && hist.length === 14 && typeof hist[0].date === 'string', 'guard.history(14) returns 14 entries');

    console.log('== 3. ModelCatalog quota families without resetTime');
    const catalog = new ModelCatalog('http://127.0.0.1:1', { project: 'p', userAgent: 'ua' });
    catalog.cache = {
      at: Date.now(),
      models: new Map([
        ['claude-sonnet-4-6', { displayName: 'Claude', quota: { percent: 80, remainingFraction: 0.8, resetTime: null } }],
        ['gpt-oss-120b', { displayName: 'GPT', quota: { percent: 55, remainingFraction: 0.55, resetTime: null } }],
      ]),
    };
    const qf = catalog.getQuotaSummary();
    ok(qf.claude.percent === 80 && qf.claude.remainingFraction === 0.8, 'claude remainingFraction populated');
    ok(qf.gpt.percent === 55 && qf.gpt.remainingFraction === 0.55, 'gpt remainingFraction populated');

    console.log('== 4. Anthropic includeThoughts opt-out');
    const sampleResp = {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'secret chain' },
            { text: 'final answer' },
          ],
        },
        finishReason: 'STOP',
      }],
    };
    const aWith = geminiToAnthropicResponse(sampleResp, 'claude-sonnet-4-6', { includeThoughts: true });
    ok(aWith.content.some((b) => b.type === 'thinking'), 'thinking emitted when includeThoughts=true');
    const aWithout = geminiToAnthropicResponse(sampleResp, 'claude-sonnet-4-6', { includeThoughts: false });
    ok(!aWithout.content.some((b) => b.type === 'thinking'), 'thinking omitted when includeThoughts=false');

    console.log('== 5. GeminiWebBridge historyMaxChars, selectAccount reset & parseToolCalls guard');
    const cf = path.join(tmp, 'c.txt');
    fs.writeFileSync(cf, 'SAPISID=file_sap; __Secure-1PSID=file_psid\n');
    const wb = new GeminiWebBridge({
      enabled: true,
      historyMaxChars: 5000,
      cookie_file: cf,
      accounts: [
        { name: 'a1', cookie: 'SAPISID=111', label: 'First', thinkMode: 'extended', temporaryChats: true },
        { name: 'a2', cookie: 'SAPISID=222' },
      ],
      activeAccount: 'a1',
    }, tmp);
    ok(wb.historyMaxChars === 5000, 'historyMaxChars respected');
    const switched = wb.selectAccount('a2');
    ok(switched && switched.name === 'a2', 'switched to a2');
    ok(wb.accountLabel === '' && wb.thinkMode === null && wb.temporaryChats === false, 'selectAccount resets optional fields cleanly');
    const longMsgs = [
      { role: 'user', content: 'A'.repeat(4000) },
      { role: 'assistant', content: 'B'.repeat(4000) },
      { role: 'user', content: 'LATEST_QUESTION' },
    ];
    const truncatedPrompt = wb.messagesToPrompt(longMsgs);
    ok(truncatedPrompt.includes('LATEST_QUESTION') && truncatedPrompt.length <= 5200, 'historyMaxChars keeps latest user turn within cap');
    const brokenTc = wb.parseToolCalls('hello ```tool_call\n{"arguments":{"x":1}}\n``` world');
    ok(Array.isArray(brokenTc.toolCalls) && brokenTc.toolCalls.length === 0, 'parseToolCalls skips malformed block without name');

    wb.closeAllSockets();
    ok(wb._agentCache === null, 'closeAllSockets clears agent cache');

    console.log(`passed: ${passed}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

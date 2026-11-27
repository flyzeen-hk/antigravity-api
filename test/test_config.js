'use strict';

const assert = require('assert');
const configLib = require('../lib/config');

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  console.log('  ok ', name);
  passed++;
}

console.log('== test_config');

ok(configLib.CONFIG_VERSION === 2, 'CONFIG_VERSION === 2');
ok(configLib.DEFAULTS.theme === 'dark', 'default theme is dark');
ok(configLib.DEFAULTS.language === 'ru', 'default language is ru');
ok(configLib.DEFAULTS.autoStartServer === false, 'default autoStartServer is false');
ok(configLib.DEFAULTS.geminiWeb.cookie_file === '', 'default cookie_file empty string');

const norm = configLib.normalize({
  port: 99999,
  theme: 'invalid',
  language: 'fr',
  geminiWeb: { cookieFile: 'my_cookie.txt', accounts: [{ name: 'a1', cookieFile: 'acc1.txt', thinkMode: 'extended', temporaryChats: true }] },
});
ok(norm.config.port === 65535, 'port clamped to 65535');
ok(norm.config.theme === 'dark', 'invalid theme falls back to dark');
ok(norm.config.language === 'ru', 'invalid language falls back to ru');
ok(norm.config.geminiWeb.cookie_file === 'my_cookie.txt', 'cookieFile alias normalized to cookie_file');
ok(norm.config.geminiWeb.cookieFile === undefined, 'cookieFile alias stripped after normalization');
ok(norm.config.geminiWeb.accounts[0].cookie_file === 'acc1.txt', 'account cookieFile normalized');
ok(norm.warnings.length >= 1, 'clamped port recorded in warnings');

const base = configLib.normalize({
  apiKey: 'secret-api',
  adminKey: 'secret-admin',
  agent: { enabled: true, allowDelete: false, allowShell: false, allowAbsolutePaths: false, auditFile: 'audit.jsonl' },
}).config;

const patched = configLib.patchConfig(base, {
  port: 8400,
  host: '0.0.0.0',
  theme: 'light',
  language: 'en',
  autoStartServer: true,
  outputHeadroomTokens: 512,
  apiKey: 'hacked',
  adminKey: 'hacked2',
  upstreamHost: 'https://evil.invalid',
  agent: { enabled: false, allowDelete: true, allowShell: true, allowAbsolutePaths: true, auditFile: '/tmp/evil' },
  unknownField: 123,
});

ok(patched.config.port === 8400, 'patchConfig applies port');
ok(patched.config.host === '0.0.0.0', 'patchConfig applies host');
ok(patched.config.theme === 'light', 'patchConfig applies theme');
ok(patched.config.language === 'en', 'patchConfig applies language');
ok(patched.config.autoStartServer === true, 'patchConfig applies autoStartServer');
ok(patched.config.outputHeadroomTokens === 512, 'patchConfig applies outputHeadroomTokens');
ok(patched.config.agent.enabled === false, 'patchConfig applies agent.enabled');
ok(patched.config.apiKey === 'secret-api', 'apiKey cannot be overwritten via patchConfig');
ok(patched.config.adminKey === 'secret-admin', 'adminKey cannot be overwritten via patchConfig');
ok(patched.config.agent.allowDelete === false, 'agent.allowDelete stays false');
ok(patched.config.agent.allowShell === false, 'agent.allowShell stays false');
ok(patched.config.agent.allowAbsolutePaths === false, 'agent.allowAbsolutePaths stays false');
ok(patched.config.agent.auditFile === 'audit.jsonl', 'agent.auditFile cannot be overwritten');
ok(patched.ignored.includes('apiKey'), 'apiKey reported in ignored');
ok(patched.ignored.includes('agent.allowDelete'), 'agent.allowDelete reported in ignored');
ok(patched.ignored.includes('unknownField'), 'unknownField reported in ignored');

console.log(`passed: ${passed}`);

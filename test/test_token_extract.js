'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tokenExtract = require('../lib/token_extract');

let passed = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  console.log('  ok ', name);
  passed++;
}

function encodeVarint(n) {
  const bytes = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function ldField(fieldNo, buf) {
  const tag = encodeVarint((fieldNo << 3) | 2);
  const len = encodeVarint(buf.length);
  return Buffer.concat([tag, len, buf]);
}

console.log('== test_token_extract');

const innerTok = Buffer.concat([
  ldField(1, Buffer.from('ya29.test_access', 'utf8')),
  ldField(2, Buffer.from('Bearer', 'utf8')),
  ldField(3, Buffer.from('1//test_refresh_token', 'utf8')),
]);
const innerB64 = Buffer.from(innerTok.toString('base64'), 'utf8');
const valWrapper = ldField(1, innerB64);
const entry = Buffer.concat([
  ldField(1, Buffer.from(tokenExtract.SENTINEL_KEY, 'utf8')),
  ldField(2, valWrapper),
]);
const outerB64 = ldField(1, entry).toString('base64');

const decoded = tokenExtract.decodeOAuthProtobuf(outerB64);
ok(decoded.type === 'antigravity', 'decoded type === antigravity');
ok(decoded.token_type === 'Bearer', 'decoded token_type === Bearer');
ok(decoded.access_token === 'ya29.test_access', 'decoded access_token matches');
ok(decoded.refresh_token === '1//test_refresh_token', 'decoded refresh_token matches');

assert.throws(() => tokenExtract.decodeOAuthProtobuf(''), /Пустое|base64/i, 'empty input rejected');

const candidates = tokenExtract.getCandidateDbPaths({ env: { ANTIGRAVITY_STATE_DB: '/nonexistent/db.vscdb' }, platform: 'linux', home: '/tmp' });
ok(Array.isArray(candidates) && candidates[0] === '/nonexistent/db.vscdb', 'ANTIGRAVITY_STATE_DB override checked first');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tok-'));
try {
  const missingDb = path.join(tmp, 'missing.vscdb');
  assert.throws(() => tokenExtract.extractTokenFromDb(missingDb), /не найден|not found|ENOENT/i, 'missing DB throws clear error');
  const outFile = path.join(tmp, 'auth.json');
  tokenExtract.saveAuth(decoded, outFile);
  const saved = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  ok(saved.refresh_token === '1//test_refresh_token', 'saveAuth writes auth.json atomically');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`passed: ${passed}`);

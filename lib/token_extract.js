'use strict';

/**
 * Pure Node.js Antigravity IDE OAuth token extractor.
 *
 * Reads `antigravityUnifiedStateSync.oauthToken` from Antigravity IDE's SQLite
 * database (`state.vscdb`), decodes the nested Protobuf payload, and writes
 * `auth.json` atomically with safe file permissions.
 *
 * Copies `state.vscdb` (+ `-wal` / `-shm`) into a temporary directory first so
 * an open Antigravity IDE holding a WAL lock never triggers SQLITE_BUSY.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { backupFile, readJsonFile, removeTree, writeFileAtomic } = require('./safe_files');
const { resolveDataDir } = require('./data_dir');

const OAUTH_KEY = 'antigravityUnifiedStateSync.oauthToken';
const SENTINEL_KEY = 'oauthTokenInfoSentinelKey';

function getCandidateDbPaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = [];
  if (env.ANTIGRAVITY_STATE_DB) paths.push(env.ANTIGRAVITY_STATE_DB);

  const appNames = ['Antigravity', 'antigravity', 'Antigravity IDE'];
  if (platform === 'win32') {
    const bases = new Set();
    if (env.APPDATA) bases.add(env.APPDATA);
    if (env.USERPROFILE) bases.add(path.join(env.USERPROFILE, 'AppData', 'Roaming'));
    if (home) bases.add(path.join(home, 'AppData', 'Roaming'));
    for (const base of bases) {
      for (const name of appNames) {
        paths.push(path.join(base, name, 'User', 'globalStorage', 'state.vscdb'));
      }
    }
  } else if (platform === 'darwin') {
    for (const name of appNames) {
      paths.push(path.join(home, 'Library', 'Application Support', name, 'User', 'globalStorage', 'state.vscdb'));
    }
  } else {
    const cfg = env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const name of appNames) {
      paths.push(path.join(cfg, name, 'User', 'globalStorage', 'state.vscdb'));
    }
  }
  return [...new Set(paths.filter(Boolean))];
}

function findAntigravityDb(opts) {
  for (const p of getCandidateDbPaths(opts)) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (true) {
    if (i >= buf.length) throw new Error('Unexpected EOF reading protobuf varint');
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      const num = result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
      return { value: num, next: i };
    }
    shift += 7n;
    if (shift > 70n) throw new Error('Protobuf varint overflow');
  }
}

function iterFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tagRes = readVarint(buf, i);
    const tag = Number(tagRes.value);
    i = tagRes.next;
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const valRes = readVarint(buf, i);
      i = valRes.next;
      out.push({ field, wireType, data: valRes.value });
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, i);
      const len = Number(lenRes.value);
      i = lenRes.next;
      if (len < 0 || i + len > buf.length) throw new Error('Truncated protobuf length-delimited field');
      out.push({ field, wireType, data: buf.subarray(i, i + len) });
      i += len;
    } else if (wireType === 5) {
      if (i + 4 > buf.length) throw new Error('Truncated protobuf fixed32');
      out.push({ field, wireType, data: buf.subarray(i, i + 4) });
      i += 4;
    } else if (wireType === 1) {
      if (i + 8 > buf.length) throw new Error('Truncated protobuf fixed64');
      out.push({ field, wireType, data: buf.subarray(i, i + 8) });
      i += 8;
    } else {
      throw new Error(`Unsupported protobuf wiretype ${wireType}`);
    }
  }
  return out;
}

function decodeOAuthProtobuf(rawValue) {
  let outer;
  try {
    outer = Buffer.from(String(rawValue).trim(), 'base64');
  } catch (e) {
    throw new Error(`Не удалось декодировать Base64 oauthToken: ${e.message}`);
  }
  if (!outer.length) {
    throw new Error('Пустое значение oauthToken в базе данных IDE.');
  }

  let access = '';
  let refresh = '';
  let tokenType = '';

  for (const { wireType, data: entry } of iterFields(outer)) {
    if (wireType !== 2) continue;
    let key = '';
    let sentinelVal = null;
    for (const { field: f2, data: v2 } of iterFields(entry)) {
      if (f2 === 1 && Buffer.isBuffer(v2)) {
        key = v2.toString('utf8');
      } else if (f2 === 2 && Buffer.isBuffer(v2)) {
        for (const { field: f3, data: v3 } of iterFields(v2)) {
          if (f3 === 1 && Buffer.isBuffer(v3)) sentinelVal = v3;
        }
      }
    }
    if (key === SENTINEL_KEY && sentinelVal) {
      const tokBuf = Buffer.from(sentinelVal.toString('utf8').trim(), 'base64');
      for (const { field: f, wireType: wt, data } of iterFields(tokBuf)) {
        if (wt !== 2 || !Buffer.isBuffer(data)) continue;
        if (f === 1) access = data.toString('utf8');
        else if (f === 2) tokenType = data.toString('utf8');
        else if (f === 3) refresh = data.toString('utf8');
      }
    }
  }

  if (!refresh) {
    throw new Error('refresh_token не найден в профиле Antigravity. Войдите в аккаунт Google внутри Antigravity и повторите попытку.');
  }
  return {
    type: 'antigravity',
    token_type: tokenType || 'Bearer',
    refresh_token: refresh,
    access_token: access || '',
    access_expires_at: 0,
    project_id: '',
  };
}

function copyDbToTemp(dbPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag_vscdb_'));
  const copyPath = path.join(tmpDir, 'state.vscdb');
  fs.copyFileSync(dbPath, copyPath);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) {
      try { fs.copyFileSync(sidecar, copyPath + suffix); } catch {}
    }
  }
  return { tmpDir, copyPath };
}

function readOAuthRowFromSqlite(dbFile) {
  try {
    const sqlite = require('node:sqlite');
    if (sqlite && typeof sqlite.DatabaseSync === 'function') {
      const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
      try {
        const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
        const row = stmt.get(OAUTH_KEY);
        return row ? row.value : null;
      } finally {
        db.close();
      }
    }
  } catch (e) {
    if (e && e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && !/Cannot find module 'node:sqlite'/i.test(String(e.message))) {
      throw e;
    }
  }

  try {
    const out = execFileSync(
      'sqlite3',
      [dbFile, `SELECT value FROM ItemTable WHERE key='${OAUTH_KEY}';`],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const val = out.trim();
    return val || null;
  } catch {
    const err = new Error('Для чтения SQLite-базы Antigravity требуется Node.js 22.5+ (встроенный node:sqlite) или утилита sqlite3.');
    err.code = 'sqlite_unavailable';
    throw err;
  }
}

function extractTokenFromDb(dbPath = null) {
  const resolvedPath = dbPath || findAntigravityDb();
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    const err = new Error('База данных Antigravity (state.vscdb) не найдена. Убедитесь, что Antigravity установлена и вы вошли в аккаунт.');
    err.code = 'ide_db_not_found';
    throw err;
  }

  const { tmpDir, copyPath } = copyDbToTemp(resolvedPath);
  let rawValue = null;
  try {
    rawValue = readOAuthRowFromSqlite(copyPath);
  } catch (e) {
    if (e.code === 'sqlite_unavailable') throw e;
    const err = new Error(`Ошибка чтения SQLite базы ${resolvedPath}: ${e.message}`);
    err.code = 'sqlite_read_failed';
    throw err;
  } finally {
    try { removeTree(tmpDir); } catch {}
  }

  if (!rawValue) {
    const err = new Error('Токен не найден в базе данных Antigravity. Откройте Antigravity и войдите в Google аккаунт.');
    err.code = 'ide_token_not_found';
    throw err;
  }

  const decoded = decodeOAuthProtobuf(rawValue);
  return {
    ...decoded,
    extracted_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    db_source: resolvedPath,
  };
}

function saveAuth(tokenData, outPath) {
  const target = outPath || process.env.AG_AUTH_FILE || path.join(resolveDataDir(), 'auth.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    try { backupFile(target); } catch {}
  }
  writeFileAtomic(target, JSON.stringify(tokenData, null, 2) + '\n');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(target, 0o600); } catch {}
  }
  return target;
}

function autoExtract({ force = false, outPath = null, dbPath = null } = {}) {
  const target = outPath || process.env.AG_AUTH_FILE || path.join(resolveDataDir(), 'auth.json');
  if (!force && fs.existsSync(target)) {
    try {
      const existing = readJsonFile(target);
      if (existing && existing.refresh_token) {
        return { ok: true, path: target, cached: true, data: existing };
      }
    } catch {}
  }
  const tokenData = extractTokenFromDb(dbPath);
  saveAuth(tokenData, target);
  return { ok: true, path: target, cached: false, data: tokenData };
}

function main(argv = process.argv.slice(2)) {
  let outPath = null;
  let dbPath = null;
  let force = true;
  let jsonOut = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' && argv[i + 1]) outPath = path.resolve(argv[++i]);
    else if (a === '--db' && argv[i + 1]) dbPath = path.resolve(argv[++i]);
    else if (a === '--no-force') force = false;
    else if (a === '--force') force = true;
    else if (a === '--json') jsonOut = true;
  }

  try {
    const res = autoExtract({ force, outPath, dbPath });
    if (jsonOut) {
      console.log(JSON.stringify({
        ok: true,
        path: res.path,
        cached: res.cached,
        db_source: res.data.db_source || '',
        hasAccessToken: !!res.data.access_token,
        hasRefreshToken: !!res.data.refresh_token,
      }, null, 2));
      return;
    }
    const d = res.data;
    console.log(`✓ Токен сохранён в: ${res.path}`);
    if (d.db_source) console.log(`  Источник: ${d.db_source}`);
    console.log(`  access_token:  ${d.access_token ? d.access_token.slice(0, 10) + '...' : '(пусто, обновится автоматически)'}`);
    console.log(`  refresh_token: ${d.refresh_token.slice(0, 8)}... (len=${d.refresh_token.length})`);
  } catch (e) {
    if (jsonOut) {
      console.log(JSON.stringify({ ok: false, code: e.code || 'extract_failed', error: e.message }));
    } else {
      console.error(`✗ Ошибка извлечения токена: ${e.message}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  OAUTH_KEY,
  SENTINEL_KEY,
  getCandidateDbPaths,
  findAntigravityDb,
  readVarint,
  iterFields,
  decodeOAuthProtobuf,
  extractTokenFromDb,
  saveAuth,
  autoExtract,
};

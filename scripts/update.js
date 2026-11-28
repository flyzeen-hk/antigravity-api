'use strict';

/**
 * Backup-first updater & rollback manager (pure Node.js).
 *
 * Every update or manual backup snapshots:
 * - Full git repository bundle (if `.git` exists)
 * - Live state files (`config.json`, `auth.json`, `apikey.txt`, `admin.key`,
 *   `usage.json`, `install_paths.json`, `ui_language.txt`, `cookie.txt`, `backups/`)
 * - `manifest.json` with timestamps, version, commit SHA, and SHA256 checksums.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { backupFile, writeFileAtomic } = require('../lib/safe_files');
const { resolveDataDir } = require('../lib/data_dir');

const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_FILES = [
  'config.json',
  'auth.json',
  'apikey.txt',
  'admin.key',
  'usage.json',
  'install_paths.json',
  'ui_language.txt',
  'cookie.txt',
];

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return 0;
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    let count = 0;
    for (const name of fs.readdirSync(src)) {
      count += copyTree(path.join(src, name), path.join(dst, name));
    }
    return count;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return 1;
}

function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createBackup({ rootDir = ROOT_DIR, dataDir = resolveDataDir({ rootDir }), reason = 'manual' } = {}) {
  const safeReason = String(reason || 'manual').replace(/[^a-zA-Z0-9_-]/g, '');
  const id = `${safeReason}-${stamp()}`;
  const bkpRoot = path.join(path.resolve(dataDir), '_backups');
  let dest = path.join(bkpRoot, id);
  for (let i = 1; fs.existsSync(dest); i++) {
    dest = path.join(bkpRoot, `${id}-${i}`);
  }
  const stateDir = path.join(dest, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  let pkgVersion = '';
  try {
    pkgVersion = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version || '';
  } catch {}

  let gitCommit = '';
  let gitBranch = '';
  let hasBundle = false;
  if (fs.existsSync(path.join(rootDir, '.git'))) {
    try {
      gitCommit = runGit(rootDir, ['rev-parse', 'HEAD']);
      gitBranch = runGit(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const bundlePath = path.join(dest, 'repo.bundle');
      runGit(rootDir, ['bundle', 'create', bundlePath, '--all']);
      runGit(rootDir, ['bundle', 'verify', bundlePath]);
      hasBundle = true;
    } catch {}
  }

  const files = {};
  for (const name of STATE_FILES) {
    const src = path.join(dataDir, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(stateDir, name);
    fs.copyFileSync(src, dst);
    files[name] = { size: fs.statSync(dst).size, sha256: sha256File(dst) };
  }

  const rollingDir = path.join(dataDir, 'backups');
  let rollingCount = 0;
  if (fs.existsSync(rollingDir)) {
    rollingCount = copyTree(rollingDir, path.join(stateDir, 'backups'));
  }

  const manifest = {
    id: path.basename(dest),
    reason: safeReason,
    createdAt: new Date().toISOString(),
    version: pkgVersion,
    gitBranch,
    gitCommit,
    hasBundle,
    rollingBackupsCount: rollingCount,
    files,
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { ok: true, dir: dest, manifest };
}

function countFilesShallow(dir, depth = 0) {
  if (depth > 3 || !fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'manifest.json') continue;
    if (e.isDirectory()) total += countFilesShallow(path.join(dir, e.name), depth + 1);
    else total++;
  }
  return total;
}

function listBackups({ rootDir = ROOT_DIR, dataDir = resolveDataDir({ rootDir }) } = {}) {
  const roots = [...new Set([
    path.join(path.resolve(dataDir), '_backups'),
    path.join(path.resolve(rootDir), '_backups'),
  ])];
  const seen = new Set();
  const out = [];
  for (const bkpRoot of roots) {
    if (!fs.existsSync(bkpRoot)) continue;
    const entries = fs.readdirSync(bkpRoot).sort().reverse();
    for (const name of entries) {
      if (seen.has(name)) continue;
      const full = path.join(bkpRoot, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      seen.add(name);
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8'));
      } catch {}
      const manifestFilesCount = manifest && manifest.files ? Object.keys(manifest.files).length : 0;
      const fileCount = manifestFilesCount || countFilesShallow(full);
      out.push({
        id: name,
        path: full,
        createdAt: (manifest && manifest.createdAt) || st.mtime.toISOString(),
        reason: (manifest && manifest.reason) || (name.split('-')[0] || 'snapshot'),
        version: (manifest && manifest.version) || '',
        gitCommit: (manifest && manifest.gitCommit) || '',
        hasBundle: !!(manifest && manifest.hasBundle) || fs.existsSync(path.join(full, 'repo.bundle')),
        fileCount,
      });
    }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

function rollbackBackup(id, { rootDir = ROOT_DIR, dataDir = resolveDataDir({ rootDir }) } = {}) {
  const cleanId = path.basename(String(id || '').trim());
  if (!cleanId) throw new Error('Backup ID is required.');
  const candidates = [
    path.join(path.resolve(dataDir), '_backups', cleanId),
    path.join(path.resolve(rootDir), '_backups', cleanId),
  ];
  const srcDir = candidates.find((c) => fs.existsSync(c));
  if (!srcDir) throw new Error(`Backup not found: ${cleanId}`);

  const preRestore = createBackup({ rootDir, dataDir, reason: 'pre-rollback' });
  const stateDir = path.join(srcDir, 'state');
  const restored = [];
  if (fs.existsSync(stateDir)) {
    for (const name of STATE_FILES) {
      const src = path.join(stateDir, name);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(dataDir, name);
      try { if (fs.existsSync(dst)) backupFile(dst); } catch {}
      writeFileAtomic(dst, fs.readFileSync(src));
      restored.push(name);
    }
  }
  return { ok: true, id: cleanId, preRestore: preRestore.manifest.id, restored };
}

function applyUpdate({ rootDir = ROOT_DIR, dataDir = resolveDataDir({ rootDir }) } = {}) {
  console.log('[1/4] Creating full backup before update...');
  const bkp = createBackup({ rootDir, dataDir, reason: 'update' });
  console.log(`  Backup saved: ${bkp.dir}`);

  if (!fs.existsSync(path.join(rootDir, '.git'))) {
    console.log('[!] This folder is a portable/non-Git copy. State backup created, skipping git pull.');
    return { ok: true, updated: false, backup: bkp.manifest.id, reason: 'no_git' };
  }

  console.log('[2/4] Checking repository cleanliness...');
  const dirty = runGit(rootDir, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    throw new Error(`Working tree has local tracked changes; commit or stash them first:\n${dirty}`);
  }

  console.log('[3/4] Fetching and fast-forwarding from remote...');
  const remotes = runGit(rootDir, ['remote']).split(/\r?\n/).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : (remotes[0] || '');
  if (!remote) {
    throw new Error('No git remote configured.');
  }
  const branch = runGit(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const before = runGit(rootDir, ['rev-parse', '--short', 'HEAD']);
  runGit(rootDir, ['fetch', remote]);
  try {
    runGit(rootDir, ['pull', '--ff-only', remote, branch]);
  } catch (e) {
    console.error('[!] git pull --ff-only failed. Your pre-update backup is safe at:', bkp.dir);
    throw e;
  }
  const after = runGit(rootDir, ['rev-parse', '--short', 'HEAD']);

  console.log('[4/4] Verifying config tests...');
  execFileSync(process.execPath, [path.join(rootDir, 'test', 'test_config.js')], { stdio: 'inherit', timeout: 30000 });
  console.log(before === after
    ? `Already up to date (${after}). Backup kept at ${bkp.manifest.id}.`
    : `Updated cleanly: ${before} -> ${after}. Backup kept at ${bkp.manifest.id}.`);
  return { ok: true, updated: before !== after, before, after, backup: bkp.manifest.id };
}

function main(argv = process.argv.slice(2)) {
  try {
    if (argv.includes('--list')) {
      console.log(JSON.stringify(listBackups(), null, 2));
      return;
    }
    if (argv.includes('--backup-only')) {
      const idx = argv.indexOf('--reason');
      const reason = idx !== -1 && argv[idx + 1] ? argv[idx + 1] : 'manual';
      const res = createBackup({ reason });
      console.log(`Backup created: ${res.dir}`);
      console.log(`Files backed up: ${Object.keys(res.manifest.files).join(', ') || '(none)'}`);
      return;
    }
    if (argv.includes('--rollback')) {
      const idx = argv.indexOf('--rollback');
      const id = argv[idx + 1];
      const res = rollbackBackup(id);
      console.log(`Restored backup ${res.id} (${res.restored.join(', ')}). Safety snapshot: ${res.preRestore}`);
      return;
    }
    applyUpdate();
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  STATE_FILES,
  createBackup,
  listBackups,
  rollbackBackup,
  applyUpdate,
};

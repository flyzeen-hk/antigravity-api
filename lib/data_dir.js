'use strict';

/**
 * Resolves the mutable application data directory (`DATA_DIR`).
 *
 * Why:
 * On Windows 10/11, Windows Defender Controlled Folder Access blocks `node.exe`
 * whenever an app located inside `Documents` / `OneDrive\Документы` / `Desktop`
 * writes mutable files (`config.json`, `usage.json`, `.ui-supervisor.json`, `_backups/`, etc.)
 * into its own code folder.
 *
 * Storing mutable state in `%LOCALAPPDATA%\AntigravityAPI` (the standard OS-sanctioned
 * per-user app data location) eliminates Controlled Folder Access blocks completely,
 * while seamlessly migrating any existing state files read-only from `rootDir` on first run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('./safe_files');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

const LEGACY_STATE_FILES = [
  'config.json',
  'auth.json',
  'apikey.txt',
  'admin.key',
  'usage.json',
  'known_models.json',
  'install_paths.json',
  'cookie.txt',
  'cookies.txt',
];

function resolveDataDir({ rootDir = DEFAULT_ROOT, env = process.env, platform = process.platform } = {}) {
  const explicit = String(env.AG_DATA_DIR || '').trim();
  if (explicit) return path.resolve(explicit);

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(os.homedir(), 'AppData', 'Local');
    return path.win32.join(localAppData, 'AntigravityAPI');
  }

  const absRoot = path.resolve(rootDir);
  try {
    fs.accessSync(absRoot, fs.constants.W_OK);
    return absRoot;
  } catch {
    if (platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'AntigravityAPI');
    }
    return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'antigravity-api');
  }
}

function migrateLegacyStateFiles({ rootDir = DEFAULT_ROOT, dataDir, env = process.env, force = false } = {}) {
  const absRoot = path.resolve(rootDir);
  const absData = dataDir ? path.resolve(dataDir) : resolveDataDir({ rootDir: absRoot, env });
  fs.mkdirSync(absData, { recursive: true });
  const migrated = [];
  if (!force && String(env.AG_DATA_DIR || '').trim()) {
    return { dataDir: absData, migrated };
  }
  if (absData.toLowerCase() === absRoot.toLowerCase()) {
    return { dataDir: absData, migrated };
  }

  for (const name of LEGACY_STATE_FILES) {
    const src = path.join(absRoot, name);
    const dst = path.join(absData, name);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        const content = fs.readFileSync(src);
        writeFileAtomic(dst, content);
        if (process.platform !== 'win32' && /^(config\.json|auth\.json|apikey\.txt|admin\.key|cookie.*\.txt)$/i.test(name)) {
          try { fs.chmodSync(dst, 0o600); } catch {}
        }
        migrated.push(name);
      }
    } catch {}
  }
  return { dataDir: absData, migrated };
}

module.exports = {
  resolveDataDir,
  migrateLegacyStateFiles,
  LEGACY_STATE_FILES,
};

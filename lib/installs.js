'use strict';

/**
 * Cross-platform Antigravity installation detector and custom path store.
 *
 * Detects distinct installations honestly (no duplicate app/IDE paths and no
 * false-positive VS Code detection unless an Antigravity VS Code extension is
 * actually installed). Stores optional user overrides in `install_paths.json`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readJsonFile, writeFileAtomic } = require('./safe_files');

const INSTALL_SPECS = [
  { key: 'app', label: 'Antigravity', kind: 'file' },
  { key: 'cli', label: 'Antigravity CLI', kind: 'file' },
  { key: 'vscode', label: 'Antigravity for VS Code', kind: 'dir' },
];

const AUTO_CACHE_TTL_MS = 60 * 1000;
let autoCache = null;

function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function which(cmd) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, process.platform === 'win32' && !cmd.includes('.') ? cmd + ext : cmd);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return '';
}

function firstExisting(candidates, kind = 'any') {
  for (const p of candidates) {
    if (!p) continue;
    try {
      const st = fs.statSync(p);
      if (kind === 'file' && st.isFile()) return p;
      if (kind === 'dir' && st.isDirectory()) return p;
      if (kind === 'any' && (st.isFile() || st.isDirectory())) return p;
    } catch {}
  }
  return '';
}

function findVsCodeExtension(home) {
  const extDirs = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
  ];
  for (const dir of extDirs) {
    try {
      const entries = fs.readdirSync(dir);
      const match = entries.find((e) => /(?:^|[._-])antigravity(?:$|[._-])/i.test(e));
      if (match) {
        const full = path.join(dir, match);
        if (fs.statSync(full).isDirectory()) return full;
      }
    } catch {}
  }
  return '';
}

function detectAutoPaths({ platform = process.platform, env = process.env, home = os.homedir(), force = false } = {}) {
  const isDefault = platform === process.platform && env === process.env && home === os.homedir();
  if (isDefault && !force && autoCache && (Date.now() - autoCache.at) < AUTO_CACHE_TTL_MS) {
    return { ...autoCache.found };
  }

  const found = { app: '', cli: '', vscode: '' };

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    found.app = firstExisting([
      path.join(local, 'Programs', 'antigravity', 'Antigravity.exe'),
      path.join(local, 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.join(pf, 'Antigravity', 'Antigravity.exe'),
      path.join(pf86, 'Antigravity', 'Antigravity.exe'),
    ], 'file');
    const cliCandidate = which('agy') || which('antigravity') || firstExisting([
      path.join(local, 'Programs', 'antigravity', 'bin', 'antigravity.cmd'),
      path.join(local, 'Programs', 'antigravity', 'bin', 'agy.exe'),
      path.join(home, '.antigravity', 'bin', 'antigravity.exe'),
      path.join(home, '.antigravity', 'bin', 'agy.exe'),
    ], 'file');
    found.cli = cliCandidate && !samePath(cliCandidate, found.app) ? cliCandidate : '';
  } else if (platform === 'darwin') {
    found.app = firstExisting([
      '/Applications/Antigravity.app',
      path.join(home, 'Applications', 'Antigravity.app'),
    ], 'any');
    const cliCandidate = which('agy') || which('antigravity') || firstExisting([
      '/usr/local/bin/agy',
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/antigravity',
      '/opt/homebrew/bin/antigravity',
      path.join(home, '.local', 'bin', 'agy'),
      path.join(home, '.local', 'bin', 'antigravity'),
    ], 'file');
    found.cli = cliCandidate && !samePath(cliCandidate, found.app) ? cliCandidate : '';
  } else {
    found.app = firstExisting([
      '/usr/bin/antigravity',
      '/usr/local/bin/antigravity',
      '/opt/antigravity/antigravity',
      path.join(home, '.local', 'bin', 'antigravity'),
    ], 'file');
    const cliCandidate = which('agy') || firstExisting([
      '/usr/local/bin/agy',
      path.join(home, '.local', 'bin', 'agy'),
    ], 'file');
    found.cli = cliCandidate && !samePath(cliCandidate, found.app) ? cliCandidate : '';
  }

  // Only report VS Code integration if an actual Antigravity extension is installed.
  found.vscode = findVsCodeExtension(home);

  if (isDefault) {
    autoCache = { at: Date.now(), found: { ...found } };
  }
  return found;
}

function isValidPath(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    const st = fs.statSync(p.trim());
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}

function getOverrideFile(dataDir) {
  return path.join(dataDir, 'install_paths.json');
}

function loadOverrides(dataDir) {
  try {
    const obj = readJsonFile(getOverrideFile(dataDir));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function detectInstallations(dataDir, { force = false } = {}) {
  const detected = detectAutoPaths({ force });
  const overrides = loadOverrides(dataDir);
  const items = INSTALL_SPECS.map((spec) => {
    const rawOverride = overrides[spec.key] || (spec.key === 'app' ? overrides.ide : '');
    const customPath = typeof rawOverride === 'string' ? rawOverride.trim() : '';
    const detectedPath = detected[spec.key] || '';
    const activePath = customPath || detectedPath;
    return {
      key: spec.key,
      label: spec.label,
      path: activePath,
      customPath,
      detectedPath,
      found: isValidPath(activePath),
    };
  });
  return { items, file: getOverrideFile(dataDir) };
}

function setInstallPath(dataDir, key, customPath) {
  const normalizedKey = key === 'ide' ? 'app' : key;
  const spec = INSTALL_SPECS.find((s) => s.key === normalizedKey);
  if (!spec) {
    const err = new Error(`Неизвестный ключ установки: ${key}`);
    err.status = 400;
    throw err;
  }
  const trimmed = String(customPath || '').trim();
  if (trimmed && !isValidPath(trimmed)) {
    const err = new Error(`Путь не найден на диске: ${trimmed}`);
    err.status = 400;
    throw err;
  }
  const overrides = loadOverrides(dataDir);
  if (normalizedKey === 'app') delete overrides.ide;
  if (trimmed) overrides[normalizedKey] = trimmed;
  else delete overrides[normalizedKey];
  fs.mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(getOverrideFile(dataDir), JSON.stringify(overrides, null, 2) + '\n');
  autoCache = null;
  return detectInstallations(dataDir, { force: true });
}

function openInstallFolder(dataDir, key) {
  const normalizedKey = key === 'ide' ? 'app' : key;
  const { items } = detectInstallations(dataDir);
  const found = items.find((i) => i.key === normalizedKey);
  if (!found) {
    const err = new Error(`Unknown install key: ${key}`);
    err.status = 400;
    throw err;
  }
  if (!found.path || !found.found) {
    const err = new Error(`Program path not found on disk for ${found.label || key}`);
    err.status = 404;
    throw err;
  }
  let dir = found.path;
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {}
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
    child.unref();
  } else if (process.platform === 'darwin') {
    const child = spawn('open', [dir], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    const child = spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  return { ok: true, key: normalizedKey, dir };
}

module.exports = {
  INSTALL_SPECS,
  detectAutoPaths,
  detectInstallations,
  setInstallPath,
  openInstallFolder,
  isValidPath,
};

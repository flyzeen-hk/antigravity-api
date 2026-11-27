'use strict';

/**
 * Cross-platform Antigravity installation detector and custom path store.
 *
 * Replaces Windows-only hardcoded checks in legacy `app.py` with detection across
 * Windows, macOS, and Linux, storing optional user overrides in `install_paths.json`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readJsonFile, writeFileAtomic } = require('./safe_files');

const INSTALL_SPECS = [
  { key: 'app', label: 'Antigravity', kind: 'file' },
  { key: 'ide', label: 'Antigravity IDE', kind: 'file' },
  { key: 'cli', label: 'Antigravity CLI', kind: 'file' },
  { key: 'vscode', label: 'Antigravity for VS Code', kind: 'any' },
];

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
      const match = entries.find((e) => /antigravity|google\.antigravity/i.test(e));
      if (match) return path.join(dir, match);
    } catch {}
  }
  return '';
}

function detectAutoPaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const found = { app: '', ide: '', cli: '', vscode: '' };

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
    found.ide = firstExisting([
      path.join(local, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
      path.join(local, 'Programs', 'antigravity-ide', 'Antigravity IDE.exe'),
      path.join(pf, 'Antigravity IDE', 'Antigravity IDE.exe'),
      found.app,
    ], 'file');
    found.cli = which('antigravity') || firstExisting([
      path.join(local, 'Programs', 'antigravity', 'bin', 'antigravity.cmd'),
      path.join(local, 'Programs', 'antigravity', 'bin', 'antigravity.exe'),
      path.join(home, '.antigravity', 'bin', 'antigravity.exe'),
    ], 'file');
  } else if (platform === 'darwin') {
    found.app = firstExisting([
      '/Applications/Antigravity.app',
      path.join(home, 'Applications', 'Antigravity.app'),
    ], 'any');
    found.ide = firstExisting([
      '/Applications/Antigravity IDE.app',
      path.join(home, 'Applications', 'Antigravity IDE.app'),
      found.app,
    ], 'any');
    found.cli = which('antigravity') || firstExisting([
      '/usr/local/bin/antigravity',
      '/opt/homebrew/bin/antigravity',
      path.join(home, '.local', 'bin', 'antigravity'),
    ], 'file');
  } else {
    found.app = firstExisting([
      '/usr/bin/antigravity',
      '/usr/local/bin/antigravity',
      '/opt/antigravity/antigravity',
      path.join(home, '.local', 'bin', 'antigravity'),
    ], 'file');
    found.ide = firstExisting([
      '/usr/bin/antigravity-ide',
      '/opt/Antigravity IDE/antigravity-ide',
      found.app,
    ], 'file');
    found.cli = which('antigravity') || found.app;
  }

  found.vscode = findVsCodeExtension(home) || firstExisting([
    which('code'),
    platform === 'win32' ? path.join(env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe') : '',
  ], 'any');

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

function detectInstallations(dataDir) {
  const detected = detectAutoPaths();
  const overrides = loadOverrides(dataDir);
  const items = INSTALL_SPECS.map((spec) => {
    const customPath = typeof overrides[spec.key] === 'string' ? overrides[spec.key].trim() : '';
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
  const spec = INSTALL_SPECS.find((s) => s.key === key);
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
  if (trimmed) overrides[key] = trimmed;
  else delete overrides[key];
  fs.mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(getOverrideFile(dataDir), JSON.stringify(overrides, null, 2) + '\n');
  return detectInstallations(dataDir);
}

function openInstallFolder(dataDir, key) {
  const { items } = detectInstallations(dataDir);
  const found = items.find((i) => i.key === key);
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
  return { ok: true, key, dir };
}

module.exports = {
  INSTALL_SPECS,
  detectAutoPaths,
  detectInstallations,
  setInstallPath,
  openInstallFolder,
  isValidPath,
};

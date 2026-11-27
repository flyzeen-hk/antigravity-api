'use strict';

/**
 * Packages a self-contained autonomous portable distribution in `dist/antigravity-api-portable/`
 * bundling the codebase together with a local Node.js runtime (`runtime/node/`).
 * Zero secrets, git metadata, or backup folders are ever included.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { removeTree } = require('../lib/safe_files');

const ROOT_DIR = path.resolve(__dirname, '..');
const INCLUDE_FILES = [
  'server.js',
  'package.json',
  'config.example.json',
  'LICENSE',
  'README.md',
  'install.bat',
  'install.sh',
  'run.bat',
  'run.sh',
  'update.bat',
  'update.sh',
];
const INCLUDE_DIRS = ['lib', 'public', 'scripts', 'assets'];

function copyFileNormalized(src, dst) {
  if (/\.sh$/i.test(src)) {
    const lf = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(dst, lf, 'utf8');
    try { fs.chmodSync(dst, 0o755); } catch {}
    return;
  }
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const name of fs.readdirSync(src)) {
    const sp = path.join(src, name);
    const dp = path.join(dst, name);
    const st = fs.lstatSync(sp);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) count += copyDir(sp, dp);
    else {
      copyFileNormalized(sp, dp);
      count++;
    }
  }
  return count;
}

function buildPortable({ rootDir = ROOT_DIR, createZip = false } = {}) {
  const outDir = path.join(rootDir, 'dist', 'antigravity-api-portable');
  if (fs.existsSync(outDir)) removeTree(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  let filesCopied = 0;
  for (const f of INCLUDE_FILES) {
    const src = path.join(rootDir, f);
    if (fs.existsSync(src)) {
      copyFileNormalized(src, path.join(outDir, f));
      filesCopied++;
    }
  }
  for (const d of INCLUDE_DIRS) {
    const src = path.join(rootDir, d);
    if (fs.existsSync(src)) filesCopied += copyDir(src, path.join(outDir, d));
  }

  const localRuntime = path.join(rootDir, 'runtime', 'node');
  const targetRuntime = path.join(outDir, 'runtime', 'node');
  if (fs.existsSync(localRuntime)) {
    filesCopied += copyDir(localRuntime, targetRuntime);
  } else if (process.platform === 'win32') {
    fs.mkdirSync(targetRuntime, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(targetRuntime, 'node.exe'));
    filesCopied++;
  } else {
    const binDir = path.join(targetRuntime, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const dest = path.join(binDir, 'node');
    fs.copyFileSync(process.execPath, dest);
    fs.chmodSync(dest, 0o755);
    filesCopied++;
  }

  let zipPath = '';
  if (createZip) {
    zipPath = path.join(rootDir, 'dist', `antigravity-api-portable-${process.platform}-${process.arch}.zip`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (process.platform === 'win32') {
      const escSrc = path.join(outDir, '*').replace(/'/g, "''");
      const escZip = zipPath.replace(/'/g, "''");
      execFileSync('powershell', [
        '-NoProfile', '-Command',
        `Compress-Archive -Path '${escSrc}' -DestinationPath '${escZip}' -Force`,
      ], { stdio: 'inherit', timeout: 120000 });
    } else {
      execFileSync('zip', ['-rq', zipPath, '.'], { cwd: outDir, stdio: 'inherit', timeout: 120000 });
    }
  }

  return { ok: true, outDir, filesCopied, zipPath };
}

if (require.main === module) {
  const createZip = process.argv.includes('--zip');
  const res = buildPortable({ createZip });
  console.log(`Portable build ready: ${res.outDir} (${res.filesCopied} files)`);
  if (res.zipPath) console.log(`Archive: ${res.zipPath}`);
}

module.exports = { buildPortable };

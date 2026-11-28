'use strict';

/**
 * Privacy & Security Audit Tool (pure Node.js).
 *
 * Verifies:
 * 1. `.gitignore` protects all secret, backup, runtime, and local state paths.
 * 2. Zero live OAuth tokens (`ya29.*`, `1//0*`), API/Admin keys (`agk_*`, `agadm_*`),
 *    Google cookies (`SAPISID=`, `__Secure-1PSID=`), or personal home paths exist in source files.
 * 3. `config.example.json` contains only placeholders.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE_DIR = path.resolve(__dirname, '..');

const REQUIRED_GITIGNORE = [
  'auth.json',
  'apikey.txt',
  'admin.key',
  'config.json',
  'usage.json',
  'cookie.txt',
  'cookies.txt',
  'agent_audit.jsonl',
  'install_paths.json',
  'known_models.json',
  'web_models.json',
  'free_tunnel_state.json',
  'free_tunnel_cache.json',
  '.ui-supervisor.json',
  'backups/',
  '_backups/',
  'runtime/',
  'dist/',
  'GeminiBrowser/',
  'bin/',
];

const PRIVATE_FILES = new Set([
  'auth.json',
  'apikey.txt',
  'admin.key',
  'config.json',
  'usage.json',
  'cookie.txt',
  'cookies.txt',
  'agent_audit.jsonl',
  'install_paths.json',
  'known_models.json',
  'web_models.json',
  'free_tunnel_state.json',
  'free_tunnel_cache.json',
  'ui_language.txt',
  '.ui-supervisor.json',
  '.launcher.pid',
]);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '_backups',
  'backups',
  'agent_workspace',
  'runtime',
  'dist',
  'data',
  'GeminiBrowser',
  'bin',
  '__pycache__',
  '.venv',
  'venv',
]);

const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.html', '.css', '.json', '.md',
  '.bat', '.sh', '.ps1', '.vbs', '.yml', '.yaml', '.txt',
]);

const PLACEHOLDER_USER_RE = /^(?:me|user|username|example|demo|test|admin|nobody|<[^>]+>|\$\{[^}]+\}|\.\.\.)$/i;
const SAFE_TEST_SECRET_RE = /(?:test|mock|dummy|example|placeholder|diagnostic|secret-|json_cookie|file_sapisid|file-cookie|\$\{)/i;

function checkGitignore(baseDir = BASE_DIR) {
  const giPath = path.join(baseDir, '.gitignore');
  if (!fs.existsSync(giPath)) return ['.gitignore file is missing!'];
  const lines = fs.readFileSync(giPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const lineSet = new Set(lines);
  const issues = [];
  for (const req of REQUIRED_GITIGNORE) {
    if (!lineSet.has(req) && !lineSet.has(req.replace(/\/$/, ''))) {
      issues.push(`CRITICAL: '${req}' is NOT listed in .gitignore!`);
    }
  }
  return issues;
}

function checkExampleConfig(baseDir = BASE_DIR) {
  const exPath = path.join(baseDir, 'config.example.json');
  if (!fs.existsSync(exPath)) return ['config.example.json is missing!'];
  const issues = [];
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(exPath, 'utf8'));
  } catch (e) {
    return [`config.example.json is invalid JSON: ${e.message}`];
  }
  if (cfg.apiKey && !/your_api_key/i.test(String(cfg.apiKey))) {
    issues.push('config.example.json contains a non-placeholder apiKey!');
  }
  if (cfg.adminKey && !/your_admin_key/i.test(String(cfg.adminKey))) {
    issues.push('config.example.json contains a non-placeholder adminKey!');
  }
  if (cfg.geminiWeb) {
    if (cfg.geminiWeb.cookie) issues.push('config.example.json contains a non-empty geminiWeb.cookie!');
    if (cfg.geminiWeb.atToken) issues.push('config.example.json contains a non-empty geminiWeb.atToken!');
    if (Array.isArray(cfg.geminiWeb.accounts) && cfg.geminiWeb.accounts.length > 0) {
      issues.push('config.example.json must have empty geminiWeb.accounts!');
    }
  }
  return issues;
}

function scanSourceFiles(baseDir = BASE_DIR) {
  const issues = [];
  let scanned = 0;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (PRIVATE_FILES.has(entry)) continue;
      if (/\.(log|ico|png|jpg|jpeg|gif|webp|woff2?|db|sqlite|bundle|zip|bak|corrupt)$/i.test(entry)) continue;
      if (entry.startsWith('agent_audit.jsonl')) continue;
      const ext = path.extname(entry).toLowerCase();
      if (!SOURCE_EXTS.has(ext) && entry !== '.gitignore' && entry !== 'Dockerfile') continue;

      const rel = path.relative(baseDir, full).replace(/\\/g, '/');
      if (rel === 'scripts/verify_privacy.js') continue;
      const isTestFile = rel.startsWith('test/');
      scanned++;

      const content = fs.readFileSync(full, 'utf8');

      for (const m of content.matchAll(/ya29\.[a-zA-Z0-9_-]{30,}/g)) {
        if (isTestFile && SAFE_TEST_SECRET_RE.test(m[0])) continue;
        issues.push(`File '${rel}': Live Google Access Token (${m[0].slice(0, 14)}...)`);
      }
      for (const m of content.matchAll(/1\/\/0[a-zA-Z0-9_-]{30,}/g)) {
        if (isTestFile && SAFE_TEST_SECRET_RE.test(m[0])) continue;
        issues.push(`File '${rel}': Live Google Refresh Token`);
      }
      for (const m of content.matchAll(/agk_[0-9a-f]{40,}/gi)) {
        if (isTestFile && SAFE_TEST_SECRET_RE.test(m[0])) continue;
        issues.push(`File '${rel}': Generated Antigravity API Key`);
      }
      for (const m of content.matchAll(/agadm_[0-9a-f]{40,}/gi)) {
        if (isTestFile && SAFE_TEST_SECRET_RE.test(m[0])) continue;
        issues.push(`File '${rel}': Generated Antigravity Admin Key`);
      }
      for (const m of content.matchAll(/(?:^|[;\s'"`])((?:SAPISID|__Secure-1PSID)=[^\s;'"`]{12,})/g)) {
        if (isTestFile && SAFE_TEST_SECRET_RE.test(m[1])) continue;
        if (/example|your_|placeholder|\.\.\./i.test(m[1])) continue;
        issues.push(`File '${rel}': Live Google Cookie (${m[1].split('=')[0]})`);
      }
      for (const m of content.matchAll(/C:[\\/]+Users[\\/]+([^\\/\s'"`:]+)/gi)) {
        const userSeg = m[1];
        if (PLACEHOLDER_USER_RE.test(userSeg)) continue;
        issues.push(`File '${rel}': Hardcoded Windows User Profile Path (C:\\Users\\${userSeg})`);
      }
      for (const m of content.matchAll(/(?:^|[\s'"`(])\/(?:Users|home)\/([a-zA-Z0-9._-]+)\//g)) {
        const userSeg = m[1];
        if (PLACEHOLDER_USER_RE.test(userSeg)) continue;
        issues.push(`File '${rel}': Hardcoded POSIX User Home Path (/${userSeg}/)`);
      }
    }
  }

  walk(baseDir);
  return { scanned, issues };
}

function checkTrackedAndLineEndings(baseDir = BASE_DIR) {
  const issues = [];
  if (fs.existsSync(path.join(baseDir, '.git'))) {
    try {
      const tracked = execFileSync('git', ['ls-files'], { cwd: baseDir, encoding: 'utf8', timeout: 5000 })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const rel of tracked) {
        const base = path.basename(rel);
        if (PRIVATE_FILES.has(base) || /^cookie.*\.txt$/i.test(base) || /\.(env|bak|corrupt)$/i.test(base)) {
          issues.push(`CRITICAL: Private/state file '${rel}' is tracked in Git index!`);
        }
      }
    } catch {}
  }

  for (const rel of ['run.sh', 'install.sh', 'update.sh', 'scripts/bootstrap_node.sh', 'Dockerfile']) {
    const p = path.join(baseDir, rel);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p);
      if (raw.includes(0x0d)) {
        issues.push(`File '${rel}' contains Windows CRLF (\\r\\n) line endings, which breaks Linux/macOS/Docker.`);
      }
    }
  }
  return issues;
}

function runAudit(baseDir = BASE_DIR) {
  const giIssues = checkGitignore(baseDir);
  const exIssues = checkExampleConfig(baseDir);
  const { scanned, issues: sIssues } = scanSourceFiles(baseDir);
  const extraIssues = checkTrackedAndLineEndings(baseDir);
  const srcIssues = [...sIssues, ...extraIssues];
  return {
    ok: giIssues.length === 0 && exIssues.length === 0 && srcIssues.length === 0,
    scanned,
    giIssues,
    exIssues,
    srcIssues,
  };
}

function main() {
  console.log('============================================================');
  console.log('      ANTIGRAVITY API - PRIVACY & SECURITY AUDIT');
  console.log('============================================================');

  const res = runAudit();
  if (res.giIssues.length) {
    console.log('\n[FAIL] .gitignore Configuration:');
    for (const iss of res.giIssues) console.log(`  - ${iss}`);
  } else {
    console.log('[OK] .gitignore protects all private, backup, and runtime files.');
  }

  if (res.exIssues.length) {
    console.log('\n[FAIL] config.example.json:');
    for (const iss of res.exIssues) console.log(`  - ${iss}`);
  } else {
    console.log('[OK] config.example.json contains placeholders only.');
  }

  console.log(`[OK] Scanned ${res.scanned} source and documentation files.`);
  if (res.srcIssues.length) {
    console.log('\n[FAIL] Security Leak Issues Detected:');
    for (const iss of res.srcIssues) console.log(`  ! ${iss}`);
  } else {
    console.log('[OK] Zero private tokens, cookies, keys, or personal paths found.');
  }

  console.log('\n============================================================');
  if (res.ok) {
    console.log('AUDIT RESULT: 100% CLEAN. REPOSITORY IS SAFE FOR DISTRIBUTION.');
    console.log('============================================================');
    process.exit(0);
  } else {
    console.log('AUDIT RESULT: FAILED. FIX THE ISSUES ABOVE BEFORE PUSHING.');
    console.log('============================================================');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkGitignore, checkExampleConfig, scanSourceFiles, runAudit };

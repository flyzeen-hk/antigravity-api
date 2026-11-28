'use strict';

/**
 * Cross-platform Desktop, Start Menu & Autostart shortcut manager (pure Node.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { normalizeIconTheme, getThemeAssetPaths } = require('../lib/theme_icons');
const { resolveDataDir } = require('../lib/data_dir');

const ROOT_DIR = path.resolve(__dirname, '..');
const SHORTCUT_NAME = 'Antigravity API.lnk';
const STARTUP_NAME = 'Antigravity API (hidden).lnk';

function psEscape(str) {
  return String(str || '').replace(/'/g, "''");
}

function getWindowsDesktopFolders() {
  const folders = new Set();
  const userProfile = process.env.USERPROFILE || os.homedir();

  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (m) {
      const expanded = m[1].trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
      if (fs.existsSync(expanded)) folders.add(expanded);
    }
  } catch {}

  for (const c of [
    path.join(userProfile, 'OneDrive', 'Рабочий стол'),
    path.join(userProfile, 'OneDrive', 'Desktop'),
    path.join(userProfile, 'Рабочий стол'),
    path.join(userProfile, 'Desktop'),
  ]) {
    if (fs.existsSync(c)) folders.add(c);
  }
  return [...folders];
}

function getWindowsStartMenuFolder() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const sm = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return fs.existsSync(sm) ? sm : null;
}

function getWindowsStartupFolder() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const st = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return fs.existsSync(st) ? st : null;
}

function createWindowsLnk({ lnkPath, targetPath, args = '', workingDir, iconPath, description, windowStyle = 1 }) {
  const absLnk = path.resolve(lnkPath);
  const absTarget = path.resolve(targetPath);
  const absWork = path.resolve(workingDir);
  const absIcon = path.resolve(iconPath);
  const cmd = [
    '$ws = New-Object -ComObject WScript.Shell;',
    `$s = $ws.CreateShortcut('${psEscape(absLnk)}');`,
    `$s.TargetPath = '${psEscape(absTarget)}';`,
    `$s.Arguments = '${psEscape(args)}';`,
    `$s.WorkingDirectory = '${psEscape(absWork)}';`,
    `$s.IconLocation = '${psEscape(absIcon)},0';`,
    `$s.Description = '${psEscape(description)}';`,
    `$s.WindowStyle = ${Number(windowStyle) || 1};`,
    '$s.Save();',
  ].join('\n');
  const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function clearAppFaviconCache(theme) {
  const defaultDir = path.join(os.tmpdir(), 'antigravity-api-ui-profile', 'Default');
  try {
    if (fs.existsSync(defaultDir)) {
      for (const name of fs.readdirSync(defaultDir)) {
        if (/^Favicons/i.test(name)) {
          try { fs.unlinkSync(path.join(defaultDir, name)); } catch {}
        }
      }
    }
  } catch {}
  if (theme) {
    const appProf = path.join(os.tmpdir(), 'antigravity-api-ui-profile');
    try {
      fs.mkdirSync(appProf, { recursive: true });
      fs.writeFileSync(path.join(appProf, '.ag-theme'), `v2:${normalizeIconTheme(theme)}`, 'utf8');
    } catch {}
  }
}

function createShortcuts({ rootDir = ROOT_DIR, dataDir = resolveDataDir({ rootDir }), theme } = {}) {
  rootDir = path.resolve(rootDir);
  const effectiveTheme = normalizeIconTheme(theme, { dataDir });
  const { ico: icoPath, png512 } = getThemeAssetPaths(rootDir, effectiveTheme);

  if (process.platform === 'win32') {
    const vbsPath = path.resolve(rootDir, 'scripts', 'run_hidden.vbs');
    const wscript = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
    const targetPath = fs.existsSync(vbsPath) && fs.existsSync(wscript) ? wscript : path.resolve(rootDir, 'run.bat');
    const args = targetPath === wscript ? `//B "${vbsPath}"` : '';

    const targets = [];
    for (const d of getWindowsDesktopFolders()) {
      targets.push({ lnk: path.join(d, SHORTCUT_NAME), label: 'Desktop' });
    }
    const sm = getWindowsStartMenuFolder();
    if (sm) targets.push({ lnk: path.join(sm, SHORTCUT_NAME), label: 'Start Menu' });

    if (!targets.length) {
      throw new Error('Could not find Desktop or Start Menu directories.');
    }

    const created = [];
    for (const t of targets) {
      createWindowsLnk({
        lnkPath: t.lnk,
        targetPath,
        args,
        workingDir: rootDir,
        iconPath: icoPath,
        description: 'Antigravity API Control Panel',
        windowStyle: targetPath === wscript ? 1 : 7,
      });
      created.push({ label: t.label, path: t.lnk });
    }
    clearAppFaviconCache(effectiveTheme);
    try { execFileSync('ie4uinit.exe', ['-ClearIconCache'], { stdio: 'ignore', timeout: 3000 }); } catch {}
    try { execFileSync('ie4uinit.exe', ['-show'], { stdio: 'ignore', timeout: 3000 }); } catch {}
    return { ok: true, theme: effectiveTheme, iconPath: icoPath, created };
  }

  if (process.platform === 'linux') {
    const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const desktopFile = path.join(appsDir, 'antigravity-api.desktop');
    const runSh = path.resolve(rootDir, 'run.sh');
    fs.writeFileSync(desktopFile, [
      '[Desktop Entry]',
      'Name=Antigravity API',
      'Comment=Local OpenAI, Anthropic & Gemini API Gateway',
      `Exec="${runSh}"`,
      `Icon=${png512}`,
      'Terminal=false',
      'Type=Application',
      'Categories=Development;Utility;',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(desktopFile, 0o755);
    return { ok: true, theme: effectiveTheme, iconPath: png512, created: [{ label: 'Applications', path: desktopFile }] };
  }

  return { ok: true, theme: effectiveTheme, created: [] };
}

function getAutostartInfo({ rootDir = ROOT_DIR } = {}) {
  rootDir = path.resolve(rootDir);
  if (process.platform === 'win32') {
    const dir = getWindowsStartupFolder();
    const lnk = dir ? path.join(dir, STARTUP_NAME) : '';
    const legacy = dir ? path.join(dir, SHORTCUT_NAME) : '';
    const activePath = lnk && fs.existsSync(lnk) ? lnk : (legacy && fs.existsSync(legacy) ? legacy : lnk);
    return {
      supported: !!dir,
      enabled: !!(activePath && fs.existsSync(activePath)),
      path: activePath,
    };
  }
  if (process.platform === 'linux') {
    const file = path.join(os.homedir(), '.config', 'autostart', 'antigravity-api.desktop');
    return { supported: true, enabled: fs.existsSync(file), path: file };
  }
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.antigravity.api.plist');
    return { supported: true, enabled: fs.existsSync(file), path: file };
  }
  return { supported: false, enabled: false, path: '' };
}

function setAutostart(enabled, { rootDir = ROOT_DIR, dataDir = resolveDataDir({ rootDir }), theme } = {}) {
  rootDir = path.resolve(rootDir);
  const effectiveTheme = normalizeIconTheme(theme, { dataDir });
  const { ico: icoPath, png512 } = getThemeAssetPaths(rootDir, effectiveTheme);
  const on = !!enabled;
  if (process.platform === 'win32') {
    const dir = getWindowsStartupFolder();
    if (!dir) throw new Error('Startup folder not found.');
    const lnk = path.join(dir, STARTUP_NAME);
    const legacy = path.join(dir, SHORTCUT_NAME);
    if (!on) {
      for (const f of [lnk, legacy]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      return getAutostartInfo({ rootDir });
    }
    const vbsPath = path.resolve(rootDir, 'scripts', 'run_hidden.vbs');
    const wscript = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
    createWindowsLnk({
      lnkPath: lnk,
      targetPath: wscript,
      args: `//B "${vbsPath}" --hidden`,
      workingDir: rootDir,
      iconPath: icoPath,
      description: 'Antigravity API (background)',
      windowStyle: 1,
    });
    return getAutostartInfo({ rootDir });
  }

  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    const file = path.join(dir, 'antigravity-api.desktop');
    if (!on) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return getAutostartInfo({ rootDir });
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Antigravity API',
      `Exec="${path.resolve(rootDir, 'run.sh')}" --hidden`,
      `Icon=${png512}`,
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'), 'utf8');
    return getAutostartInfo({ rootDir });
  }

  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const file = path.join(dir, 'com.antigravity.api.plist');
    if (!on) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return getAutostartInfo({ rootDir });
    }
    fs.mkdirSync(dir, { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.antigravity.api</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.resolve(rootDir, 'scripts', 'launcher.js')}</string>
    <string>--hidden</string>
  </array>
  <key>WorkingDirectory</key><string>${rootDir}</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
    fs.writeFileSync(file, plist, 'utf8');
    return getAutostartInfo({ rootDir });
  }

  throw new Error(`Autostart is not supported on ${process.platform}`);
}

/**
 * Updates existing Desktop / Start Menu / Autostart shortcuts owned by `rootDir`
 * to match the selected theme icon (`#7` light or `#8` dark) without blocking HTTP replies.
 */
function syncShortcutTheme({ rootDir = ROOT_DIR, dataDir = process.env.AG_DATA_DIR || rootDir, theme } = {}) {
  rootDir = path.resolve(rootDir);
  if (process.env.AG_NO_SHORTCUT_SYNC === '1') return { skipped: true };
  if (dataDir && path.resolve(dataDir) !== rootDir) return { skipped: true };

  const effectiveTheme = normalizeIconTheme(theme, { dataDir });
  const { ico: icoPath, png512 } = getThemeAssetPaths(rootDir, effectiveTheme);
  clearAppFaviconCache(effectiveTheme);

  if (process.platform === 'win32') {
    const ps = [
      '$ws = New-Object -ComObject WScript.Shell;',
      `$rootNorm = '${psEscape(rootDir.replace(/[\\/]+$/, '').toLowerCase())}';`,
      `$targetIcon = '${psEscape(icoPath)},0';`,
      '$dirs = New-Object System.Collections.Generic.List[string];',
      'try { $d = (Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" -Name Desktop -ErrorAction Stop).Desktop; if ($d) { $dirs.Add([Environment]::ExpandEnvironmentVariables($d)) } } catch {};',
      '$dirs.Add([Environment]::GetFolderPath("Desktop"));',
      '$dirs.Add((Join-Path $env:USERPROFILE "OneDrive\\Рабочий стол"));',
      '$dirs.Add((Join-Path $env:USERPROFILE "OneDrive\\Desktop"));',
      '$dirs.Add((Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs"));',
      '$dirs.Add((Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Startup"));',
      '$updated = 0;',
      'foreach ($dir in ($dirs | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)) {',
      `  foreach ($name in @('${SHORTCUT_NAME}', '${STARTUP_NAME}')) {`,
      '    $lnk = Join-Path $dir $name;',
      '    if (Test-Path $lnk) {',
      '      try {',
      '        $sc = $ws.CreateShortcut($lnk);',
      '        $wd = ($sc.WorkingDirectory -replace "[\\\\/]+$", "").ToLowerInvariant();',
      '        if ($wd -eq $rootNorm -and $sc.IconLocation -ne $targetIcon) {',
      '          $sc.IconLocation = $targetIcon;',
      '          $sc.Save();',
      '          $updated++;',
      '        }',
      '      } catch {}',
      '    }',
      '  }',
      '};',
      'if ($updated -gt 0) {',
      '  try { Start-Process -FilePath "ie4uinit.exe" -ArgumentList "-ClearIconCache" -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue } catch {};',
      '  try { Start-Process -FilePath "ie4uinit.exe" -ArgumentList "-show" -WindowStyle Hidden -ErrorAction SilentlyContinue } catch {};',
      '}',
    ].join('\n');
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch {}
    return { ok: true, theme: effectiveTheme, iconPath: icoPath };
  }

  if (process.platform === 'linux') {
    for (const file of [
      path.join(os.homedir(), '.local', 'share', 'applications', 'antigravity-api.desktop'),
      path.join(os.homedir(), '.config', 'autostart', 'antigravity-api.desktop'),
    ]) {
      try {
        if (!fs.existsSync(file)) continue;
        const txt = fs.readFileSync(file, 'utf8').replace(/^Icon=.*$/m, `Icon=${png512}`);
        fs.writeFileSync(file, txt, 'utf8');
      } catch {}
    }
    return { ok: true, theme: effectiveTheme, iconPath: png512 };
  }

  return { ok: true, theme: effectiveTheme };
}

function main(argv = process.argv.slice(2)) {
  try {
    const themeIdx = argv.indexOf('--theme');
    const cliTheme = themeIdx !== -1 ? argv[themeIdx + 1] : undefined;

    if (argv.includes('--autostart')) {
      const idx = argv.indexOf('--autostart');
      const mode = (argv[idx + 1] || 'status').toLowerCase();
      if (mode === 'on' || mode === 'true' || mode === '1') {
        console.log(JSON.stringify(setAutostart(true, { theme: cliTheme }), null, 2));
      } else if (mode === 'off' || mode === 'false' || mode === '0') {
        console.log(JSON.stringify(setAutostart(false, { theme: cliTheme }), null, 2));
      } else {
        console.log(JSON.stringify(getAutostartInfo(), null, 2));
      }
      return;
    }

    const res = createShortcuts({ theme: cliTheme });
    for (const item of res.created) {
      console.log(`[OK] Shortcut created [${item.label}]: ${item.path}`);
    }
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  createShortcuts,
  getAutostartInfo,
  setAutostart,
  syncShortcutTheme,
  clearAppFaviconCache,
  psEscape,
};

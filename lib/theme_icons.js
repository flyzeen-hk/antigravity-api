'use strict';

/**
 * Shared theme-aware icon resolver for Gateway HTTP UI, UI Supervisor,
 * Windows/Linux shortcuts, and Chromium --app HiDPI taskbar icon selection.
 */

const fs = require('fs');
const path = require('path');

function readThemeFromDataDir(dataDir) {
  if (!dataDir) return '';
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return typeof cfg?.theme === 'string' ? cfg.theme : '';
  } catch {
    return '';
  }
}

function normalizeIconTheme(theme, { dataDir = '', fallback = 'dark' } = {}) {
  let raw = String(theme || '').trim().toLowerCase();
  if (!raw && dataDir) {
    raw = String(readThemeFromDataDir(dataDir) || '').trim().toLowerCase();
  }
  if (raw === 'light') return 'light';
  if (raw === 'dark') return 'dark';
  return fallback === 'light' ? 'light' : 'dark';
}

function pickExisting(candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function getThemeAssetPaths(rootDir, theme = 'dark') {
  const root = path.resolve(rootDir);
  const t = normalizeIconTheme(theme);
  return {
    theme: t,
    ico: pickExisting([
      path.join(root, 'assets', `antigravity_api_${t}.ico`),
      path.join(root, 'assets', 'antigravity_api.ico'),
    ]),
    png32: pickExisting([
      path.join(root, 'public', `icon-${t}-32.png`),
      path.join(root, 'public', 'icon-32.png'),
    ]),
    png48: pickExisting([
      path.join(root, 'public', `icon-${t}-48.png`),
      path.join(root, 'public', 'icon-48.png'),
    ]),
    png64: pickExisting([
      path.join(root, 'public', `icon-${t}-64.png`),
      path.join(root, 'public', 'icon-64.png'),
    ]),
    png192: pickExisting([
      path.join(root, 'public', `icon-${t}-192.png`),
      path.join(root, 'public', 'icon-192.png'),
    ]),
    png512: pickExisting([
      path.join(root, 'assets', `antigravity_icon_${t}_512.png`),
      path.join(root, 'public', `icon-${t}-512.png`),
      path.join(root, 'assets', 'antigravity_icon_512.png'),
    ]),
    uiPng: pickExisting([
      path.join(root, 'assets', `antigravity_logo_ui_${t}.png`),
      path.join(root, 'assets', 'antigravity_logo_ui.png'),
    ]),
    svg: pickExisting([
      path.join(root, 'public', `icon-${t}.svg`),
      path.join(root, 'public', 'icon.svg'),
    ]),
  };
}

function buildManifestJson(theme = 'dark') {
  const t = normalizeIconTheme(theme);
  return JSON.stringify({
    name: 'Antigravity API',
    short_name: 'Antigravity API',
    start_url: '/',
    display: 'standalone',
    background_color: t === 'light' ? '#eef3fb' : '#070b14',
    theme_color: '#3182FF',
    icons: [
      { src: `/icon-${t}-32.png`, sizes: '32x32', type: 'image/png' },
      { src: `/icon-${t}-48.png`, sizes: '48x48', type: 'image/png' },
      { src: `/icon-${t}-64.png`, sizes: '64x64', type: 'image/png' },
      { src: `/icon-${t}-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `/icon-${t}-512.png`, sizes: '512x512', type: 'image/png' },
    ],
  }, null, 2);
}

function resolvePublicAsset(rootDir, pathname, { theme = 'dark' } = {}) {
  const root = path.resolve(rootDir);
  const t = normalizeIconTheme(theme);

  const staticTextMap = {
    '/': { file: path.join(root, 'public', 'index.html'), type: 'text/html; charset=utf-8' },
    '/index.html': { file: path.join(root, 'public', 'index.html'), type: 'text/html; charset=utf-8' },
    '/styles.css': { file: path.join(root, 'public', 'styles.css'), type: 'text/css; charset=utf-8' },
    '/app.js': { file: path.join(root, 'public', 'app.js'), type: 'application/javascript; charset=utf-8' },
    '/i18n.js': { file: path.join(root, 'public', 'i18n.js'), type: 'application/javascript; charset=utf-8' },
    '/charts.js': { file: path.join(root, 'public', 'charts.js'), type: 'application/javascript; charset=utf-8' },
  };
  if (staticTextMap[pathname]) return staticTextMap[pathname];

  if (pathname === '/manifest.webmanifest') {
    return {
      body: Buffer.from(buildManifestJson(t), 'utf8'),
      type: 'application/manifest+json; charset=utf-8',
    };
  }

  const lightAssets = getThemeAssetPaths(root, 'light');
  const darkAssets = getThemeAssetPaths(root, 'dark');
  const activeAssets = t === 'light' ? lightAssets : darkAssets;

  const iconMap = {
    '/icon.svg': { file: activeAssets.svg, type: 'image/svg+xml' },
    '/icon-32.png': { file: activeAssets.png32, type: 'image/png' },
    '/icon-48.png': { file: activeAssets.png48, type: 'image/png' },
    '/icon-64.png': { file: activeAssets.png64, type: 'image/png' },
    '/icon-192.png': { file: activeAssets.png192, type: 'image/png' },
    '/icon-512.png': { file: activeAssets.png512, type: 'image/png' },
    '/favicon.ico': { file: activeAssets.ico, type: 'image/x-icon' },
    '/icon-light.svg': { file: lightAssets.svg, type: 'image/svg+xml' },
    '/icon-dark.svg': { file: darkAssets.svg, type: 'image/svg+xml' },
    '/icon-light-32.png': { file: lightAssets.png32, type: 'image/png' },
    '/icon-dark-32.png': { file: darkAssets.png32, type: 'image/png' },
    '/icon-light-48.png': { file: lightAssets.png48, type: 'image/png' },
    '/icon-dark-48.png': { file: darkAssets.png48, type: 'image/png' },
    '/icon-light-64.png': { file: lightAssets.png64, type: 'image/png' },
    '/icon-dark-64.png': { file: darkAssets.png64, type: 'image/png' },
    '/icon-light-192.png': { file: lightAssets.png192, type: 'image/png' },
    '/icon-dark-192.png': { file: darkAssets.png192, type: 'image/png' },
    '/icon-light-512.png': { file: lightAssets.png512, type: 'image/png' },
    '/icon-dark-512.png': { file: darkAssets.png512, type: 'image/png' },
    '/favicon-light.ico': { file: lightAssets.ico, type: 'image/x-icon' },
    '/favicon-dark.ico': { file: darkAssets.ico, type: 'image/x-icon' },
  };

  return iconMap[pathname] || null;
}

module.exports = {
  normalizeIconTheme,
  getThemeAssetPaths,
  buildManifestJson,
  resolvePublicAsset,
};

'use strict';

// Управление токенами Antigravity: auth.json + авто-refresh через oauth2.googleapis.com.
// При отсутствии auth.json использует чистый Node.js экстрактор (lib/token_extract.js).
// Также поддерживает интерактивный вход через официальный Google OAuth 2.0 loopback flow.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { backupFile, writeFileAtomic, readJsonFile } = require('./safe_files');
const { autoExtract } = require('./token_extract');

const _bytesToStr = (b) => Buffer.from(b).toString('utf8');
const OAUTH_URL = () => process.env.AG_OAUTH_URL || 'https://oauth2.googleapis.com/token';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');
const CLIENT_ID = () => process.env.AG_CLIENT_ID || _bytesToStr([49,48,55,49,48,48,54,48,54,48,53,57,49,45,116,109,104,115,115,105,110,50,104,50,49,108,99,114,101,50,51,53,118,116,111,108,111,106,104,52,103,52,48,51,101,112,46,97,112,112,115,46,103,111,111,103,108,101,117,115,101,114,99,111,110,116,101,110,116,46,99,111,109]);
const CLIENT_SECRET = () => process.env.AG_CLIENT_SECRET || _bytesToStr([71,79,67,83,80,88,45,75,53,56,70,87,82,52,56,54,76,100,76,74,49,109,76,66,56,115,88,67,52,122,54,113,68,65,102]);

function decodeJwtEmail(idToken) {
  if (!idToken || typeof idToken !== 'string') return '';
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return '';
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email.trim() : '';
  } catch {
    return '';
  }
}

async function fetchGoogleUserEmail(accessToken, network = null) {
  if (!accessToken) return '';
  try {
    const req = {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(6000),
    };
    const res = network
      ? await network.fetch(OAUTH_USERINFO_URL, req, 'oauth')
      : await fetch(OAUTH_USERINFO_URL, req);
    if (!res.ok) return '';
    const j = await res.json().catch(() => null);
    return j && typeof j.email === 'string' ? j.email.trim() : '';
  } catch {
    return '';
  }
}

function autoExtractToken(authFile, { force = false } = {}) {
  try {
    const res = autoExtract({ force, outPath: authFile });
    return !!(res && res.ok && fs.existsSync(authFile));
  } catch {
    return false;
  }
}

function resolveWindowsDefaultBrowserCommand(safeUrl) {
  try {
    const uc = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
      { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const pm = uc.match(/ProgId\s+REG_SZ\s+([^\r\n]+)/i);
    if (!pm) return null;
    const progId = pm[1].trim();
    if (!progId || !/^[A-Za-z0-9._-]+$/.test(progId)) return null;
    const cmdOut = execFileSync(
      'reg',
      ['query', `HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`, '/ve'],
      { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const cm = cmdOut.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i);
    if (!cm) return null;
    let rawCmd = cm[1].trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
    let exe = '';
    let rest = '';
    if (rawCmd.startsWith('"')) {
      const endQ = rawCmd.indexOf('"', 1);
      if (endQ <= 1) return null;
      exe = rawCmd.slice(1, endQ);
      rest = rawCmd.slice(endQ + 1).trim();
    } else {
      const sp = rawCmd.indexOf(' ');
      exe = sp === -1 ? rawCmd : rawCmd.slice(0, sp);
      rest = sp === -1 ? '' : rawCmd.slice(sp + 1).trim();
    }
    if (!exe || !/\.exe$/i.test(exe) || !fs.existsSync(exe)) return null;
    const extraArgs = [];
    let replaced = false;
    if (rest) {
      const tokens = rest.match(/"[^"]*"|\S+/g) || [];
      for (const tok of tokens) {
        if (/^"?%1"?$/i.test(tok) || /^"?%l"?$/i.test(tok)) {
          extraArgs.push(safeUrl);
          replaced = true;
        } else {
          extraArgs.push(tok.replace(/^"|"$/g, ''));
        }
      }
    }
    if (!replaced) extraArgs.push(safeUrl);
    return {
      file: exe,
      args: extraArgs,
      options: { detached: true, stdio: 'ignore', windowsHide: false },
    };
  } catch {
    return null;
  }
}

function buildOpenExternalCommand(url, platform = process.platform, { preferDirectBrowser = true } = {}) {
  const safeUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(safeUrl)) {
    throw new Error('Only http/https URLs can be opened externally');
  }
  if (platform === 'win32') {
    if (preferDirectBrowser) {
      const direct = resolveWindowsDefaultBrowserCommand(safeUrl);
      if (direct) return direct;
    }
    // Fallback via PowerShell -EncodedCommand (UTF-16LE base64) so cmd.exe
    // never splits OAuth query strings at '&' characters.
    const psScript = `Start-Process -FilePath '${safeUrl.replace(/'/g, "''")}'`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      options: { detached: true, stdio: 'ignore', windowsHide: true },
    };
  }
  if (platform === 'darwin') {
    return { file: 'open', args: [safeUrl], options: { detached: true, stdio: 'ignore' } };
  }
  return { file: 'xdg-open', args: [safeUrl], options: { detached: true, stdio: 'ignore' } };
}

function openExternalUrl(url) {
  try {
    const cmd = buildOpenExternalCommand(url);
    const child = spawn(cmd.file, cmd.args, cmd.options);
    child.unref();
    return true;
  } catch (e) {
    console.warn('[oauth] openExternalUrl failed:', e.message);
    return false;
  }
}

let activeOAuthSession = null;

function getOAuthStatus() {
  if (!activeOAuthSession) return { active: false, status: 'idle', email: '', error: '' };
  return {
    active: activeOAuthSession.status === 'pending',
    status: activeOAuthSession.status,
    authUrl: activeOAuthSession.authUrl || '',
    email: activeOAuthSession.email || '',
    error: activeOAuthSession.error || '',
    startedAt: activeOAuthSession.startedAt,
  };
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const OAUTH_I18N = {
  ru: {
    cancelledTitle: 'Вход отменён',
    cancelledBody: (err) => `Google вернул ошибку: ${err}. Закройте вкладку и попробуйте снова.`,
    stateErrTitle: 'Ошибка проверки состояния',
    stateErrBody: 'Неверный OAuth state/code. Повторите вход из панели управления.',
    exchangeErrTitle: 'Ошибка обмена токена',
    noRefreshTitle: 'Не получен refresh_token',
    noRefreshBody: 'Google не вернул refresh_token (попробуйте ещё раз с подтверждением доступа).',
    okTitle: 'Авторизация успешна',
    okBody: (email) => `Аккаунт ${email} подключён к Antigravity API. Эту вкладку можно закрыть.`,
    authErrTitle: 'Ошибка авторизации',
    timeoutErr: 'Время ожидания входа в Google истекло (3 мин)',
  },
  en: {
    cancelledTitle: 'Sign-in Cancelled',
    cancelledBody: (err) => `Google returned an error: ${err}. You can close this tab and try again.`,
    stateErrTitle: 'State Verification Failed',
    stateErrBody: 'Invalid OAuth state or code. Please start sign-in again from the Control Panel.',
    exchangeErrTitle: 'Token Exchange Failed',
    noRefreshTitle: 'Missing refresh_token',
    noRefreshBody: 'Google did not return a refresh_token. Please sign in again and grant consent.',
    okTitle: 'Sign-in Successful',
    okBody: (email) => `Account ${email} is now connected to Antigravity API. You may close this tab.`,
    authErrTitle: 'Authentication Error',
    timeoutErr: 'Google sign-in timed out (3 min)',
  },
};

async function startInteractiveOAuth({ authFile, network = null, openBrowser = true, onSuccess = null, lang = '', theme = 'dark' } = {}) {
  if (activeOAuthSession && activeOAuthSession.server) {
    try { activeOAuthSession.server.close(); } catch {}
    if (activeOAuthSession.timer) clearTimeout(activeOAuthSession.timer);
  }

  const state = crypto.randomBytes(18).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const resolveLang = (acceptHeader = '') => {
    const explicit = String(lang || '').trim().toLowerCase();
    if (explicit === 'en' || explicit.startsWith('en-')) return 'en';
    if (explicit === 'ru' || explicit.startsWith('ru-')) return 'ru';
    if (/^en\b/i.test(String(acceptHeader || '').trim())) return 'en';
    return 'ru';
  };
  const isLight = String(theme || '').trim().toLowerCase() === 'light';

  const session = {
    status: 'pending',
    authUrl: '',
    email: '',
    error: '',
    startedAt: new Date().toISOString(),
    server: null,
    timer: null,
  };
  activeOAuthSession = session;

  const htmlPage = (langKey, title, body, ok = true) => `<!doctype html><html lang="${langKey}"><head><meta charset="utf-8"><title>${escHtml(title)} — Antigravity API</title>
<style>body{font-family:'Inter','Segoe UI',system-ui,sans-serif;background:${isLight ? '#eef3fb' : '#070b14'};color:${isLight ? '#0f172a' : '#f1f5f9'};display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
.box{position:relative;overflow:hidden;max-width:450px;width:100%;padding:30px 28px;border-radius:16px;background:${isLight ? '#ffffff' : 'linear-gradient(180deg,#121c33 0%,#0c1425 100%)'};border:1px solid ${ok ? 'rgba(52,211,153,.35)' : 'rgba(248,113,113,.35)'};box-shadow:0 18px 40px -10px rgba(2,6,23,${isLight ? '.12' : '.65'});text-align:center}
.box::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#ea4335 0%,#fbbc05 33%,#34a853 66%,#3182ff 100%)}
h2{margin:0 0 10px;font-size:20px;letter-spacing:-0.02em;color:${ok ? (isLight ? '#15803d' : '#34d399') : (isLight ? '#dc2626' : '#f87171')}}p{margin:0;color:${isLight ? '#52637a' : '#93a4bd'};line-height:1.55;font-size:14px}</style></head>
<body><div class="box"><h2>${escHtml(title)}</h2><p>${escHtml(body)}</p></div></body></html>`;

  const srv = http.createServer(async (req, res) => {
    const lk = resolveLang(req.headers['accept-language']);
    const tr = OAUTH_I18N[lk] || OAUTH_I18N.ru;
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/oauth-callback') {
        res.writeHead(404);
        return res.end('Not found');
      }
      const errParam = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const retState = u.searchParams.get('state');
      if (errParam) {
        session.status = 'error';
        session.error = `Google OAuth: ${errParam}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage(lk, tr.cancelledTitle, tr.cancelledBody(errParam), false));
        closeSession();
        return;
      }
      if (!code || retState !== state) {
        session.status = 'error';
        session.error = 'Invalid OAuth callback state';
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage(lk, tr.stateErrTitle, tr.stateErrBody, false));
        closeSession();
        return;
      }

      const redirectUri = `http://127.0.0.1:${srv.address().port}/oauth-callback`;
      const body = new URLSearchParams({
        client_id: CLIENT_ID(),
        client_secret: CLIENT_SECRET(),
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      const tokenReq = {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(25000),
      };
      if (network && typeof network.autoDetect === 'function') await network.autoDetect();
      const tokenRes = network
        ? await network.fetch(OAUTH_URL(), tokenReq, 'oauth')
        : await fetch(OAUTH_URL(), tokenReq);
      const tokenText = await tokenRes.text();
      if (!tokenRes.ok) {
        session.status = 'error';
        session.error = `Token exchange HTTP ${tokenRes.status}: ${tokenText.slice(0, 200)}`;
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage(lk, tr.exchangeErrTitle, session.error, false));
        closeSession();
        return;
      }
      const j = JSON.parse(tokenText);
      if (!j.refresh_token) {
        session.status = 'error';
        session.error = tr.noRefreshBody;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage(lk, tr.noRefreshTitle, session.error, false));
        closeSession();
        return;
      }

      const email = decodeJwtEmail(j.id_token) || await fetchGoogleUserEmail(j.access_token, network);
      const out = {
        type: 'antigravity',
        refresh_token: j.refresh_token,
        access_token: j.access_token || '',
        access_expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600) - 120,
        project_id: '',
        email: email || '',
        scope: j.scope || OAUTH_SCOPES,
        auth_source: 'google_oauth',
        updated_at: new Date().toISOString(),
      };
      fs.mkdirSync(path.dirname(authFile), { recursive: true });
      try { if (fs.existsSync(authFile)) backupFile(authFile); } catch {}
      writeFileAtomic(authFile, JSON.stringify(out, null, 2));
      if (process.platform !== 'win32') {
        try { fs.chmodSync(authFile, 0o600); } catch {}
      }

      session.status = 'completed';
      session.email = email || '';
      if (typeof onSuccess === 'function') {
        try { await onSuccess(out); } catch {}
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage(lk, tr.okTitle, tr.okBody(email || 'Google'), true));
      closeSession();
    } catch (e) {
      session.status = 'error';
      session.error = e.message || String(e);
      try {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage(lk, tr.authErrTitle, session.error, false));
      } catch {}
      closeSession();
    }
  });

  function closeSession() {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    if (session.server) {
      try { session.server.close(); } catch {}
      session.server = null;
    }
  }

  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  session.server = srv;
  session.timer = setTimeout(() => {
    if (session.status === 'pending') {
      const lk = resolveLang();
      session.status = 'timeout';
      session.error = (OAUTH_I18N[lk] || OAUTH_I18N.ru).timeoutErr;
    }
    closeSession();
  }, 180000);
  if (session.timer.unref) session.timer.unref();

  const redirectUri = `http://127.0.0.1:${srv.address().port}/oauth-callback`;
  const params = new URLSearchParams({
    client_id: CLIENT_ID(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'select_account consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  session.authUrl = `${OAUTH_AUTH_URL}?${params.toString()}`;
  const browserOpened = openBrowser ? openExternalUrl(session.authUrl) : false;

  return { ok: true, authUrl: session.authUrl, status: session.status, browserOpened };
}

class TokenManager {
  constructor(authFile, { network = null, allowMissing = true } = {}) {
    this.authFile = authFile;
    this.network = network;
    this.refreshing = null;
    this._emailPromise = null;
    this.refreshToken = '';
    this.accessToken = '';
    this.expiresAt = 0;
    this.projectId = '';
    this.email = '';
    this.authSource = '';
    this.reload({ allowMissing });
  }

  hasCredentials() {
    return !!this.refreshToken;
  }

  reload({ allowMissing = false, tryExtract = true } = {}) {
    if (!fs.existsSync(this.authFile)) {
      const extracted = tryExtract ? autoExtractToken(this.authFile, { force: false }) : false;
      if (!extracted || !fs.existsSync(this.authFile)) {
        this.refreshToken = '';
        this.accessToken = '';
        this.expiresAt = 0;
        this.projectId = '';
        this.email = '';
        this.authSource = '';
        if (allowMissing) return false;
        const err = new Error(
          `Файл авторизации ${path.basename(this.authFile)} не найден. ` +
          `Выполните вход через Google OAuth в веб-панели или извлеките токен из Antigravity.`
        );
        err.code = 'auth_missing';
        err.status = 503;
        throw err;
      }
    }

    const j = readJsonFile(this.authFile);
    this.refreshToken = j.refresh_token || '';
    this.accessToken = j.access_token || '';
    this.expiresAt = Number(j.access_expires_at || 0);
    this.projectId = j.project_id || '';
    this.email = j.email || '';
    this.authSource = j.auth_source || j.db_source || '';
    return true;
  }

  reloadFromDisk() {
    this.refreshing = null;
    this._emailPromise = null;
    return this.reload({ allowMissing: true, tryExtract: false });
  }

  #save(extra = {}) {
    let prev = {};
    try { prev = readJsonFile(this.authFile); } catch {}
    const j = {
      ...prev,
      type: 'antigravity',
      refresh_token: this.refreshToken,
      access_token: this.accessToken,
      access_expires_at: this.expiresAt,
      project_id: this.projectId,
      email: this.email,
      ...extra,
    };
    try { backupFile(this.authFile); } catch {}
    writeFileAtomic(this.authFile, JSON.stringify(j, null, 2));
    if (process.platform !== 'win32') {
      try { fs.chmodSync(this.authFile, 0o600); } catch {}
    }
  }

  get valid() {
    return this.accessToken && this.expiresAt > Date.now() / 1000 + 60;
  }

  async ensureEmail() {
    if (this.email || !this.hasCredentials()) return this.email;
    if (!this._emailPromise) {
      this._emailPromise = (async () => {
        try {
          const at = await this.getAccessToken();
          const email = await fetchGoogleUserEmail(at, this.network);
          if (email) {
            this.email = email;
            try { this.#save(); } catch {}
          }
          return this.email;
        } catch {
          return this.email;
        } finally {
          this._emailPromise = null;
        }
      })();
    }
    return this._emailPromise;
  }

  async getAccessToken() {
    if (!this.refreshToken) {
      const e = new Error('OAuth-токен Antigravity не найден (auth.json отсутствует). Войдите через Google OAuth в веб-панели или используйте web/* модели.');
      e.status = 503;
      e.code = 'auth_missing';
      throw e;
    }
    if (this.valid) return this.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.#refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async #refresh() {
    const body = new URLSearchParams({
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
    });
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    };
    const res = this.network
      ? await this.network.fetch(OAUTH_URL(), req, 'oauth')
      : await fetch(OAUTH_URL(), req);
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`OAuth refresh failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    const j = JSON.parse(text);
    if (j.refresh_token) this.refreshToken = j.refresh_token;
    this.accessToken = j.access_token;
    this.expiresAt = Math.floor(Date.now() / 1000) + (j.expires_in || 3600) - 120;
    const jwtEmail = decodeJwtEmail(j.id_token);
    if (jwtEmail) this.email = jwtEmail;
    else if (!this.email) {
      const fetched = await fetchGoogleUserEmail(this.accessToken, this.network);
      if (fetched) this.email = fetched;
    }
    try {
      this.#save({ scope: j.scope || undefined });
    } catch (e) {
      console.warn(`  ! Не удалось сохранить ${path.basename(this.authFile)}: ${e.message}`);
    }
    return this.accessToken;
  }

  summary() {
    return {
      configured: this.hasCredentials(),
      email: this.email || '(не указан)',
      hasRefreshToken: !!this.refreshToken,
      accessTokenValidForSec: this.hasCredentials() ? Math.max(0, Math.floor(this.expiresAt - Date.now() / 1000)) : 0,
      projectId: this.projectId || '(авто)',
      authSource: this.authSource || '',
    };
  }
}

module.exports = {
  TokenManager,
  CLIENT_ID,
  CLIENT_SECRET,
  OAUTH_URL,
  autoExtractToken,
  decodeJwtEmail,
  fetchGoogleUserEmail,
  buildOpenExternalCommand,
  startInteractiveOAuth,
  getOAuthStatus,
};

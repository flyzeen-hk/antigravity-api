'use strict';

// Управление токенами Antigravity: auth.json + авто-refresh через oauth2.googleapis.com.
// При отсутствии auth.json запускает автоматическое обнаружение и извлечение из базы Antigravity IDE.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeFileAtomic, readJsonFile } = require('./safe_files');

const _bytesToStr = (b) => Buffer.from(b).toString('utf8');
const OAUTH_URL = () => process.env.AG_OAUTH_URL || 'https://oauth2.googleapis.com/token';
const CLIENT_ID = () => process.env.AG_CLIENT_ID || _bytesToStr([49,48,55,49,48,48,54,48,54,48,53,57,49,45,116,109,104,115,115,105,110,50,104,50,49,108,99,114,101,50,51,53,118,116,111,108,111,106,104,52,103,52,48,51,101,112,46,97,112,112,115,46,103,111,111,103,108,101,117,115,101,114,99,111,110,116,101,110,116,46,99,111,109]);
const CLIENT_SECRET = () => process.env.AG_CLIENT_SECRET || _bytesToStr([71,79,67,83,80,88,45,75,53,56,70,87,82,52,56,54,76,100,76,74,49,109,76,66,56,115,88,67,52,122,54,113,68,65,102]);

function autoExtractToken(authFile) {
  const script = path.join(__dirname, '..', 'scripts', 'extract_token.py');
  if (!fs.existsSync(script)) return false;

  const pythonBins = [
    process.env.PYTHON || '',
    'python',
    'python3',
    'py',
  ].filter(Boolean);

  for (const py of pythonBins) {
    try {
      const res = spawnSync(py, [script], { encoding: 'utf8', timeout: 15000 });
      if (res.status === 0 && fs.existsSync(authFile)) {
        return true;
      }
    } catch {}
  }
  return false;
}

class TokenManager {
  constructor(authFile, { network = null } = {}) {
    this.authFile = authFile;
    this.network = network;
    this.refreshing = null;
    this.reload();
  }

  reload() {
    if (!fs.existsSync(this.authFile)) {
      // Пытаемся автоматически найти и извлечь токен из локальной IDE
      const extracted = autoExtractToken(this.authFile);
      if (!extracted || !fs.existsSync(this.authFile)) {
        throw new Error(
          `Файл авторизации ${path.basename(this.authFile)} не найден. ` +
          `Убедитесь, что Antigravity IDE установлена и выполните вход в аккаунт Google.`
        );
      }
    }

    const j = readJsonFile(this.authFile);
    this.refreshToken = j.refresh_token;
    this.accessToken = j.access_token || '';
    this.expiresAt = Number(j.access_expires_at || 0);
    this.projectId = j.project_id || '';
    this.email = j.email || '';
  }

  #save(extra = {}) {
    const j = {
      type: 'antigravity',
      refresh_token: this.refreshToken,
      access_token: this.accessToken,
      access_expires_at: this.expiresAt,
      project_id: this.projectId,
      email: this.email,
      ...extra,
    };
    writeFileAtomic(this.authFile, JSON.stringify(j, null, 2));
  }

  get valid() {
    return this.accessToken && this.expiresAt > Date.now() / 1000 + 60;
  }

  // возвращает актуальный access_token, обновляя при необходимости
  async getAccessToken() {
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
    if (j.refresh_token) this.refreshToken = j.refresh_token; // Google иногда ротирует
    this.accessToken = j.access_token;
    this.expiresAt = Math.floor(Date.now() / 1000) + (j.expires_in || 3600) - 120;
    // Токен уже получен и работает в памяти — сбой записи на диск не должен
    // превращать успешный refresh в ошибку запроса.
    try {
      this.#save({ scope: j.scope || undefined });
    } catch (e) {
      console.warn(`  ! Не удалось сохранить ${path.basename(this.authFile)}: ${e.message}`);
    }
    return this.accessToken;
  }

  // обезличенная сводка для статус-панели
  summary() {
    return {
      email: this.email || '(не указан)',
      hasRefreshToken: !!this.refreshToken,
      accessTokenValidForSec: Math.max(0, Math.floor(this.expiresAt - Date.now() / 1000)),
      projectId: this.projectId || '(авто)',
    };
  }
}

module.exports = { TokenManager, CLIENT_ID, CLIENT_SECRET, OAUTH_URL, autoExtractToken };

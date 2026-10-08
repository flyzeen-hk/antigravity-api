#!/usr/bin/env node
'use strict';

/*
 * Antigravity API — превращает аккаунт Antigravity (IDE) в полноценный
 * OpenAI-совместимый API-сервер с моделями твоего аккаунта:
 *   Gemini 3.x (Pro/Flash), Claude Opus/Sonnet 4.6, GPT-OSS 120B и др.
 *
 *   GET  /v1/models                    — список моделей (OpenAI-формат)
 *   POST /v1/chat/completions          — чат (OpenAI-формат, стрим и нет)
 *   GET  /v1beta/models                — список моделей (Gemini-формат)
 *   POST /v1beta/models/{m}:generateContent            — Gemini-формат
 *   POST /v1beta/models/{m}:streamGenerateContent      — Gemini-формат (SSE)
 *   POST /v1beta/models/{m}:countTokens
 *   GET  /_health, /_status, /         — статус
 *
 * Авторизация: свой API-ключ (apikey.txt), заголовок Authorization: Bearer <ключ>.
 * Апстрим: daily-cloudcode-pa.googleapis.com (бэкенд Antigravity, Cloud Code v1internal JSON).
 *
 * Без зависимостей. Node.js >= 18.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { TokenManager } = require('./lib/auth');
const { ModelCatalog } = require('./lib/models');
const { openAIToGeminiRequest, geminiToOpenAIResponse, GeminiStreamToOpenAI, sanitizeGeminiTools } = require('./lib/translate');
const { Guard, parseResetMs } = require('./lib/guard');

const ROOT = __dirname;

const DEFAULT_CONFIG = {
  port: 8317,
  host: '127.0.0.1', // '0.0.0.0' — доступ с других устройств локальной сети
  upstreamHost: 'https://daily-cloudcode-pa.googleapis.com',
  userAgent: 'antigravity/1.11.4',
  apiKey: '', // генерируется автоматически при первом запуске (apikey.txt)
  includeThoughts: false, // true — выдавать рассуждения моделей как reasoning_content
  requestTimeoutMs: 600000,
  retries: 2,
  // Опциональный Safe Mode guard (выключен по умолчанию, чтобы не создавать ложных блокировок)
  safeMode: {
    enabled: false,
    maxRequestsPerMinute: 60,
    maxRequestsPerHour: 600,
    maxRequestsPerDay: 3000,
    maxTokensPerDay: 50000000,
    minIntervalMs: 200,
    jitterMs: 100,
    maxConcurrent: 4,
    cooldownAfter429Ms: 30000,
    maxCooldownMs: 300000,
  },
};

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) {
    const cfg = { ...DEFAULT_CONFIG, apiKey: 'agk_' + crypto.randomBytes(24).toString('hex') };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    fs.writeFileSync(path.join(ROOT, 'apikey.txt'), cfg.apiKey + '\n');
    return { config: cfg, created: true };
  }
  const raw = readJson(file);
  const config = { ...DEFAULT_CONFIG, ...raw };
  if (!config.apiKey) {
    config.apiKey = 'agk_' + crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
  }
  if (!fs.existsSync(path.join(ROOT, 'apikey.txt'))) {
    fs.writeFileSync(path.join(ROOT, 'apikey.txt'), config.apiKey + '\n');
  }
  return { config, created: false };
}

// ---------- SSE ----------

async function* sseLines(stream) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      yield line;
    }
  }
  if (buf.trim()) yield buf;
}

async function* sseData(stream) {
  for await (const line of sseLines(stream)) {
    if (line.startsWith('data:')) yield line.slice(5).replace(/^ /, '');
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- вызов апстрима ----------

class Upstream {
  constructor(config, tokens, catalog) {
    this.config = config;
    this.tokens = tokens;
    this.catalog = catalog;
    this.refreshCount = 0;
    this.requestCount = 0;
  }

  headers(token) {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': this.config.userAgent,
    };
  }

  async generateContent(model, requestObj, { signal } = {}) {
    if (requestObj && requestObj.tools) {
      requestObj.tools = sanitizeGeminiTools(requestObj.tools);
    }
    const payload = { model, request: requestObj };
    if (this.tokens.projectId) payload.project = this.tokens.projectId;
    const token = await this.tokens.getAccessToken();
    this.requestCount++;
    return fetch(`${this.config.upstreamHost}/v1internal:generateContent?alt=sse`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(this.config.requestTimeoutMs),
    });
  }

  async countTokens(model, requestObj) {
    if (requestObj && requestObj.tools) {
      requestObj.tools = sanitizeGeminiTools(requestObj.tools);
    }
    const payload = { model, request: requestObj };
    if (this.tokens.projectId) payload.project = this.tokens.projectId;
    const token = await this.tokens.getAccessToken();
    this.requestCount++;
    return fetch(`${this.config.upstreamHost}/v1internal:countTokens`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
  }

  // генерация с одним автоматическим retry после refresh (401/403/смена токена)
  async generateWithRetry(model, requestObj) {
    let res = await this.generateContent(model, requestObj);
    if (res.status === 401 || res.status === 403) {
      // токен мог отозваться — принудительно обновим и попробуем ещё раз
      this.tokens.accessToken = '';
      this.tokens.expiresAt = 0;
      this.refreshCount++;
      res = await this.generateContent(model, requestObj);
    }
    return res;
  }

  // Информация об аккаунте (tier/проект/регион) — кэш 5 минут, best-effort.
  async getAccountInfo() {
    if (this._accInfo && Date.now() - this._accInfoAt < 300000) return this._accInfo;
    try {
      const token = await this.tokens.getAccessToken();
      const meta = {
        metadata: { ideType: 'ANTIGRAVITY', ideName: 'antigravity', ideVersion: '1.11.4' },
        cloudaicompanionProject: this.tokens.projectId || '',
      };
      const [tierRes, userRes] = await Promise.all([
        fetch(`${this.config.upstreamHost}/v1internal:loadCodeAssist`, {
          method: 'POST', headers: this.headers(token), body: JSON.stringify(meta), signal: AbortSignal.timeout(15000),
        }),
        fetch(`${this.config.upstreamHost}/v1internal:fetchUserInfo`, {
          method: 'POST', headers: this.headers(token), body: '{}', signal: AbortSignal.timeout(15000),
        }),
      ]);
      const tier = tierRes.ok ? await tierRes.json().catch(() => null) : null;
      const user = userRes.ok ? await userRes.json().catch(() => null) : null;
      this._accInfo = {
        tier: tier?.currentTier?.name ?? null,
        tierId: tier?.currentTier?.id ?? null,
        project: tier?.cloudaicompanionProject ?? null,
        region: user?.regionCode ?? null,
        fetchedAt: new Date().toISOString(),
      };
      this._accInfoAt = Date.now();
      return this._accInfo;
    } catch (e) {
      return { error: e.message, fetchedAt: new Date().toISOString() };
    }
  }

  // Реальная сводка официальных квот Google Cloud Code (retrieveUserQuotaSummary) — кэш 30 сек
  async getQuotaSummary() {
    if (this._quotaSummary && Date.now() - this._quotaSummaryAt < 30000) return this._quotaSummary;
    try {
      const token = await this.tokens.getAccessToken();
      const res = await fetch(`${this.config.upstreamHost}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers: this.headers(token),
        body: '{}',
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { error: `HTTP ${res.status}: ${text.slice(0, 100)}`, fetchedAt: new Date().toISOString() };
      }
      const data = await res.json();
      const groups = (data.groups || []).map((g) => ({
        name: g.group || '',
        displayName: g.displayName || g.group || '',
        description: g.description || '',
        buckets: (g.buckets || []).map((b) => ({
          bucketId: b.bucketId || '',
          displayName: b.displayName || '',
          window: b.window || '',
          remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
          remainingPercent: typeof b.remainingFraction === 'number' ? Math.round(b.remainingFraction * 1000) / 10 : null,
          resetTime: b.resetTime || null,
          description: b.description || '',
          disabled: !!b.disabled,
        })),
      }));
      this._quotaSummary = {
        raw: data,
        groups,
        description: data.description || '',
        fetchedAt: new Date().toISOString(),
      };
      this._quotaSummaryAt = Date.now();
      return this._quotaSummary;
    } catch (e) {
      return { error: e.message, fetchedAt: new Date().toISOString() };
    }
  }
}

// ---------- обработчики ----------

function start(config) {
  const authFile = process.env.AG_AUTH_FILE || path.join(ROOT, 'auth.json');
  if (!fs.existsSync(authFile)) {
    console.log(`\n  ! Не найден ${authFile} — сначала: python scripts\\extract_token.py\n`);
    process.exit(1);
  }
  const tokens = new TokenManager(authFile);
  const catalog = new ModelCatalog(config.upstreamHost, { project: tokens.projectId, userAgent: config.userAgent });
  const upstream = new Upstream(config, tokens, catalog);
  const guard = new Guard(config.safeMode || {}, process.env.AG_USAGE_FILE || path.join(ROOT, 'usage.json'));
  const log = [];
  const stats = { startedAt: new Date().toISOString(), requests: 0, errors: 0, blocked: 0 };

  const pushLog = (e) => {
    stats.requests++;
    if (e.error) stats.errors++;
    log.push({ ts: new Date().toISOString(), ...e });
    if (log.length > 200) log.shift();
    console.log(
      `  [${e.kind}] ${e.model || ''} ${e.status ?? ''} ${e.ms ?? ''}ms ${e.error ? 'ERR ' + e.error : 'OK'} ${e.quota ? '(' + e.quota + ')' : ''}`.trimEnd()
    );
  };

  const withRetry429 = async (fn) => {
    let attempt = 0;
    // 429 не ретраим мгновенно (квота) — только 5xx
    let res = await fn();
    while ([500, 502, 503, 504].includes(res.status) && attempt < config.retries) {
      attempt++;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      res = await fn();
    }
    return res;
  };

  // Обёртка «безопасного режима»: проверка лимитов → пауза → слот → работа → отчёт.
  async function guarded(res, model, kind, fn) {
    const ticket = await guard.acquire(model);
    if (!ticket.ok) {
      stats.blocked++;
      pushLog({ kind: 'guard', model, status: 429, error: ticket.reason.slice(0, 140) });
      res.writeHead(429, {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(ticket.retryAfterSec || 30),
      });
      res.end(JSON.stringify({ error: { message: ticket.reason, type: 'rate_limit_error', code: 429 } }));
      return null;
    }
    try {
      return await fn();
    } finally {
      ticket.release();
    }
  }

  const extractQuotaInfo = (text) => {
    try {
      const j = JSON.parse(text);
      const d = j.error?.details ?? [];
      for (const x of d) {
        const q = x.quotaResetDelay ?? x.retryDelay;
        if (q) return 'reset ' + q;
      }
      const m = j.error?.message?.match(/Resets in ([^."]+)/);
      if (m) return 'reset ' + m[1];
    } catch {}
    return '';
  };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024 * 1024) throw new Error('body too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function authOk(req) {
    const h = req.headers.authorization || '';
    return h === 'Bearer ' + config.apiKey;
  }

  function unauthorized(res) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: { message: 'Неверный API-ключ. Возьми его из apikey.txt', type: 'invalid_request_error' } }));
  }

  async function upstreamErrorToClient(res, upRes) {
    const text = (await upRes.text().catch(() => '')) || '';
    const quota = extractQuotaInfo(text);
    let out = text;
    try {
      const j = JSON.parse(text);
      const msg = j.error?.message || text;
      out = JSON.stringify({
        error: {
          message: `Antigravity upstream: ${msg}`,
          type: upRes.status === 429 ? 'rate_limit_error' : upRes.status >= 500 ? 'api_error' : 'invalid_request_error',
          code: upRes.status,
        },
      });
    } catch {}
    if (quota) pushLog({ kind: 'info', status: upRes.status, error: 'quota', quota });
    sendJson(res, upRes.status, JSON.parse(out));
  }

  // ---- OpenAI: /v1/chat/completions ----

  async function handleOpenAIChat(req, res) {
    const t0 = Date.now();
    const body = JSON.parse(await readBody(req));
    const model = String(body.model || 'gemini-3-flash');
    const stream = !!body.stream;
    const requestObj = openAIToGeminiRequest(body);

    return guarded(res, model, 'openai', async () => {
      const upRes = await withRetry429(() => upstream.generateWithRetry(model, requestObj));
      if (!upRes.ok) {
        const text = (await upRes.text().catch(() => '')) || '';
        if (upRes.status === 429) guard.report429(model, parseResetMs(text));
        const quota = extractQuotaInfo(text);
        pushLog({ kind: 'openai', model, status: upRes.status, ms: Date.now() - t0, error: text.slice(0, 160), quota });
        return upstreamErrorToClient(res, { status: upRes.status, text: async () => text });
      }

      if (!stream) {
        // агрегируем SSE-поток в один ответ
        const saw = [];
        for await (const data of sseData(upRes.body)) {
          if (!data || data === '[DONE]') continue;
          try {
            saw.push(JSON.parse(data));
          } catch {}
        }
        const out = aggregateGeminiChunks(saw, model);
        guard.reportUsage(out.usage?.total_tokens);
        pushLog({ kind: 'openai', model, status: 200, ms: Date.now() - t0 });
        sendJson(res, 200, out);
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const conv = new GeminiStreamToOpenAI(model, { includeThoughts: !!config.includeThoughts });
      try {
        for await (const data of sseData(upRes.body)) {
          for (const chunk of conv.pushData(data)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        for (const chunk of conv.finishChunks()) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch (e) {
        pushLog({ kind: 'openai', model, status: 502, ms: Date.now() - t0, error: 'stream: ' + e.message });
      }
      res.end();
      guard.reportUsage(conv.getUsageTokens());
      pushLog({ kind: 'openai', model, status: 200, ms: Date.now() - t0, stream: true });
    });
  }

  function aggregateGeminiChunks(chunks, model) {
    // chunks: массив {response:{candidates:[{content:{parts},finishReason}],usageMetadata},traceId}
    const parts = [];
    let finish = null;
    let usage = null;
    let traceId;
    for (const c of chunks) {
      const resp = c.response ?? c;
      if (c.traceId) traceId = c.traceId;
      const cand = resp.candidates?.[0] ?? {};
      for (const p of cand.content?.parts ?? []) {
        if (p.thought) continue;
        const last = parts[parts.length - 1];
        if (typeof p.text === 'string' && last && typeof last.text === 'string') last.text += p.text;
        else parts.push(p);
      }
      if (cand.finishReason) finish = cand.finishReason;
      if (resp.usageMetadata) usage = resp.usageMetadata;
    }
    const resp = {
      response: {
        candidates: [{ content: { parts, role: 'model' }, finishReason: finish ?? 'STOP', index: 0 }],
        usageMetadata: usage ?? {},
        modelVersion: model,
      },
      traceId,
    };
    return geminiToOpenAIResponse(resp, model);
  }

  // ---- Gemini-нативный API ----

  async function handleGeminiGenerate(req, res, model, method) {
    const t0 = Date.now();
    const body = JSON.parse((await readBody(req)) || '{}');
    const requestObj = body.request ?? body; // можно прислать и обёрнутый, и чистый GenerateContentRequest

    if (method === 'countTokens') {
      const upRes = await upstream.countTokens(model, requestObj);
      if (!upRes.ok) return upstreamErrorToClient(res, upRes);
      const j = await upRes.json();
      const inner = j.response ?? j;
      pushLog({ kind: 'gemini', model, status: 200, ms: Date.now() - t0, countTokens: true });
      return sendJson(res, 200, inner);
    }

    const stream = method === 'streamGenerateContent';
    return guarded(res, model, 'gemini', async () => {
      const upRes = await withRetry429(() => upstream.generateWithRetry(model, requestObj));
      if (!upRes.ok) {
        const text = (await upRes.text().catch(() => '')) || '';
        if (upRes.status === 429) guard.report429(model, parseResetMs(text));
        pushLog({ kind: 'gemini', model, status: upRes.status, ms: Date.now() - t0, error: text.slice(0, 160), quota: extractQuotaInfo(text) });
        return upstreamErrorToClient(res, { status: upRes.status, text: async () => text });
      }

      if (!stream) {
        const seen = [];
        for await (const data of sseData(upRes.body)) {
          if (data && data !== '[DONE]') {
            try {
              seen.push(JSON.parse(data));
            } catch {}
          }
        }
        const mergedResp = mergeGeminiResponse(seen);
        guard.reportUsage(mergedResp.usageMetadata?.totalTokenCount);
        pushLog({ kind: 'gemini', model, status: 200, ms: Date.now() - t0 });
        return sendJson(res, 200, mergedResp);
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      let lastUsage = null;
      for await (const data of sseData(upRes.body)) {
        if (!data || data === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        // разворачиваем обёртку {"response": ...} -> чистый Gemini-формат
        const inner = j.response ?? j;
        if (inner.usageMetadata) lastUsage = inner.usageMetadata;
        res.write(`data: ${JSON.stringify(inner)}\n\n`);
      }
      res.end();
      guard.reportUsage(lastUsage ? lastUsage.totalTokenCount ?? ((lastUsage.promptTokenCount ?? 0) + (lastUsage.candidatesTokenCount ?? 0)) : undefined);
      pushLog({ kind: 'gemini', model, status: 200, ms: Date.now() - t0, stream: true });
    });
  }

  function mergeGeminiResponse(chunks) {
    const parts = [];
    let finish = null;
    let usage = null;
    let modelVersion;
    for (const c of chunks) {
      const resp = c.response ?? c;
      const cand = resp.candidates?.[0] ?? {};
      modelVersion = resp.modelVersion ?? modelVersion;
      for (const p of cand.content?.parts ?? []) {
        const last = parts[parts.length - 1];
        if (typeof p.text === 'string' && last && typeof last.text === 'string') last.text += p.text;
        else parts.push(p);
      }
      if (cand.finishReason) finish = cand.finishReason;
      if (resp.usageMetadata) usage = resp.usageMetadata;
    }
    return {
      candidates: [{ content: { parts, role: 'model' }, finishReason: finish ?? 'STOP', index: 0, safetyRatings: [] }],
      usageMetadata: usage ?? {},
      modelVersion,
    };
  }

  async function listModelsOpenAI(res) {
    const models = await catalog.list(() => tokens.getAccessToken());
    const data = [...models.entries()].map(([id, m]) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'antigravity',
      display_name: m.displayName,
      context_length: m.maxTokens ?? undefined,
      max_completion_tokens: m.maxOutputTokens ?? undefined,
    }));
    sendJson(res, 200, { object: 'list', data });
  }

  async function listModelsGemini(res) {
    const models = await catalog.list(() => tokens.getAccessToken());
    sendJson(res, 200, {
      models: [...models.entries()].map(([id, m]) => ({
        name: `models/${id}`,
        displayName: m.displayName,
        description: `Antigravity: ${m.displayName}`,
        inputTokenLimit: m.maxTokens ?? undefined,
        outputTokenLimit: m.maxOutputTokens ?? undefined,
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
      })),
    });
  }

  // ---- статус-страница ----

  function statusPage() {
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const rows = log
      .slice()
      .reverse()
      .slice(0, 40)
      .map((r) => `<tr><td>${esc(r.ts?.slice(11, 19))}</td><td>${esc(r.kind)}</td><td>${esc(r.model || '')}</td><td>${esc(r.status ?? '')}</td><td>${esc(r.ms ?? '')}ms</td><td>${esc(r.quota || '')}</td><td>${esc(r.error || '')}</td></tr>`)
      .join('');
    let modelCount = 0;
    try {
      modelCount = catalog.cache ? catalog.cache.models.size : 0;
    } catch {}
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Antigravity API Dashboard</title><meta http-equiv="refresh" content="5">
<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#0b0c10;color:#f8fafc;margin:28px}h1{font-size:22px;color:#ffffff}h2{font-size:15px;color:#818cf8;margin-top:24px}
table{border-collapse:collapse;width:100%;font-size:13px;background:#141622}td,th{border:1px solid #23273c;padding:6px 10px;text-align:left}th{background:#1b1e2e;color:#94a3b8}code{color:#38bdf8}</style></head><body>
<h1>Antigravity API — Active</h1>
<p>Started: ${esc(stats.startedAt)} · Requests: ${stats.requests} · Errors: ${stats.errors} · Guard Blocks: ${stats.blocked} · Models: ${modelCount} · Token Refreshes: ${upstream.refreshCount}</p>
<p>Base URL: <code>http://127.0.0.1:${config.port}/v1</code> · Key File: <code>apikey.txt</code></p>
<h2>🛡 Guard Status (Optional)</h2>
<table>
<tr><th>Status</th><td>${guard.cfg.enabled ? 'Enabled' : 'Disabled (Direct upstream mode)'}</td></tr>
<tr><th>Requests Today</th><td>${guard.summary().requestsToday} ${guard.cfg.enabled ? '/ ' + guard.summary().limits.perDay : ''}</td></tr>
<tr><th>Tokens Today</th><td>${guard.summary().tokensToday} ${guard.cfg.enabled ? '/ ' + guard.summary().limits.tokensPerDay : ''}</td></tr>
<tr><th>Cooldown</th><td>${esc(JSON.stringify(guard.summary().cooldowns))}</td></tr>
</table>
<h2>Recent Requests (Last 40)</h2>
<table><tr><th>Time</th><th>Kind</th><th>Model</th><th>Status</th><th>Latency</th><th>Quota</th><th>Error</th></tr>${rows}</table>
</body></html>`;
  }

  // ---- маршрутизация ----

  async function handler(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
      if (p === '/_health') return sendJson(res, 200, { ok: true, uptime: process.uptime() });

      if (!authOk(req)) return unauthorized(res);

      if (p === '/' || p === '/_status') {
        const s = { startedAt: stats.startedAt, requests: stats.requests, errors: stats.errors, tokens: tokens.summary() };
        if (p === '/_status') return sendJson(res, 200, s);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(statusPage());
      }

      if (p === '/_limits' || p === '/_quota') {
        const serverQuotas = await upstream.getQuotaSummary();
        if (p === '/_quota') return sendJson(res, 200, serverQuotas);

        const account = await upstream.getAccountInfo();
        try {
          await catalog.list(() => tokens.getAccessToken()); // прогрев кэша моделей
        } catch {}
        const models = catalog.cache
          ? [...catalog.cache.models.entries()].map(([id, m]) => ({
              id,
              displayName: m.displayName,
              maxTokens: m.maxTokens,
              maxOutputTokens: m.maxOutputTokens,
              quota: m.quota,
            }))
          : null;
        return sendJson(res, 200, { local: guard.summary(), account, models, serverQuotas, config: { safeMode: guard.cfg } });
      }

      if (req.method === 'POST' && p === '/_config') {
        let parsed = {};
        try {
          const bodyStr = await readBody(req);
          parsed = JSON.parse(bodyStr || '{}');
        } catch {
          return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
        }
        if (parsed.safeMode && typeof parsed.safeMode === 'object') {
          guard.updateConfig(parsed.safeMode);
          config.safeMode = { ...(config.safeMode || {}), ...parsed.safeMode };
          const cfgPath = path.join(ROOT, 'config.json');
          try {
            const current = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
            current.safeMode = { ...(current.safeMode || {}), ...parsed.safeMode };
            fs.writeFileSync(cfgPath, JSON.stringify(current, null, 2));
          } catch (e) {
            console.error('Failed to save config.json:', e);
          }
        }
        return sendJson(res, 200, { ok: true, safeMode: guard.cfg });
      }

      if (req.method === 'GET' && p === '/v1/models') return await listModelsOpenAI(res);
      if (req.method === 'GET' && /^\/(v1beta|v1)\/models\/?$/.test(p)) return await listModelsGemini(res);

      const gm = p.match(/^\/(v1beta|v1)\/models\/([^:/]+?)(?::(generateContent|streamGenerateContent|countTokens))?$/);
      if (req.method === 'POST' && gm) {
        const model = decodeURIComponent(gm[2]);
        const method = gm[3] ?? 'generateContent';
        return await handleGeminiGenerate(req, res, model, method);
      }

      if (req.method === 'POST' && p === '/v1/chat/completions') return await handleOpenAIChat(req, res);

      sendJson(res, 404, { error: { message: `Нет пути ${p}. Доступно: /v1/chat/completions, /v1/models, /v1beta/models/{m}:generateContent` } });
    } catch (e) {
      stats.errors++;
      console.error('  [fatal]', req.method, p, e);
      if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
      else res.end();
    }
  }

  const server = http.createServer(handler);
  server.on('error', (e) => {
    console.error(`  ! Порт ${config.port}: ${e.message}`);
    if (e.code === 'EADDRINUSE') console.error('    Уже занят. Поменяй "port" в config.json.');
  });
  server.listen(config.port, config.host);

  return { server, tokens, catalog, upstream, config };
}

// ---------------------------------------------------------------- CLI

function main() {
  const cmd = process.argv[2];
  const { config, created } = loadConfig();

  if (cmd === 'key') {
    console.log(fs.readFileSync(path.join(ROOT, 'apikey.txt'), 'utf8').trim());
    return;
  }

  if (cmd === 'models') {
    const authFile = path.join(ROOT, 'auth.json');
    const tokens = new TokenManager(authFile);
    const catalog = new ModelCatalog(config.upstreamHost, { project: tokens.projectId, userAgent: config.userAgent });
    catalog
      .list(() => tokens.getAccessToken())
      .then((models) => {
        for (const [id, m] of models) console.log(`  ${id.padEnd(32)} ${m.displayName}`);
      })
      .catch((e) => {
        console.error(e.message);
        process.exit(1);
      });
    return;
  }

  if (cmd && cmd !== 'start') {
    console.log('Commands: start (default) | key (show API key) | models (list models)');
    return;
  }

  console.log(`
  ANTIGRAVITY API — OpenAI & Gemini Compatible Gateway
  ────────────────────────────────────────────────────────────────────────
  Base URL (OpenAI):   http://127.0.0.1:${config.port}/v1
  Base URL (Gemini):   http://127.0.0.1:${config.port}/v1beta
  API Key File:        apikey.txt (Key: ${config.apiKey.slice(0, 10)}...)
  Upstream Gateway:    ${config.upstreamHost}
  Web Dashboard:       http://127.0.0.1:${config.port}/
`);

  if (created) console.log('  Created config.json and apikey.txt (API key generated).\n');
  start(config);

  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();
module.exports = { start, loadConfig };

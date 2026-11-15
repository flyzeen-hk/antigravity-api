'use strict';

// Список моделей аккаунта Antigravity через v1internal:fetchAvailableModels
// с кэшем и извлечением официальных квот Google (remainingFraction и resetTime).
// Внутренние модели (tab_*, chat_*) скрываются.

const { fetchWithFallback } = require('./fetch_fallback');

// Public model IDs returned by the account catalog must remain selectable as-is.
const SKIP = new Set(['tab_flash_lite_preview', 'tab_jump_flash_lite_preview', 'chat_20706', 'chat_23310']);

class ModelCatalog {
  constructor(baseHost, { project = '', userAgent = 'antigravity/1.11.4', ttlMs = 5 * 60 * 1000, fallbackHost = '', network = null } = {}) {
    this.baseHost = baseHost;
    this.fallbackHost = fallbackHost;
    this.project = project;
    this.userAgent = userAgent;
    this.ttlMs = ttlMs;
    this.network = network;
    this.cache = null; // { at, models: Map, rawModels: Map }
  }

  async list(getAccessToken) {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.models;
    const token = await getAccessToken();
    const res = await fetchWithFallback(this.baseHost, this.fallbackHost, '/v1internal:fetchAvailableModels', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': this.userAgent,
      },
      body: JSON.stringify(this.project ? { project: this.project } : {}),
      signal: AbortSignal.timeout(30000),
    }, this.network ? (url, opts) => this.network.fetch(url, opts, 'models') : fetch);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(`fetchAvailableModels: HTTP ${res.status} ${text.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    const j = await res.json();
    const models = new Map();
    for (const [name, meta] of Object.entries(j.models || {})) {
      // -disabled — заглушки недоступных моделей (argon/carbon/hydrogen), не показываем.
      if (SKIP.has(name) || !meta || /-disabled$/i.test(name)) continue;
      const quota = meta.quotaInfo || {};
      const remainingFraction = typeof quota.remainingFraction === 'number' ? quota.remainingFraction : null;
      const resetTime = quota.resetTime || null;

      models.set(name, {
        displayName: meta.displayName || name,
        maxTokens: meta.maxTokens ?? null,
        maxOutputTokens: meta.maxOutputTokens ?? null,
        modelProvider: meta.modelProvider || '',
        quota: {
          remainingFraction,
          percent: remainingFraction !== null ? Math.round(remainingFraction * 1000) / 10 : null,
          resetTime,
        },
      });
    }
    this.cache = { at: Date.now(), models };
    return models;
  }

  // Сводка официальных квот Google по семействам моделей
  getQuotaSummary() {
    if (!this.cache || !this.cache.models) return null;
    const summary = {
      gemini: { percent: null, remainingFraction: null, resetTime: null, modelCount: 0 },
      claude: { percent: null, remainingFraction: null, resetTime: null, modelCount: 0 },
      gpt: { percent: null, remainingFraction: null, resetTime: null, modelCount: 0 },
      models: [],
    };

    for (const [id, m] of this.cache.models.entries()) {
      const q = m.quota || {};
      summary.models.push({
        id,
        displayName: m.displayName,
        percent: q.percent,
        resetTime: q.resetTime,
      });

      if (id.startsWith('gemini')) {
        summary.gemini.modelCount++;
        if (q.percent !== null && summary.gemini.percent === null) {
          summary.gemini.percent = q.percent;
          summary.gemini.remainingFraction = q.remainingFraction;
          summary.gemini.resetTime = q.resetTime;
        }
      } else if (id.startsWith('claude')) {
        summary.claude.modelCount++;
        if (q.resetTime && !summary.claude.resetTime) {
          summary.claude.resetTime = q.resetTime;
          summary.claude.percent = q.percent;
        }
      } else if (id.startsWith('gpt')) {
        summary.gpt.modelCount++;
        if (q.resetTime && !summary.gpt.resetTime) {
          summary.gpt.resetTime = q.resetTime;
          summary.gpt.percent = q.percent;
        }
      }
    }

    return summary;
  }

  invalidate() {
    this.cache = null;
  }
}

module.exports = { ModelCatalog, SKIP };

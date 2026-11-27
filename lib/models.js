'use strict';

// Список моделей аккаунта Antigravity через v1internal:fetchAvailableModels
// с кэшем, сохранением истории обнаруженных моделей (known_models.json),
// трекингом новых/удалённых/заблокированных по тарифу моделей и результатов health-check.

const fs = require('fs');
const path = require('path');
const { fetchWithFallback } = require('./fetch_fallback');
const { readJsonFile, writeFileAtomic } = require('./safe_files');

const SKIP = new Set(['tab_flash_lite_preview', 'tab_jump_flash_lite_preview', 'chat_20706', 'chat_23310']);
const NEW_BADGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function stripCloudPrefix(id) {
  return String(id || '').trim().replace(/^cloud\//i, '');
}

class ModelCatalog {
  constructor(baseHost, { project = '', userAgent = 'antigravity/1.11.4', ttlMs = 5 * 60 * 1000, fallbackHost = '', network = null, registryFile = '' } = {}) {
    this.baseHost = baseHost;
    this.fallbackHost = fallbackHost;
    this.project = project;
    this.userAgent = userAgent;
    this.ttlMs = ttlMs;
    this.network = network;
    this.registryFile = registryFile || '';
    this.cache = null;
    this.disabledModels = new Map();
    this.lastDiff = { added: [], removed: [], checkedAt: null };
    this.registry = this.#loadRegistry();
  }

  #loadRegistry() {
    if (!this.registryFile) return { models: {}, health: {}, updatedAt: null };
    try {
      const data = readJsonFile(this.registryFile);
      return {
        models: (data && typeof data.models === 'object' && !Array.isArray(data.models)) ? data.models : {},
        health: (data && typeof data.health === 'object' && !Array.isArray(data.health)) ? data.health : {},
        updatedAt: data && data.updatedAt ? data.updatedAt : null,
      };
    } catch {
      return { models: {}, health: {}, updatedAt: null };
    }
  }

  #saveRegistry() {
    if (!this.registryFile) return;
    try {
      this.registry.updatedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
      writeFileAtomic(this.registryFile, JSON.stringify(this.registry, null, 2));
    } catch {}
  }

  async list(getAccessToken, { force = false } = {}) {
    if (force) {
      if (this._refresh) return this._refresh;
      this._refresh = this._fetchModels(getAccessToken).finally(() => { this._refresh = null; });
      return this._refresh;
    }
    const fresh = this.cache && Date.now() - this.cache.at < this.ttlMs;
    if (fresh) return this.cache.models;
    if (this.cache && !this._refresh) {
      this._refresh = this._fetchModels(getAccessToken)
        .then((models) => models)
        .catch(() => null)
        .finally(() => { this._refresh = null; });
      return this.cache.models;
    }
    if (this._refresh) return this.cache ? this.cache.models : this._refresh;
    this._refresh = this._fetchModels(getAccessToken).finally(() => { this._refresh = null; });
    return this._refresh;
  }

  async _fetchModels(getAccessToken) {
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
    const disabled = new Map();
    const nowIso = new Date().toISOString();
    const prevKnown = this.registry.models || {};
    const hadBaseline = Object.keys(prevKnown).length > 0;
    const added = [];
    const removed = [];

    for (const [name, meta] of Object.entries(j.models || {})) {
      if (SKIP.has(name) || !meta) continue;
      const quota = meta.quotaInfo || {};
      const remainingFraction = typeof quota.remainingFraction === 'number' ? quota.remainingFraction : null;
      const resetTime = quota.resetTime || null;
      const isDisabled = /-disabled$/i.test(name) || meta.disabled === true;

      const entry = {
        displayName: meta.displayName || name,
        maxTokens: meta.maxTokens ?? null,
        maxOutputTokens: meta.maxOutputTokens ?? null,
        modelProvider: meta.modelProvider || '',
        recommended: !!meta.recommended,
        supportsThinking: meta.supportsThinking !== false,
        supportsImages: !!meta.supportsImages,
        disabled: isDisabled,
        tagTitle: meta.tagTitle || '',
        tagDescription: meta.tagDescription || '',
        quota: {
          remainingFraction,
          percent: remainingFraction !== null ? Math.floor(remainingFraction * 1000) / 10 : null,
          resetTime,
        },
      };

      if (isDisabled) {
        disabled.set(name, {
          ...entry,
          baseId: name.replace(/-disabled$/i, ''),
        });
        continue;
      }

      models.set(name, entry);

      const prev = prevKnown[name];
      if (!prev) {
        if (hadBaseline) added.push(name);
        prevKnown[name] = {
          id: name,
          displayName: entry.displayName,
          maxTokens: entry.maxTokens,
          maxOutputTokens: entry.maxOutputTokens,
          modelProvider: entry.modelProvider,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          inLiveCatalog: true,
          custom: false,
        };
      } else {
        if (prev.inLiveCatalog === false) added.push(name);
        prev.displayName = entry.displayName;
        prev.maxTokens = entry.maxTokens;
        prev.maxOutputTokens = entry.maxOutputTokens;
        prev.modelProvider = entry.modelProvider;
        prev.lastSeenAt = nowIso;
        prev.inLiveCatalog = true;
      }
    }

    for (const [name, rec] of Object.entries(prevKnown)) {
      if (rec.custom) continue;
      if (!models.has(name)) {
        if (rec.inLiveCatalog !== false) removed.push(name);
        rec.inLiveCatalog = false;
      }
    }

    this.disabledModels = disabled;
    this.lastDiff = { added, removed, checkedAt: nowIso };
    this.cache = { at: Date.now(), models };
    this.#saveRegistry();
    return models;
  }

  getCustomModels() {
    const out = [];
    for (const rec of Object.values(this.registry.models || {})) {
      if (rec && rec.custom) out.push(rec);
    }
    return out;
  }

  addCustomModel(rawId, displayName = '') {
    const id = stripCloudPrefix(rawId);
    if (!id || !/^[a-zA-Z0-9._:@/-]{2,120}$/.test(id)) {
      const e = new Error('Некорректный ID модели (используйте латиницу, цифры, -, _, .)');
      e.status = 400;
      throw e;
    }
    const nowIso = new Date().toISOString();
    const existing = this.registry.models[id];
    this.registry.models[id] = {
      ...(existing || {}),
      id,
      displayName: String(displayName || existing?.displayName || id).trim(),
      firstSeenAt: existing?.firstSeenAt || nowIso,
      lastSeenAt: nowIso,
      inLiveCatalog: this.cache && this.cache.models ? this.cache.models.has(id) : false,
      custom: true,
    };
    this.#saveRegistry();
    return this.registry.models[id];
  }

  removeCustomModel(rawId) {
    const id = stripCloudPrefix(rawId);
    const rec = this.registry.models[id];
    if (!rec) return false;
    if (rec.inLiveCatalog) {
      rec.custom = false;
    } else {
      delete this.registry.models[id];
    }
    this.#saveRegistry();
    return true;
  }

  recordHealth(fullModelId, result) {
    const key = String(fullModelId || '').trim();
    if (!key) return null;
    const entry = {
      status: result.status || 'error',
      httpStatus: result.httpStatus ?? null,
      ms: Number.isFinite(result.ms) ? Math.round(result.ms) : null,
      error: result.error ? String(result.error).slice(0, 200) : '',
      checkedAt: result.checkedAt || new Date().toISOString(),
    };
    this.registry.health[key] = entry;
    this.#saveRegistry();
    return entry;
  }

  getHealth(fullModelId) {
    return (this.registry.health && this.registry.health[fullModelId]) || null;
  }

  getAllHealth() {
    return { ...(this.registry.health || {}) };
  }

  getCatalogSnapshot() {
    const now = Date.now();
    const liveMap = (this.cache && this.cache.models) || new Map();
    const regModels = this.registry.models || {};

    const active = [];
    for (const [id, m] of liveMap.entries()) {
      const rec = regModels[id];
      const firstSeenMs = rec && rec.firstSeenAt ? Date.parse(rec.firstSeenAt) : 0;
      const isNew = this.lastDiff.added.includes(id) || (firstSeenMs > 0 && (now - firstSeenMs) < NEW_BADGE_WINDOW_MS && Object.keys(regModels).length > liveMap.size);
      active.push({
        id: `cloud/${id}`,
        rawId: id,
        provider: 'cloud',
        displayName: m.displayName || id,
        maxTokens: m.maxTokens ?? null,
        maxOutputTokens: m.maxOutputTokens ?? null,
        recommended: !!m.recommended,
        supportsThinking: m.supportsThinking !== false,
        supportsImages: !!m.supportsImages,
        quota: m.quota || null,
        inLiveCatalog: true,
        isNew,
        custom: !!(rec && rec.custom),
        firstSeenAt: rec?.firstSeenAt || null,
        health: this.getHealth(`cloud/${id}`),
      });
    }

    const custom = [];
    const removed = [];
    for (const [id, rec] of Object.entries(regModels)) {
      if (liveMap.has(id)) continue;
      const item = {
        id: `cloud/${id}`,
        rawId: id,
        provider: 'cloud',
        displayName: rec.displayName || id,
        maxTokens: rec.maxTokens ?? null,
        maxOutputTokens: rec.maxOutputTokens ?? null,
        inLiveCatalog: false,
        custom: !!rec.custom,
        removedFromCatalog: !rec.custom,
        firstSeenAt: rec.firstSeenAt || null,
        lastSeenAt: rec.lastSeenAt || null,
        health: this.getHealth(`cloud/${id}`),
      };
      if (rec.custom) custom.push(item);
      else removed.push(item);
    }

    const planLocked = [];
    for (const [id, m] of this.disabledModels.entries()) {
      planLocked.push({
        id: `cloud/${m.baseId || id}`,
        rawId: id,
        baseId: m.baseId || id,
        provider: 'cloud',
        displayName: m.displayName || id,
        maxTokens: m.maxTokens ?? null,
        maxOutputTokens: m.maxOutputTokens ?? null,
        disabled: true,
        tagTitle: m.tagTitle || 'Plan locked',
        tagDescription: m.tagDescription || '',
        health: this.getHealth(`cloud/${m.baseId || id}`),
      });
    }

    return {
      active,
      custom,
      removed,
      planLocked,
      diff: this.lastDiff,
      fetchedAt: this.cache ? new Date(this.cache.at).toISOString() : null,
    };
  }

  getQuotaSummary() {
    if (!this.cache || !this.cache.models) return null;
    const summary = {
      gemini: { percent: null, remainingFraction: null, resetTime: null, modelCount: 0 },
      claude: { percent: null, remainingFraction: null, resetTime: null, modelCount: 0 },
      gpt: { percent: null, remainingFraction: null, resetTime: null, modelCount: 0 },
      models: [],
    };

    const fillFamily = (bucket, q) => {
      bucket.modelCount++;
      if (q.percent !== null && bucket.percent === null) {
        bucket.percent = q.percent;
        bucket.remainingFraction = q.remainingFraction;
      }
      if (q.resetTime && !bucket.resetTime) {
        bucket.resetTime = q.resetTime;
      }
    };

    for (const [id, m] of this.cache.models.entries()) {
      const q = m.quota || {};
      summary.models.push({
        id,
        displayName: m.displayName,
        remainingPercent: q.percent ?? null,
        resetTime: q.resetTime || null,
      });

      const lo = id.toLowerCase();
      if (lo.includes('gemini')) fillFamily(summary.gemini, q);
      else if (lo.includes('claude')) fillFamily(summary.claude, q);
      else if (lo.includes('gpt')) fillFamily(summary.gpt, q);
    }
    return summary;
  }
}

module.exports = { ModelCatalog };

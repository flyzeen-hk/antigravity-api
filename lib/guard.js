'use strict';

/*
 * Guard — «безопасный режим» для защиты аккаунта от бана.
 *
 * Лимиты и учёт:
 *  - частота: в минуту / в час;
 *  - ДНЕВНЫЕ лимиты: запросов и токенов (сброс в 00:00 UTC);
 *  - НЕДЕЛЬНЫЕ лимиты: запросов и токенов за скользящие 7 дней;
 *  - история по дням (usage.json, 31 день) — для графика недели в панели;
 *  - минимальная пауза между запросами + джиттер;
 *  - ограничение параллельных генераций;
 *  - после 429 от Google — cooldown по семейству моделей (claude/gemini/gpt).
 */

const { readJsonFile, writeFileAtomic, backupFile } = require('./safe_files');

function todayKey(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('claude')) return 'claude';
  if (m.startsWith('gpt')) return 'gpt';
  return 'gemini';
}

// "Resets in 138h27m9s" -> мс
function parseResetMs(text) {
  const m = /Resets in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(String(text || ''));
  if (!m || (m[1] == null && m[2] == null && m[3] == null)) return null;
  const s = (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  return s > 0 ? s * 1000 : null;
}

class Guard {
  constructor(cfg = {}, stateFile) {
    this.cfg = {
      enabled: true,
      maxRequestsPerMinute: 8,
      maxRequestsPerHour: 50,
      maxRequestsPerDay: 300,
      maxTokensPerDay: 2_000_000,
      maxRequestsPerWeek: 1500,
      maxTokensPerWeek: 12_000_000,
      minIntervalMs: 2000,
      jitterMs: 750,
      maxConcurrent: 2,
      cooldownAfter429Ms: 15 * 60 * 1000,
      maxCooldownMs: 6 * 3600 * 1000,
      ...cfg,
    };
    this.stateFile = stateFile;
    this.#loadState();
    this.active = 0;
    this.waiters = [];
    this.lastLaunchAt = 0;
    this.minute = [];
    this.hour = [];
  }

  updateConfig(cfg = {}) {
    this.cfg = {
      ...this.cfg,
      ...cfg,
    };
    return this.cfg;
  }

  #loadState() {
    const today = todayKey();
    // 31 день истории
    this.state = { days: {}, cooldowns: {} };
    let j = null;
    try {
      j = readJsonFile(this.stateFile);
    } catch (e) {
      // Повреждённый usage.json не затираем молча — копия уходит в backups/*.corrupt.
      if (e.code !== 'ENOENT') {
        try { backupFile(this.stateFile, { suffix: '.corrupt', keep: 5 }); } catch {}
      }
    }
    if (j && typeof j === 'object') {
      if (j.days && typeof j.days === 'object') this.state.days = j.days;
      else if (j.day) {
        // миграция старого формата
        this.state.days[j.day] = { r: j.requestsToday || 0, t: j.tokensToday || 0 };
      }
      this.state.cooldowns = j.cooldowns || {};
    }
    if (!this.state.days[today]) this.state.days[today] = { r: 0, t: 0 };
    this.#prune();
    this.#saveState();
  }

  #prune() {
    const keys = Object.keys(this.state.days).sort();
    while (keys.length > 31) delete this.state.days[keys.shift()];
  }

  #saveState() {
    try {
      writeFileAtomic(this.stateFile, JSON.stringify(this.state), { fsync: false });
    } catch {}
  }

  #day(offset = 0) {
    const key = todayKey(offset);
    if (!this.state.days[key]) this.state.days[key] = { r: 0, t: 0 };
    return this.state.days[key];
  }

  #weekSum(field) {
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const d = this.state.days[todayKey(i)];
      if (d) sum += d[field] || 0;
    }
    return sum;
  }

  weekRequests() {
    return this.#weekSum('r');
  }

  weekTokens() {
    return this.#weekSum('t');
  }

  #history(days = 7) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = todayKey(i);
      const d = this.state.days[key] || { r: 0, t: 0 };
      out.push({ date: key, requests: d.r || 0, tokens: d.t || 0 });
    }
    return out;
  }

  #cooldownLeft(family) {
    const until = this.state.cooldowns[family] || 0;
    return Math.max(0, until - Date.now());
  }

  report429(model, resetMs) {
    const family = modelFamily(model);
    let ms = resetMs ?? this.cfg.cooldownAfter429Ms;
    ms = Math.min(ms || this.cfg.cooldownAfter429Ms, this.cfg.maxCooldownMs);
    this.state.cooldowns[family] = Date.now() + ms;
    this.#saveState();
    return ms;
  }

  reportUsage(tokens) {
    if (!tokens) return;
    this.#day().t += tokens;
    this.#prune();
    this.#saveState();
  }

  #slide(arr, windowMs, now) {
    while (arr.length && now - arr[0] > windowMs) arr.shift();
  }

  // Проверки без ожидания
  checkImmediate(model) {
    if (!this.cfg.enabled) return { ok: true };
    const family = modelFamily(model);
    const cd = this.#cooldownLeft(family);
    if (cd > 0) {
      return {
        ok: false,
        reason: `Локальная защита: семейство "${family}" на cooldown после 429 от Google — осталось ${Math.ceil(cd / 1000)} c.`,
        retryAfterSec: Math.ceil(cd / 1000),
      };
    }
    const day = this.#day();
    if (day.r >= this.cfg.maxRequestsPerDay) {
      return { ok: false, reason: `Локальная защита: дневной лимит запросов (${this.cfg.maxRequestsPerDay}) исчерпан — сброс в 00:00 UTC.`, retryAfterSec: 3600 };
    }
    if (day.t >= this.cfg.maxTokensPerDay) {
      return { ok: false, reason: `Локальная защита: дневной лимит токенов (${this.cfg.maxTokensPerDay}) исчерпан — сброс в 00:00 UTC.`, retryAfterSec: 3600 };
    }
    const weekR = this.weekRequests();
    const weekT = this.weekTokens();
    if (weekR >= this.cfg.maxRequestsPerWeek) {
      return { ok: false, reason: `Локальная защита: недельный лимит запросов (${this.cfg.maxRequestsPerWeek}) исчерпан.`, retryAfterSec: 6 * 3600 };
    }
    if (weekT >= this.cfg.maxTokensPerWeek) {
      return { ok: false, reason: `Локальная защита: недельный лимит токенов (${this.cfg.maxTokensPerWeek}) исчерпан.`, retryAfterSec: 6 * 3600 };
    }
    const now = Date.now();
    this.#slide(this.minute, 60_000, now);
    if (this.minute.length >= this.cfg.maxRequestsPerMinute) {
      return { ok: false, reason: `Локальная защита: превышен лимит ${this.cfg.maxRequestsPerMinute} запросов/мин.`, retryAfterSec: 60 };
    }
    this.#slide(this.hour, 3600_000, now);
    if (this.hour.length >= this.cfg.maxRequestsPerHour) {
      return { ok: false, reason: `Локальная защита: превышен лимит ${this.cfg.maxRequestsPerHour} запросов/час.`, retryAfterSec: 600 };
    }
    return { ok: true };
  }

  async #acquireSlot() {
    if (this.active < this.cfg.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  #releaseSlot() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }

  // Право на запрос: проверки + пауза + слот. { ok:false } | { ok:true, release }
  async acquire(model) {
    if (!this.cfg.enabled) {
      this.#day().r += 1;
      this.#saveState();
      return { ok: true, release: () => {} };
    }

    const immediate = this.checkImmediate(model);
    if (!immediate.ok) return immediate;

    const gap = this.cfg.minIntervalMs + Math.random() * this.cfg.jitterMs;
    const wait = Math.max(0, this.lastLaunchAt + gap - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const again = this.checkImmediate(model);
    if (!again.ok) return again;

    await this.#acquireSlot();

    const ts = Date.now();
    this.minute.push(ts);
    this.hour.push(ts);
    this.lastLaunchAt = ts;
    this.#day().r += 1;
    this.#prune();
    this.#saveState();

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#releaseSlot();
      },
    };
  }

  summary() {
    const cd = {};
    for (const [f, until] of Object.entries(this.state.cooldowns)) {
      const left = until - Date.now();
      if (left > 0) cd[f] = Math.ceil(left / 1000) + ' c';
    }
    const day = this.#day();
    return {
      enabled: this.cfg.enabled,
      requestsToday: day.r || 0,
      tokensToday: day.t || 0,
      week: { requests: this.weekRequests(), tokens: this.weekTokens() },
      days: this.#history(7),
      limits: {
        perMinute: this.cfg.maxRequestsPerMinute,
        perHour: this.cfg.maxRequestsPerHour,
        perDay: this.cfg.maxRequestsPerDay,
        tokensPerDay: this.cfg.maxTokensPerDay,
        perWeek: this.cfg.maxRequestsPerWeek,
        tokensPerWeek: this.cfg.maxTokensPerWeek,
        minIntervalMs: this.cfg.minIntervalMs,
        maxConcurrent: this.cfg.maxConcurrent,
      },
      cooldowns: cd,
      active: this.active,
    };
  }
}

module.exports = { Guard, modelFamily, parseResetMs, todayKey };

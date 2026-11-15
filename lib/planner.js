'use strict';

/*
 * Гибридный консультант ask_planner для cloud-агентского цикла.
 *
 * Исполнитель — надёжная cloud-модель (нативные tools, файлы на ПК).
 * Консультант — веб-модель Gemini 4 (сильное мышление, но без инструментов).
 * Планировщик вызывается ТОЛЬКО по инициативе cloud-модели, отдаёт текст
 * (план/критику/совет) и не тратит квоту Cloud Code.
 */

const providers = require('./providers');

const DEFAULT_SETTINGS = {
  enabled: true,
  model: 'web/gemini-4-argon-thinking',
  maxCalls: 2,
  timeoutMs: 60000,
};

const PLANNER_TOOL_SPEC = {
  type: 'function',
  function: {
    name: 'ask_planner',
    description: 'Consult a Gemini Web model (Gemini 4) for a plan, a review or technical advice. The consultant only returns text: it cannot read/write files or run commands. Use it rarely, for complex tasks.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to ask the consultant.' },
        mode: {
          type: 'string',
          enum: ['plan', 'review', 'advice'],
          description: 'plan — propose ordered steps; review — critique the current approach/result; advice — answer a specific question.',
        },
        context: { type: 'string', description: 'Optional compact context: task, file list, code snippets, errors.' },
      },
      required: ['question', 'mode'],
    },
  },
};

const MODE_PROMPTS = {
  plan: 'Propose a concise ordered action plan (checklist) for the task. Cover architecture, file layout and pitfalls. Keep it under ~2000 characters.',
  review: 'Critique the current approach or result: find bugs, omissions and risks. Be specific, brief and constructive.',
  advice: 'Answer the question with concrete technical advice. Be brief and actionable.',
};

function createPlanner({ bridge, settings } = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const parsed = providers.parseModel(cfg.model);
  const configured = !!(parsed.ok && parsed.namespace === providers.WEB);
  const stats = {
    enabled: configured && cfg.enabled !== false,
    model: parsed.ok ? parsed.displayId : String(cfg.model || ''),
    calls: 0,
    errors: 0,
    ms: 0,
  };

  function available() {
    return stats.enabled && !!(bridge && bridge.enabled);
  }

  async function call(args = {}) {
    if (!available()) {
      return { ok: false, error: 'ask_planner недоступен: planner выключен или веб-мост недоступен.' };
    }
    const limit = Math.max(0, Number(cfg.maxCalls) || 0);
    if (stats.calls >= limit) {
      return { ok: false, error: `Лимит вызовов ask_planner на этот запрос исчерпан (${limit}). Продолжай сам.` };
    }
    const question = String(args.question || '').trim();
    if (!question) return { ok: false, error: 'question обязателен (непустая строка)' };
    const mode = ['plan', 'review', 'advice'].includes(args.mode) ? args.mode : 'advice';
    const context = typeof args.context === 'string' ? args.context.slice(0, 12000) : '';

    stats.calls++;
    const t0 = Date.now();
    const timeoutMs = Math.max(5000, Number(cfg.timeoutMs) || DEFAULT_SETTINGS.timeoutMs);
    let timer;
    try {
      const meta = bridge.getModelMeta(parsed.baseId);
      const prompt = [
        'You are a consultant for an autonomous file agent working on a Windows PC. The agent executes; you only think.',
        MODE_PROMPTS[mode],
        'Do NOT output tool calls, JSON tool blocks or file operations — only plan/review/advice text.',
        context ? `Context:\n${context}` : '',
        `Question:\n${question}`,
      ].filter(Boolean).join('\n\n');
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('planner timeout'), { code: 'planner_timeout' })), timeoutMs);
        if (timer.unref) timer.unref();
      });
      const text = await Promise.race([bridge.generate(prompt, meta.modelId, meta.thinkMode), timeout]);
      stats.ms += Date.now() - t0;
      return { ok: true, mode, advice: String(text || '').slice(0, 20000) };
    } catch (err) {
      stats.errors++;
      stats.ms += Date.now() - t0;
      const message = err.code === 'planner_timeout'
        ? `ask_planner: таймаут ${timeoutMs} мс`
        : `ask_planner: ${err.message}`;
      return { ok: false, error: message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { available, call, stats: () => ({ ...stats }), settings: cfg };
}

module.exports = { DEFAULT_SETTINGS, PLANNER_TOOL_SPEC, createPlanner };

'use strict';

/*
 * Бюджет рассуждений (thinking) для cloud-пути.
 *
 * Зачем: Gemini 3.x «думает» по умолчанию, и это главный источник задержки
 * на простых вопросах. Клиенты присылают reasoning_effort / thinking.budget_tokens,
 * но в generationConfig это никто не переводил.
 *
 * Почему за флагом: поддержка thinkingConfig зависит от апстрима Cloud Code.
 * По умолчанию мы не добавляем лишних полей, чтобы не получить 400 на аккаунтах,
 * где поле не поддержано (см. config.thinking.mapReasoningEffort).
 */

const EFFORT_BUDGET = {
  none: 0,
  minimal: 128,
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 24576,
};

function budgetFromRequest(body) {
  if (!body || typeof body !== 'object') return null;
  const thinking = body.thinking;
  if (thinking && typeof thinking === 'object') {
    const t = thinking.budget_tokens;
    if (Number.isFinite(Number(t))) return Math.max(0, Math.min(65536, Math.round(Number(t))));
    if (typeof thinking.type === 'string') {
      const byType = { enabled: 4096, disabled: 0 };
      if (thinking.type in byType) return byType[thinking.type];
    }
  }
  if (thinking === false) return 0;
  const effort = body.reasoning_effort;
  if (typeof effort === 'string' && effort in EFFORT_BUDGET) return EFFORT_BUDGET[effort];
  return null;
}

/*
 * Дописывает generationConfig.thinkingConfig, если:
 *  - клиент не прислал свой thinkingConfig (его никогда не перетираем);
 *  - config.thinking.mapReasoningEffort === true;
 *  - бюджет известен из запроса или config.thinking.defaultBudget.
 * Возвращает true, если поле добавлено (для лога/тестов).
 */
function applyThinkingConfig(requestObj, body, settings = {}) {
  if (!requestObj || typeof requestObj !== 'object') return false;
  if (settings.mapReasoningEffort !== true) return false;
  if (!requestObj.generationConfig || typeof requestObj.generationConfig !== 'object') {
    requestObj.generationConfig = {};
  }
  if (requestObj.generationConfig.thinkingConfig) return false;

  let budget = budgetFromRequest(body);
  if (budget == null && settings.defaultBudget != null) budget = settings.defaultBudget;
  if (budget == null) return false;

  requestObj.generationConfig.thinkingConfig = {
    thinkingBudget: Math.max(0, Math.min(65536, Math.round(budget))),
    includeThoughts: settings.includeThoughts === true,
  };
  return true;
}

module.exports = { EFFORT_BUDGET, budgetFromRequest, applyThinkingConfig };

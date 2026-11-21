'use strict';

// Anthropic Messages API <-> Gemini (Cloud Code) перевод.
//
// Зачем: Claude Code, Cline, Continue, Zed и прочие клиенты умеют ходить
// только в /v1/messages с x-api-key. Модели Claude в каталоге уже есть
// (cloud/claude-*), не хватало только протокола.
//
// Поддерживаем: system (строка и блоки), text/image/tool_use/tool_result
// в сообщениях, tools + tool_choice, max_tokens/temperature/top_p/top_k,
// stop_sequences, thinking, стрим и не-стрим.
// Сознательно нет: prompt caching (cache_control игнорируется), citations,
// batches — это отдельные эндпоинты Anthropic.

const { randomUUID } = require('crypto');

const MODEL_MAP = [
  [/^claude-opus-4/i, 'claude-opus-4'],
  [/^claude-sonnet-4/i, 'claude-sonnet-4'],
  [/^claude-3-7-sonnet/i, 'claude-3-7-sonnet'],
  [/^claude-3-5-sonnet/i, 'claude-3-5-sonnet'],
  [/^claude-3-5-haiku/i, 'claude-3-5-haiku'],
  [/^claude-3-opus/i, 'claude-3-opus'],
  [/^claude-3-haiku/i, 'claude-3-haiku'],
];

// Возвращает внутренний id модели (namespace/baseId разберёт providers.js)
// или null, если имя пустое.
function mapModel(raw) {
  const name = String(raw || '').trim();
  if (!name) return null;
  if (/^(cloud|web)\//.test(name)) return name;
  if (/^claude-?$/i.test(name)) return 'cloud/claude-sonnet-4-5';
  for (const [re] of MODEL_MAP) {
    if (re.test(name)) return 'cloud/' + name.replace(/-latest$/, '');
  }
  // Любой прочий claude-* отдаём как есть: если апстрим знает — сработает.
  if (/^claude/i.test(name)) return 'cloud/' + name;
  // Не-Claude тоже разрешаем: клиенты иногда зовут gpt-4o через /v1/messages.
  return name;
}

function textFromAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function imageBlockToPart(block) {
  const src = block && block.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    return { inlineData: { mimeType: src.media_type || 'image/png', data: src.data } };
  }
  if (src.type === 'url' && src.url) {
    // Gemini не принимает произвольные URL — отдаём ссылку текстом.
    return { text: '[image] ' + src.url };
  }
  return null;
}

function toolResultToPart(block, name) {
  const text = textFromAnthropicContent(block.content);
  const response = block.is_error === true ? { error: text || 'error' } : { result: text };
  return { functionResponse: { name: name || block.tool_use_id || 'tool', response } };
}

// messages[].content = string | [{type:'text'|'image'|'tool_use'|'tool_result'|...}]
function messagesToContents(messages) {
  const contents = [];
  const toolNames = new Map(); // tool_use_id -> name (нужно для functionResponse)
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || !msg.role) continue;
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }]
      : (Array.isArray(msg.content) ? msg.content : []);
    const parts = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        parts.push({ text: b.text });
      } else if (b.type === 'image') {
        const p = imageBlockToPart(b);
        if (p) parts.push(p);
      } else if (b.type === 'tool_use') {
        toolNames.set(b.id, b.name);
        parts.push({ functionCall: { name: b.name, args: b.input && typeof b.input === 'object' ? b.input : {} } });
      } else if (b.type === 'tool_result') {
        // У Gemini functionResponse зовётся по имени функции, не по id.
        parts.push(toolResultToPart(b, toolNames.get(b.tool_use_id)));
      } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
        parts.push({ text: b.thinking, thought: true });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

function toolsToGemini(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const decls = [];
  for (const t of tools) {
    if (!t || !t.name) continue;
    // У Anthropic схема — input_schema, у Gemini — parameters.
    const schema = t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : null;
    const decl = { name: t.name, description: String(t.description || '').slice(0, 1024) };
    if (schema) decl.parameters = cleanSchema(schema);
    decls.push(decl);
  }
  return decls.length ? [{ functionDeclarations: decls }] : null;
}

// Gemini не понимает $schema/additionalProperties и пр. — вычищаем, иначе
// апстрим отвечает 400 INVALID_ARGUMENT на схему от Claude Code.
function cleanSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 8) return undefined;
  const allowed = ['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'anyOf', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'default', 'example'];
  const out = {};
  for (const k of allowed) {
    if (schema[k] === undefined) continue;
    if (k === 'properties' && schema.properties && typeof schema.properties === 'object') {
      const props = {};
      for (const [name, sub] of Object.entries(schema.properties)) {
        const c = cleanSchema(sub, depth + 1);
        if (c) props[name] = c;
      }
      out.properties = props;
    } else if (k === 'items') {
      const c = cleanSchema(schema.items, depth + 1);
      if (c) out.items = c;
    } else if (k === 'anyOf' && Array.isArray(schema.anyOf)) {
      const arr = schema.anyOf.map((s) => cleanSchema(s, depth + 1)).filter(Boolean);
      if (arr.length) out.anyOf = arr;
    } else if (k === 'type') {
      // JSON Schema допускает ["string","null"] — Gemini ждёт одну строку.
      const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
      if (typeof t === 'string') out.type = t;
      if (Array.isArray(schema.type) && schema.type.includes('null')) out.nullable = true;
    } else {
      out[k] = schema[k];
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function toolChoiceToGemini(choice) {
  if (!choice) return null;
  if (choice.type === 'auto') return { mode: 'AUTO' };
  if (choice.type === 'any') return { mode: 'ANY' };
  if (choice.type === 'none') return { mode: 'NONE' };
  if (choice.type === 'tool' && choice.name) return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  return null;
}

// Основной перевод. Возвращает { requestObj, warnings }.
function anthropicToGeminiRequest(body) {
  const warnings = [];
  const req = { contents: messagesToContents(body.messages) };
  if (!req.contents.length) {
    throw Object.assign(new Error('messages: нужно хотя бы одно непустое сообщение'), { status: 400 });
  }

  const system = body.system;
  const sysText = typeof system === 'string' ? system
    : Array.isArray(system) ? system.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
  if (sysText) req.systemInstruction = { parts: [{ text: sysText }] };

  const gen = {};
  if (Number.isFinite(body.max_tokens) && body.max_tokens > 0) gen.maxOutputTokens = Math.min(65536, Math.round(body.max_tokens));
  if (typeof body.temperature === 'number') gen.temperature = Math.max(0, Math.min(2, body.temperature));
  if (typeof body.top_p === 'number') gen.topP = Math.max(0, Math.min(1, body.top_p));
  if (typeof body.top_k === 'number') gen.topK = Math.max(1, Math.round(body.top_k));
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    gen.stopSequences = body.stop_sequences.filter((s) => typeof s === 'string').slice(0, 4);
  }
  if (body.thinking && body.thinking.type === 'enabled') {
    const budget = Number(body.thinking.budget_tokens);
    gen.thinkingConfig = { includeThoughts: true };
    if (Number.isFinite(budget) && budget > 0) gen.thinkingConfig.thinkingBudget = Math.min(32768, Math.round(budget));
    // max_tokens должен быть больше бюджета размышлений, иначе апстрим ругается.
    if (gen.maxOutputTokens && gen.thinkingConfig.thinkingBudget >= gen.maxOutputTokens) {
      gen.maxOutputTokens = gen.thinkingConfig.thinkingBudget + 1024;
    }
  }
  if (Object.keys(gen).length) req.generationConfig = gen;

  const tools = toolsToGemini(body.tools);
  if (tools) req.tools = tools;
  const fc = toolChoiceToGemini(body.tool_choice);
  if (fc) req.toolConfig = { functionCallingConfig: fc };
  if (body.metadata && body.metadata.user_id) warnings.push('metadata.user_id игнорируется');

  return { requestObj: req, warnings };
}

const STOP_REASON = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  BLOCKLIST: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  SPII: 'refusal',
  MALFORMED_FUNCTION_CALL: 'end_turn',
  OTHER: 'end_turn',
  FINISH_REASON_UNSPECIFIED: 'end_turn',
};

function mapStopReason(finishReason, hasToolUse) {
  if (hasToolUse) return 'tool_use';
  return STOP_REASON[finishReason] || 'end_turn';
}

function usageToAnthropic(usage) {
  const u = usage || {};
  const out = {
    input_tokens: Number(u.promptTokenCount) || 0,
    output_tokens: Number(u.candidatesTokenCount) || 0,
  };
  if (u.cachedContentTokenCount) out.cache_read_input_tokens = Number(u.cachedContentTokenCount);
  return out;
}

// respWrapper: { response: { candidates: [...], usageMetadata }, traceId }
function geminiToAnthropicResponse(respWrapper, model, opts = {}) {
  const resp = (respWrapper && respWrapper.response) || respWrapper || {};
  const cand = (resp.candidates && resp.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const content = [];
  let hasToolUse = false;
  for (const p of parts) {
    if (typeof p.text === 'string' && p.text) {
      if (p.thought) content.push({ type: 'thinking', thinking: p.text, signature: '' });
      else content.push({ type: 'text', text: p.text });
    }
    if (p.functionCall && p.functionCall.name) {
      hasToolUse = true;
      content.push({
        type: 'tool_use',
        id: p.functionCall.id || ('toolu_' + randomUUID().replace(/-/g, '').slice(0, 24)),
        name: p.functionCall.name,
        input: p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {},
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const blocked = resp.promptFeedback && resp.promptFeedback.blockReason;
  return {
    id: opts.messageId || ('msg_' + randomUUID().replace(/-/g, '').slice(0, 24)),
    type: 'message',
    role: 'assistant',
    model: model || resp.modelVersion || 'claude',
    content,
    stop_reason: hasToolUse ? 'tool_use' : (blocked ? 'refusal' : mapStopReason(cand.finishReason)),
    stop_sequence: null,
    usage: usageToAnthropic(resp.usageMetadata),
  };
}

// ---------------------------------------------------------------------------
// стрим: Gemini-чанки -> события Anthropic (message_start ... message_stop)
// ---------------------------------------------------------------------------

class AnthropicStream {
  constructor(model, opts = {}) {
    this.model = model;
    this.includeThinking = opts.includeThinking !== false;
    this.messageId = opts.messageId || ('msg_' + randomUUID().replace(/-/g, '').slice(0, 24));
    this.blockIndex = -1;
    this.open = null; // 'text' | 'thinking' | null
    this.started = false;
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.finishReason = null;
    this.hasToolUse = false;
  }

  get usageTokens() {
    return this.usage.input_tokens + this.usage.output_tokens;
  }

  startMessage() {
    this.started = true;
    return [{
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.usage.input_tokens, output_tokens: 0 },
        },
      },
    }];
  }

  closeBlock() {
    if (this.open === null) return [];
    const idx = this.blockIndex;
    this.open = null;
    return [{ event: 'content_block_stop', data: { type: 'content_block_stop', index: idx } }];
  }

  openBlock(kind, block) {
    this.blockIndex += 1;
    this.open = kind;
    return [{ event: 'content_block_start', data: { type: 'content_block_start', index: this.blockIndex, content_block: block } }];
  }

  // resp — один Gemini-чанк (уже развёрнутый: {candidates, usageMetadata})
  push(resp) {
    const out = [];
    if (!this.started) out.push(...this.startMessage());
    if (resp && resp.usageMetadata) this.usage = usageToAnthropic(resp.usageMetadata);
    const cand = (resp && resp.candidates && resp.candidates[0]) || null;
    if (!cand) return out;
    if (cand.finishReason) this.finishReason = cand.finishReason;
    for (const p of (cand.content && cand.content.parts) || []) {
      if (typeof p.text === 'string' && p.text) {
        if (p.thought) {
          if (!this.includeThinking) continue;
          if (this.open !== 'thinking') {
            out.push(...this.closeBlock());
            out.push(...this.openBlock('thinking', { type: 'thinking', thinking: '', signature: '' }));
          }
          out.push({ event: 'content_block_delta', data: {
            type: 'content_block_delta', index: this.blockIndex,
            delta: { type: 'thinking_delta', thinking: p.text },
          } });
        } else {
          if (this.open !== 'text') {
            out.push(...this.closeBlock());
            out.push(...this.openBlock('text', { type: 'text', text: '' }));
          }
          out.push({ event: 'content_block_delta', data: {
            type: 'content_block_delta', index: this.blockIndex,
            delta: { type: 'text_delta', text: p.text },
          } });
        }
      }
      if (p.functionCall && p.functionCall.name) {
        this.hasToolUse = true;
        out.push(...this.closeBlock());
        const id = p.functionCall.id || ('toolu_' + randomUUID().replace(/-/g, '').slice(0, 24));
        out.push(...this.openBlock('tool_use', { type: 'tool_use', id, name: p.functionCall.name, input: {} }));
        const json = JSON.stringify(p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {});
        out.push({ event: 'content_block_delta', data: {
          type: 'content_block_delta', index: this.blockIndex,
          delta: { type: 'input_json_delta', partial_json: json },
        } });
        out.push(...this.closeBlock());
      }
    }
    return out;
  }

  finish() {
    const out = [];
    if (!this.started) out.push(...this.startMessage());
    out.push(...this.closeBlock());
    out.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: this.hasToolUse ? 'tool_use' : mapStopReason(this.finishReason), stop_sequence: null },
        // input_tokens дублируем здесь: message_start уходит до первого чанка,
        // когда апстрим ещё не прислал usageMetadata.
        usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens },
      },
    });
    out.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return out;
  }
}

// Оценка токенов для /v1/messages/count_tokens: у Anthropic это отдельный
// эндпоинт, и клиенты требуют его для подсчёта контекста. Оценка грубая
// (~3.5 символа на токен), но детерминированная и без обращения к апстриму.
function estimateTokens(body) {
  const parts = [];
  if (typeof body.system === 'string') parts.push(body.system);
  else if (Array.isArray(body.system)) parts.push(textFromAnthropicContent(body.system));
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    parts.push(textFromAnthropicContent(m && m.content));
    for (const b of Array.isArray(m && m.content) ? m.content : []) {
      if (b && b.type === 'tool_use' && b.input) parts.push(JSON.stringify(b.input));
    }
  }
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    parts.push(String((t && t.name) || '') + ' ' + String((t && t.description) || '') + ' ' + JSON.stringify((t && t.input_schema) || {}));
  }
  const chars = parts.join('\n').length;
  return Math.max(1, Math.round(chars / 3.5));
}

function formatSse(evt) {
  return 'event: ' + evt.event + '\ndata: ' + JSON.stringify(evt.data) + '\n\n';
}

module.exports = {
  mapModel,
  anthropicToGeminiRequest,
  geminiToAnthropicResponse,
  messagesToContents,
  toolsToGemini,
  cleanSchema,
  mapStopReason,
  usageToAnthropic,
  AnthropicStream,
  estimateTokens,
  formatSse,
};

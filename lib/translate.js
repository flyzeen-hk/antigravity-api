'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('./safe_files');

// Переводчик OpenAI /chat/completions <-> Gemini generateContent (формат Cloud Code v1internal).
// Ответ Cloud Code обёрнут: {"response": <GenerateContentResponse>, "traceId", "metadata"}.

// ---------- Кэш thought_signature для Gemini 3.x / Flash Thinking ----------
const SIG_FILE = process.env.AG_SIG_FILE || path.join(os.tmpdir(), 'ag_thought_signatures.json');
const signatureCache = new Map();
let latestGlobalSignature = null;
let persistTimer = null;
const MAX_CACHE_SIZE = 500;

function loadPersistedSignatures() {
  try {
    if (fs.existsSync(SIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(SIG_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'string') {
          signatureCache.set(k, v);
          latestGlobalSignature = v;
        }
      }
    }
  } catch {}
}
loadPersistedSignatures();

function persistSignaturesDebounced() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const obj = Object.fromEntries(signatureCache.entries());
      writeFileAtomic(SIG_FILE, JSON.stringify(obj), { fsync: false });
    } catch {}
  }, 500);
}

// Повторная запись ключа переносит его в конец Map — вытесняются действительно старые.
function rememberSignature(key, sig) {
  signatureCache.delete(key);
  signatureCache.set(key, sig);
}

function recordThoughtSignature(callId, fnName, args, sig) {
  if (!sig || typeof sig !== 'string') return;
  latestGlobalSignature = sig;
  if (callId) rememberSignature(callId, sig);
  if (fnName) {
    rememberSignature('fn:' + fnName, sig);
    if (args) {
      try {
        rememberSignature(fnName + ':' + JSON.stringify(args), sig);
      } catch {}
    }
  }
  while (signatureCache.size > MAX_CACHE_SIZE) {
    signatureCache.delete(signatureCache.keys().next().value);
  }
  persistSignaturesDebounced();
}

function getThoughtSignature(callId, fnName, args) {
  if (callId && signatureCache.has(callId)) {
    return signatureCache.get(callId);
  }
  if (fnName && args) {
    try {
      const key = fnName + ':' + JSON.stringify(args);
      if (signatureCache.has(key)) return signatureCache.get(key);
    } catch {}
  }
  if (fnName && signatureCache.has('fn:' + fnName)) {
    return signatureCache.get('fn:' + fnName);
  }
  return latestGlobalSignature;
}

// ---------- OpenAI -> Gemini (запрос) ----------

function parseDataUrl(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return m ? { mime: m[1], data: m[2] } : null;
}

function contentToParts(content) {
  // возвращает { textBits: [], images: [] }
  const textBits = [];
  const images = [];
  if (typeof content === 'string') {
    if (content) textBits.push(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) textBits.push(b.text);
      else if (b.type === 'image_url' && b.image_url?.url) {
        const d = parseDataUrl(b.image_url.url);
        if (d) images.push({ mimeType: d.mime, data: d.data });
      }
    }
  }
  return { textBits, images };
}

function sanitizeGeminiSchema(raw, { rootDefs = null, isRoot = false, refStack = [] } = {}) {
  if (!raw || typeof raw !== 'object') {
    return isRoot ? { type: 'object', properties: {} } : raw;
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => sanitizeGeminiSchema(item, { rootDefs, refStack }));
  }

  const defs = rootDefs || raw.$defs || raw.definitions || {};

  // Разрешаем $ref (часто генерируется Pydantic v2)
  if (typeof raw.$ref === 'string') {
    const refKey = raw.$ref.replace(/^#\/(\$defs|definitions)\//, '');
    if (defs[refKey]) {
      // Рекурсивную схему (дерево, связный список) Gemini не выразит — обрываем цикл.
      if (refStack.includes(refKey)) {
        const stub = { type: 'object' };
        if (typeof raw.description === 'string') stub.description = raw.description;
        return stub;
      }
      const merged = { ...defs[refKey], ...raw };
      delete merged.$ref;
      return sanitizeGeminiSchema(merged, { rootDefs: defs, isRoot, refStack: [...refStack, refKey] });
    }
  }

  // Обработка anyOf / oneOf (например, Optional[T] в Python/Pydantic)
  if (Array.isArray(raw.anyOf) || Array.isArray(raw.oneOf)) {
    const list = raw.anyOf || raw.oneOf;
    const nonNull = list.filter((x) => x && x.type !== 'null');
    const hasNull = list.some((x) => x && x.type === 'null');
    if (nonNull.length === 1) {
      const merged = { ...nonNull[0], ...raw };
      delete merged.anyOf;
      delete merged.oneOf;
      if (hasNull) merged.nullable = true;
      return sanitizeGeminiSchema(merged, { rootDefs: defs, isRoot, refStack });
    }
  }

  // Белый список полей, поддерживаемых Protobuf-схемой Gemini / Cloud Code
  const ALLOWED_KEYS = new Set([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'properties',
    'required',
    'items',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
  ]);

  const cleaned = {};

  let rawType = raw.type;
  if (!rawType && (isRoot || raw.properties)) {
    rawType = 'object';
  }

  // Преобразуем type: ["string", "null"] -> type: "string", nullable: true
  if (Array.isArray(rawType)) {
    const nonNullType = rawType.find((t) => t !== 'null');
    if (nonNullType) {
      cleaned.type = String(nonNullType).toLowerCase();
      if (rawType.includes('null')) cleaned.nullable = true;
    } else {
      cleaned.type = 'string';
      cleaned.nullable = true;
    }
  } else if (typeof rawType === 'string') {
    cleaned.type = rawType.toLowerCase();
  }

  for (const [key, value] of Object.entries(raw)) {
    // Конвертируем exclusiveMinimum / exclusiveMaximum в minimum / maximum
    if (key === 'exclusiveMinimum' && typeof value === 'number') {
      cleaned.minimum = value;
      continue;
    }
    if (key === 'exclusiveMaximum' && typeof value === 'number') {
      cleaned.maximum = value;
      continue;
    }

    // Пропускаем $schema, $id, $defs, definitions, additionalProperties, title и др.
    if (!ALLOWED_KEYS.has(key)) {
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const cleanedProps = {};
      for (const [pKey, pVal] of Object.entries(value)) {
        cleanedProps[pKey] = sanitizeGeminiSchema(pVal, { rootDefs: defs, refStack });
      }
      cleaned.properties = cleanedProps;
    } else if (key === 'items' && value && typeof value === 'object') {
      cleaned.items = sanitizeGeminiSchema(value, { rootDefs: defs, refStack });
    } else if (key === 'required' && Array.isArray(value)) {
      cleaned.required = value.filter((r) => typeof r === 'string');
    } else if (key !== 'type') {
      cleaned[key] = value;
    }
  }

  if (isRoot) {
    if (!cleaned.type) cleaned.type = 'object';
    if (!cleaned.properties) cleaned.properties = {};
  }

  return cleaned;
}

function sanitizeGeminiTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const cleanTool = { ...tool };
    if (Array.isArray(cleanTool.functionDeclarations)) {
      cleanTool.functionDeclarations = cleanTool.functionDeclarations.map((fn) => {
        if (!fn || typeof fn !== 'object') return fn;
        return {
          ...fn,
          parameters: sanitizeGeminiSchema(fn.parameters || { type: 'object', properties: {} }, { isRoot: true }),
        };
      });
    }
    return cleanTool;
  });
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// functionResponse.response в Gemini — protobuf Struct: принимается только объект.
function toolResponseObject(content) {
  let value = Array.isArray(content) ? contentToParts(content).textBits.join('\n') : content;
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { result: value };
    }
  }
  return isPlainObject(value) ? value : { result: value };
}

// functionCall.args — тоже Struct; часть клиентов присылает arguments уже объектом.
function toolCallArgs(raw) {
  if (isPlainObject(raw)) return raw;
  if (raw == null || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed == null) return {};
      if (isPlainObject(parsed)) return parsed;
    } catch {}
  }
  return { _raw: raw };
}

function openAIToGeminiRequest(body, opts = {}) {
  const contents = [];
  const systemBits = [];
  const toolNameById = new Map();
  // Ответы на параллельные вызовы должны прийти одним user-ходом, иначе Gemini
  // отвечает 400 (число functionResponse не совпадает с числом functionCall).
  let toolTurn = null;

  for (const m of body.messages ?? []) {
    const role = m.role === 'assistant' ? 'model' : m.role === 'tool' ? 'user' : m.role === 'system' || m.role === 'developer' ? 'system' : 'user';
    if (role === 'system') {
      const { textBits } = contentToParts(m.content);
      if (textBits.length) systemBits.push(textBits.join('\n'));
      continue;
    }
    if (m.role === 'tool') {
      const part = {
        functionResponse: {
          name: toolNameById.get(m.tool_call_id) || m.tool_call_id || 'function',
          response: toolResponseObject(m.content),
        },
      };
      if (toolTurn) {
        toolTurn.parts.push(part);
      } else {
        toolTurn = { role, parts: [part] };
        contents.push(toolTurn);
      }
      continue;
    }
    toolTurn = null;
    const parts = [];
    const { textBits, images } = contentToParts(m.content);
    for (const t of textBits) parts.push({ text: t });
    for (const im of images) parts.push({ inlineData: { mimeType: im.mimeType, data: im.data } });
    let isFirstFc = true;
    for (const tc of m.tool_calls ?? []) {
      const args = toolCallArgs(tc.function?.arguments);
      const fnName = tc.function?.name ?? '';
      toolNameById.set(tc.id, fnName);
      const fcPart = { functionCall: { name: fnName, args } };

      const sig = tc.thought_signature || tc.thoughtSignature || getThoughtSignature(tc.id, fnName, args);
      if (isFirstFc && sig) {
        fcPart.thoughtSignature = sig;
        isFirstFc = false;
      }
      parts.push(fcPart);
    }
    if (parts.length) contents.push({ role, parts });
  }

  const req = {};
  if (contents.length) req.contents = contents;
  if (systemBits.length) req.systemInstruction = { parts: [{ text: systemBits.join('\n\n') }] };

  if (Array.isArray(body.tools) && body.tools.length) {
    const decls = [];
    for (const t of body.tools) {
      const fn = t.function ?? t;
      if (!fn?.name) continue;
      const cleanParams = sanitizeGeminiSchema(fn.parameters ?? { type: 'object', properties: {} }, { isRoot: true });
      decls.push({ name: fn.name, description: fn.description || '', parameters: cleanParams });
    }
    if (decls.length) {
      req.tools = [{ functionDeclarations: decls }];
      const tc = body.tool_choice;
      if (tc === 'none') req.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      else if (tc === 'required') req.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      else if (tc && typeof tc === 'object' && tc.function?.name) {
        req.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.function.name] } };
      }
    }
  }

  const gc = {};
  if (body.temperature != null) gc.temperature = body.temperature;
  if (body.top_p != null) gc.topP = body.top_p;
  // Новые клиенты OpenAI шлют max_completion_tokens вместо устаревшего max_tokens.
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens != null) gc.maxOutputTokens = maxTokens;
  if (body.stop) gc.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Object.keys(gc).length) req.generationConfig = gc;

  return req;
}

// ---------- Gemini -> OpenAI (ответ) ----------

const FILTER_REASONS = new Set([
  'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
  'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION',
]);

function mapFinish(reason, hasToolCalls) {
  if (hasToolCalls) return 'tool_calls';
  if (reason === 'MAX_TOKENS') return 'length';
  if (FILTER_REASONS.has(reason)) return 'content_filter';
  return 'stop';
}

// Без кандидатов и с promptFeedback.blockReason Google заблокировал сам запрос.
function promptBlocked(resp) {
  return !resp?.candidates?.length && !!resp?.promptFeedback?.blockReason;
}

// OpenAI считает рассуждения частью completion_tokens (с разбивкой в details);
// у Gemini они отдельно в thoughtsTokenCount — иначе prompt + completion ≠ total.
function mapUsage(um) {
  if (!um) return undefined;
  const thoughts = um.thoughtsTokenCount ?? 0;
  const completion = (um.candidatesTokenCount ?? 0) + thoughts;
  const prompt = um.promptTokenCount ?? 0;
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: um.totalTokenCount ?? prompt + completion,
  };
  if (um.cachedContentTokenCount) usage.prompt_tokens_details = { cached_tokens: um.cachedContentTokenCount };
  if (thoughts) usage.completion_tokens_details = { reasoning_tokens: thoughts };
  return usage;
}

function partsToMessage(parts) {
  let text = '';
  const reasoning = [];
  const toolCalls = [];
  let candidateSig = null;

  for (const p of parts ?? []) {
    if (p.thoughtSignature || p.thought_signature) {
      candidateSig = p.thoughtSignature || p.thought_signature;
    }
    if (p.thought && typeof p.text === 'string') {
      if (p.text) reasoning.push(p.text);
    } else if (typeof p.text === 'string') {
      text += p.text;
    } else if (p.functionCall) {
      const callId = p.functionCall.id || ('call_' + Math.random().toString(36).slice(2, 10));
      const fnName = p.functionCall.name ?? '';
      const sig = p.thoughtSignature || p.thought_signature || candidateSig;
      if (sig) {
        recordThoughtSignature(callId, fnName, p.functionCall.args, sig);
      }
      const tc = {
        id: callId,
        type: 'function',
        function: { name: fnName, arguments: JSON.stringify(p.functionCall.args ?? {}) },
      };
      if (sig) {
        tc.thought_signature = sig;
        tc.thoughtSignature = sig;
      }
      toolCalls.push(tc);
    }
  }
  return { text, reasoning, toolCalls };
}

function geminiToOpenAIResponse(respWrapper, model) {
  const resp = respWrapper.response ?? respWrapper; // на случай уже развёрнутого
  const cand = resp.candidates?.[0] ?? {};
  const { text, reasoning, toolCalls } = partsToMessage(cand.content?.parts);
  const message = { role: 'assistant', content: text || null };
  if (reasoning.length && text === '') message.reasoning_content = reasoning.join('\n');
  if (toolCalls.length) message.tool_calls = toolCalls;
  const finish = promptBlocked(resp) ? 'content_filter' : mapFinish(cand.finishReason, toolCalls.length > 0);
  const out = {
    id: 'chatcmpl-ag-' + (respWrapper.traceId ?? Date.now().toString(36)),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
  };
  const usage = mapUsage(resp.usageMetadata);
  if (usage) out.usage = usage;
  return out;
}

// ---------- Gemini SSE -> OpenAI SSE ----------

class GeminiStreamToOpenAI {
  constructor(model, { includeThoughts = false } = {}) {
    this.model = model;
    this.includeThoughts = includeThoughts;
    this.sawToolCall = false;
    this.blocked = false;
    this.finish = null;
    this.usage = null;
    this.started = false;
    this.lastStreamSig = null;
    this.id = 'chatcmpl-ag-' + Math.random().toString(36).slice(2, 8);
    this.created = Math.floor(Date.now() / 1000);
    this.toolCallIndex = 0;
  }

  #base(delta, finish = null) {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
  }

  pushData(data) {
    if (!data || data === '[DONE]') return [];
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return [];
    }
    const resp = j.response ?? j;
    const out = [];
    if (!this.started) {
      out.push(this.#base({ role: 'assistant', content: '' }));
      this.started = true;
    }
    const cand = resp.candidates?.[0] ?? {};
    for (const p of cand.content?.parts ?? []) {
      if (p.thoughtSignature || p.thought_signature) {
        this.lastStreamSig = p.thoughtSignature || p.thought_signature;
      }
      if (p.thought) {
        if (this.includeThoughts && p.text) out.push(this.#base({ reasoning_content: p.text }));
        continue;
      }
      if (typeof p.text === 'string' && p.text) {
        out.push(this.#base({ content: p.text }));
      } else if (p.functionCall) {
        this.sawToolCall = true;
        const callId = p.functionCall.id || ('call_' + Math.random().toString(36).slice(2, 10));
        const fnName = p.functionCall.name ?? '';
        const sig = p.thoughtSignature || p.thought_signature || this.lastStreamSig;
        if (sig) {
          recordThoughtSignature(callId, fnName, p.functionCall.args, sig);
        }
        const tc = {
          index: this.toolCallIndex++,
          id: callId,
          type: 'function',
          function: { name: fnName, arguments: JSON.stringify(p.functionCall.args ?? {}) },
        };
        if (sig) {
          tc.thought_signature = sig;
          tc.thoughtSignature = sig;
        }
        out.push(
          this.#base({
            tool_calls: [tc],
          })
        );
      }
    }
    if (cand.finishReason) {
      // финальный чанк с finish_reason + usage отдаём в finishChunks (один раз, как принято в OpenAI)
      this.finish = cand.finishReason;
    }
    if (promptBlocked(resp)) this.blocked = true;
    if (resp.usageMetadata) this.usage = resp.usageMetadata;
    return out;
  }

  finishChunks() {
    const reason = this.blocked && !this.sawToolCall ? 'content_filter' : mapFinish(this.finish ?? 'STOP', this.sawToolCall);
    const fin = this.#base({}, reason);
    const usage = mapUsage(this.usage);
    if (usage) fin.usage = usage;
    return [fin];
  }

  // суммарные токены последнего ответа (для учёта guard'а)
  getUsageTokens() {
    if (!this.usage) return undefined;
    return this.usage.totalTokenCount ?? (this.usage.promptTokenCount ?? 0) + (this.usage.candidatesTokenCount ?? 0);
  }
}

module.exports = {
  openAIToGeminiRequest,
  geminiToOpenAIResponse,
  GeminiStreamToOpenAI,
  mapFinish,
  mapUsage,
  sanitizeGeminiSchema,
  sanitizeGeminiTools,
  recordThoughtSignature,
  getThoughtSignature,
};

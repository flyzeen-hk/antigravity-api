'use strict';

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw requestError(`${name} must be a JSON object`);
  }
  return value;
}

function parseRequestBody(text) {
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    throw requestError('Invalid JSON body');
  }
  return assertObject(body, 'Request body');
}

function objectArray(value, name) {
  if (value == null) return;
  if (!Array.isArray(value)) throw requestError(`${name} must be an array`);
  for (const item of value) assertObject(item, `${name} item`);
}

function validateOpenAI(body) {
  if (typeof body.model !== 'string' || !body.model.trim()) {
    throw requestError('model is required: use cloud/<id> or web/<alias> from /v1/models');
  }
  objectArray(body.messages, 'messages');
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw requestError('messages must be a non-empty array');
  }
  objectArray(body.tools, 'tools');
  for (const message of body.messages || []) {
    if (message.content != null && typeof message.content !== 'string') {
      objectArray(message.content, 'message.content');
    }
    objectArray(message.tool_calls, 'message.tool_calls');
    for (const call of message.tool_calls || []) {
      if (call.function != null) assertObject(call.function, 'tool_call.function');
    }
  }
}

function validateGemini(body) {
  assertObject(body, 'Gemini request');
  objectArray(body.contents, 'contents');
  for (const content of body.contents || []) objectArray(content.parts, 'content.parts');
  const system = body.systemInstruction ?? body.system_instruction;
  if (system != null) {
    assertObject(system, 'systemInstruction');
    objectArray(system.parts, 'systemInstruction.parts');
  }
  objectArray(body.tools, 'tools');
}

// TextDecoder retains split UTF-8 characters between transport chunks.
async function* sseLines(stream) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  buf += dec.decode();
  if (buf) yield buf.replace(/\r$/, '');
}

async function* sseData(stream) {
  let data = [];
  for await (const line of sseLines(stream)) {
    if (line === '') {
      if (data.length) yield data.join('\n');
      data = [];
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length) yield data.join('\n');
}

function parseUpstreamData(data) {
  let value;
  try { value = JSON.parse(data); } catch {
    throw requestError('Antigravity upstream returned invalid JSON', 502);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw requestError('Antigravity upstream returned an invalid response', 502);
  }
  if (value.error || value.response?.error) {
    const error = value.error || value.response.error;
    throw requestError(`Antigravity upstream: ${error.message || 'generation failed'}`, 502);
  }
  return value;
}

function upstreamErrorBody(status, text) {
  let message = text || `HTTP ${status}`;
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || message;
  } catch {}
  // Google reports geo blocks as a plain 400; give clients a stable code instead of a bare number.
  const regional = /User location is not supported for the API use|location is not supported/i.test(message);
  if (regional) {
    return { error: {
      message: 'Antigravity upstream: user location is not supported for this API. Use a supported Google region or configure a proxy.',
      type: 'invalid_request_error',
      code: 'region_not_supported',
    } };
  }
  if (status === 404 && /Requested entity was not found/i.test(message)) {
    return { error: {
      message: 'Antigravity upstream: model not found for this account. Check the model id via /v1/models and the account/project access.',
      type: 'invalid_request_error',
      code: 'model_not_found',
    } };
  }
  return { error: {
    message: `Antigravity upstream: ${message}`,
    type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error',
    code: status,
  } };
}

function sendApiError(res, status, body, openAIStream = false) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    // Once SSE starts, the HTTP status is committed. Keep the same wire format.
    res.write(`data: ${JSON.stringify(body)}\n\n`);
    if (openAIStream) res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

module.exports = {
  requestError, assertObject, parseRequestBody, validateOpenAI, validateGemini,
  sseLines, sseData, parseUpstreamData, upstreamErrorBody, sendApiError,
};

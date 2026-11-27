'use strict';

const { sseData } = require('./http_helpers');
const { parseResetMs } = require('./guard');
const providers = require('./providers');

const publicErrors = new WeakSet();

function diagnosticError(status, code, message, stage, details = null) {
  const err = new Error(message);
  err.status = status;
  err.error = { code, message, stage, details };
  publicErrors.add(err);
  return err;
}

function normalizeDiagnosticError(err, { stage = 'upstream', bridge } = {}) {
  if (err && publicErrors.has(err)) return err;
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 ? err.status : null;
  const details = { ...(bridge === 'api' || bridge === 'web' ? { bridge } : {}), ...(status ? { httpStatus: status } : {}) };
  const text = typeof err?.message === 'string' ? err.message : '';
  const code = err?.code || err?.cause?.code;
  if (code === 'cloud_disabled') {
    return diagnosticError(400, 'cloud_disabled', 'Облачные модели отключены (AG_NO_CLOUD=1). Выберите модель web/* или уберите AG_NO_CLOUD.', 'routing', details);
  }
  if (code === 'auth_missing') {
    return diagnosticError(503, 'auth_missing', 'Токен Antigravity IDE (auth.json) не найден. Нажмите «Подключить токен IDE» или выберите модель web/*.', 'auth', details);
  }
  if (code === 'region_not_supported' || /User location is not supported for the API use/i.test(text) || /LOCATION_REJECTED|isn't available in your region/i.test(text)) {
    return diagnosticError(400, 'region_not_supported', 'Google отклонил выходной IP текущего подключения (LOCATION_REJECTED 1060) — регион не поддерживается. Выберите другой сервер прокси из поддерживаемого Google региона и повторите запрос; куки и аккаунт ни при чём.', 'upstream', details);
  }
  if (status === 401 || status === 403 || /invalid_grant|unauthenticated|permission_denied|OAuth refresh failed|invalid credentials|login required|sign.?in required/i.test(text)) {
    return diagnosticError(status === 403 ? 403 : 401, 'upstream_auth_failed', bridge === 'web'
      ? 'Google отклонил авторизацию веб-моста. Проверьте актуальность cookie с SAPISID в разделе Gemini Web и доступ выбранного Google-аккаунта к модели. Открытие браузера само по себе не настраивает cookie моста.'
      : 'Google отклонил авторизацию API. Повторно войдите в Antigravity IDE, обновите авторизацию приложения и проверьте доступ аккаунта к модели и проекту.', 'auth', details);
  }
  if (err?.code === 'web_empty_response') {
    return diagnosticError(502, 'empty_response', 'Google не вернул текст ответа. Проверьте доступ аккаунта к выбранной модели, обновите cookie веб-моста и повторите запрос.', 'response', details);
  }
  if (stage === 'auth') {
    return diagnosticError(502, 'token_refresh_failed', 'Не удалось получить или обновить авторизацию API. Проверьте вход в Antigravity IDE, файл авторизации и сетевой доступ к OAuth Google.', 'auth', details);
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|rate.limit|quota exceeded/i.test(text)) {
    return diagnosticError(429, 'upstream_rate_limited', 'Google ограничил частоту запросов или исчерпана квота модели. Проверьте квоты аккаунта и повторите запрос позже.', 'upstream', details);
  }
  if (status === 404 || /model.*(?:not found|not supported|unavailable)|unknown model/i.test(text)) {
    return diagnosticError(404, 'upstream_model_unavailable', 'Выбранная модель недоступна на этом пути. Обновите список /v1/models, проверьте режим API/web и доступ аккаунта.', 'routing', details);
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || status === 504 || /timed? ?out|timeout/i.test(text)) {
    return diagnosticError(504, 'upstream_timeout', 'Истекло время ожидания Google. Проверьте соединение, настройки прокси и повторите запрос; модель могла быть перегружена.', stage === 'routing' ? 'routing' : 'upstream', details);
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) || /fetch failed|connection failed|DNS|TLS|Proxy CONNECT|network|ECONN|ENOTFOUND/i.test(text)) {
    return diagnosticError(502, 'upstream_connection_failed', 'Не удалось соединиться с Google. Проверьте интернет, DNS, сертификаты и настройки прокси приложения.', stage === 'routing' ? 'routing' : 'upstream', details);
  }
  if (stage === 'routing') {
    return diagnosticError(502, 'model_catalog_unavailable', 'Не удалось получить каталог API-моделей. Проверьте авторизацию Antigravity, соединение с Google и обновите /v1/models.', 'routing', details);
  }
  if (stage === 'response') {
    return diagnosticError(502, 'invalid_upstream_response', 'Google вернул некорректный ответ. Повторите запрос; если ошибка сохраняется, проверьте доступность модели и совместимость веб-моста.', 'response', details);
  }
  if (status >= 500) {
    return diagnosticError(status, 'upstream_unavailable', 'Сервис Google временно недоступен или вернул серверную ошибку. Повторите запрос позже; если ошибка сохраняется, проверьте доступность API или актуальность веб-моста.', 'upstream', details);
  }
  return diagnosticError(status || 502, 'upstream_rejected', bridge === 'web'
    ? 'Веб-мост Google отклонил запрос. Проверьте доступ к модели на gemini.google.com, cookie аккаунта и актуальность веб-моста; повторите запрос позже.'
    : 'API Google отклонил запрос. Проверьте доступ аккаунта к модели, квоты и настройки проекта; повторите запрос позже.', 'upstream', details);
}

function validateDiagnosticRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw diagnosticError(400, 'invalid_body', 'Тело запроса должно быть JSON-объектом. Проверьте поля model, message и bridge и повторите запрос.', 'validation');
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    throw diagnosticError(400, 'model_required', 'Выберите модель из списка /v1/models: поле model должно содержать непустой идентификатор.', 'validation', { field: 'model' });
  }
  if (typeof body.message !== 'string' || !body.message.trim()) {
    throw diagnosticError(400, 'message_required', 'Введите непустое текстовое сообщение в поле message.', 'validation', { field: 'message' });
  }
  const bridge = body.bridge === undefined ? 'auto' : body.bridge;
  if (!['auto', 'api', 'web'].includes(bridge)) {
    throw diagnosticError(400, 'invalid_bridge', 'Поле bridge должно быть auto, api или web. Выберите один из этих режимов или уберите поле для автоматического выбора пути.', 'validation', { field: 'bridge' });
  }
  if (body.model.length > 256 || body.message.length > 100000) {
    throw diagnosticError(400, 'input_too_long', 'Слишком длинный запрос: идентификатор модели — до 256 символов, сообщение — до 100000 символов.', 'validation');
  }
  return { model: body.model.trim(), message: body.message, bridge, stream: body.stream === true };
}

async function executeDiagnosticChat(body, { catalog, tokens, upstream, webBridge, guard, cloudDisabled = false }, opts = {}) {
  const started = Date.now();
  const signal = opts.signal || null;
  const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;
  const input = validateDiagnosticRequest(body);
  const { message } = input;
  const parsedModel = providers.parseModel(input.model);
  if (!parsedModel.ok) {
    throw diagnosticError(400, parsedModel.code, parsedModel.message, 'validation',
      parsedModel.hint ? { examples: parsedModel.hint.examples } : null);
  }
  const model = parsedModel.baseId;
  const isWeb = parsedModel.namespace === providers.WEB;
  if (input.bridge === 'web' && !isWeb) {
    throw diagnosticError(400, 'model_not_supported_by_web', 'Поле bridge=web требует web-модель: используйте web/<alias> из /v1/models.', 'routing', { field: 'model', bridge: 'web' });
  }
  if (input.bridge === 'api' && isWeb) {
    throw diagnosticError(400, 'model_not_supported_by_api', 'Поле bridge=api требует cloud-модель: используйте cloud/<id> из /v1/models или bridge=web.', 'routing', { field: 'model', bridge: 'api' });
  }
  let bridge;
  let stage = 'routing';
  let ticket;
  try {
    let models;
    if (!isWeb) {
      if (cloudDisabled) {
        throw diagnosticError(400, 'cloud_disabled', 'Облачные модели отключены (AG_NO_CLOUD=1). Выберите модель web/* или уберите AG_NO_CLOUD.', 'routing', { bridge: 'api' });
      }
      if (typeof tokens.hasCredentials === 'function' && !tokens.hasCredentials()) {
        throw diagnosticError(503, 'auth_missing', 'Токен Antigravity IDE (auth.json) не найден. Нажмите «Подключить токен IDE» или выберите модель web/*.', 'auth', { bridge: 'api' });
      }
      let tokenFailure;
      try {
        models = await catalog.list(async () => {
          try { return await tokens.getAccessToken(); }
          catch (err) { tokenFailure = err; throw err; }
        });
      } catch (err) {
        throw normalizeDiagnosticError(err, { stage: tokenFailure ? 'auth' : 'routing', bridge: 'api' });
      }
    }
    if (isWeb) {
      bridge = 'web';
      if (!webBridge.enabled) {
        throw diagnosticError(400, 'web_bridge_disabled', 'Веб-мост выключен. Включите Gemini Web в настройках и обновите список моделей.', 'routing', { bridge });
      }
    } else {
      bridge = 'api';
      if (!models?.has(model)) {
        throw diagnosticError(404, 'model_not_available', 'Модель отсутствует в каталоге API-пути. Обновите /v1/models, проверьте идентификатор и namespace cloud/.', 'routing', { bridge });
      }
    }
    if (guard) {
      ticket = await guard.acquire(model);
      if (!ticket.ok) {
        throw diagnosticError(429, 'local_rate_limited', 'Запрос остановлен локальным Safe Mode. Проверьте лимиты в настройках и дождитесь окончания ограничения.', 'routing', { bridge });
      }
    }
    stage = 'upstream';
    let response = '';
    if (bridge === 'web') {
      const out = await webBridge.handleOpenAIChat({ model, messages: [{ role: 'user', content: message }], stream: false }, false, null, { signal });
      response = out?.choices?.[0]?.message?.content;
      if (onDelta && response) onDelta(response);
      guard?.reportUsage(out?.usage?.total_tokens);
    } else {
      stage = 'auth';
      await tokens.getAccessToken();
      stage = 'upstream';
      const upRes = await upstream.generateWithRetry(model, { contents: [{ role: 'user', parts: [{ text: message }] }] }, { signal });
      if (!upRes.ok) {
        const text = await upRes.text().catch(() => '');
        if (upRes.status === 429) guard?.report429(model, parseResetMs(text));
        throw normalizeDiagnosticError({ status: upRes.status, message: text }, { bridge });
      }
      stage = 'response';
      let usage;
      for await (const data of sseData(upRes.body)) {
        if (signal && signal.aborted) {
          const e = new Error('client disconnected');
          e.code = 'client_disconnected';
          throw e;
        }
        if (!data || data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { throw normalizeDiagnosticError(null, { stage, bridge }); }
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw normalizeDiagnosticError(null, { stage, bridge });
        const refusal = chunk.error || chunk.response?.error;
        if (refusal) {
          const status = Number.isInteger(refusal.code) ? refusal.code : undefined;
          throw normalizeDiagnosticError({ status, message: typeof refusal.message === 'string' ? refusal.message : '' }, { bridge });
        }
        const inner = chunk.response ?? chunk;
        const candidate = inner.candidates?.[0];
        if (inner.promptFeedback?.blockReason || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'RECITATION'].includes(candidate?.finishReason)) {
          throw diagnosticError(422, 'response_blocked', 'Google заблокировал ответ фильтром безопасности или ограничением контента. Измените формулировку сообщения и повторите запрос.', 'response', { bridge });
        }
        for (const part of candidate?.content?.parts || []) {
          if (!part.thought && typeof part.text === 'string') {
            response += part.text;
            if (onDelta && part.text) onDelta(part.text);
          }
        }
        if (inner.usageMetadata) usage = inner.usageMetadata.totalTokenCount;
      }
      guard?.reportUsage(usage);
    }
    if (typeof response !== 'string' || !response.trim()) {
      throw diagnosticError(502, 'empty_response', 'Google не вернул текст ответа. Проверьте доступ аккаунта к выбранной модели, попробуйте другое сообщение и повторите запрос.', 'response', { bridge });
    }
    return { ok: true, response, diagnostics: { model: input.model, bridge, durationMs: Math.max(0, Date.now() - started) } };
  } catch (err) {
    if (err && err.code === 'client_disconnected') throw err;
    throw normalizeDiagnosticError(err, { stage, bridge });
  } finally {
    if (ticket?.ok) ticket.release();
  }
}

module.exports = { diagnosticError, normalizeDiagnosticError, validateDiagnosticRequest, executeDiagnosticChat };

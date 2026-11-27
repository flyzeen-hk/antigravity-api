'use strict';

(function () {
  const { t, setLang, getLang, applyTranslations } = window.AGI18N;
  const { esc, fmtCompact, renderQuotaGauges, tickResetCountdowns, renderUsageChart, renderLiveTelemetry } = window.AGCharts;

  const state = {
    authenticated: false,
    supervised: false,
    activeTab: 'overview',
    theme: 'dark',
    status: null,
    config: null,
    limits: null,
    keys: { apiKey: '', adminKey: '' },
    usage: null,
    logs: [],
    installs: null,
    startup: null,
    backups: [],
    webAccounts: { activeAccount: '', accounts: [] },
    models: [],
    usageMetric: 'requests',
    usageDays: 14,
    modelFilter: 'all',
    webCookieMode: 'raw',
    snippetTab: 'curl',
    editingAccountName: '',
    chatHistory: [],
    chatAbort: null,
    chatLastUserMsg: '',
    uptimeBase: 0,
    uptimeSyncedAt: 0,
    es: null,
  };

  const $ = (id) => document.getElementById(id);

  function showToast(message, kind = 'info') {
    const root = $('toast-container');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = String(message || '');
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s';
      setTimeout(() => el.remove(), 220);
    }, 3600);
  }

  async function copyText(val) {
    const txt = String(val ?? '');
    if (!txt) return false;
    try {
      await navigator.clipboard.writeText(txt);
      showToast(t('actions.copied'), 'ok');
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast(t('actions.copied'), 'ok');
        return true;
      } catch {
        return false;
      } finally {
        ta.remove();
      }
    }
  }

  async function api(method, url, body = undefined, extraHeaders = {}) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: { ...extraHeaders },
    };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error((json && json.error && json.error.message) || json.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      err.retryAfter = Number(res.headers.get('retry-after')) || (json && json.retryAfterSec) || 0;
      if (res.status === 401 && url !== '/_auth/session') {
        handleUnauthorized();
      }
      throw err;
    }
    return json;
  }

  function applyTheme(theme) {
    const target = theme === 'light' ? 'light' : 'dark';
    state.theme = target;
    document.documentElement.setAttribute('data-theme', target);
    const btn = $('theme-btn');
    if (btn) btn.textContent = target === 'dark' ? '☾ Dark' : '☀ Light';
  }

  async function persistUiPref(patch) {
    if (!state.authenticated) return;
    try {
      await api('POST', '/_config', patch);
    } catch {}
  }

  function handleUnauthorized() {
    state.authenticated = false;
    closeEventStream();
    $('app-shell').classList.add('hidden');
    $('auth-screen').classList.remove('hidden');
  }

  function formatUptime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${r}s`;
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
  }

  function setStatusPill(kind) {
    const pill = $('live-status-pill');
    const txt = $('live-status-text');
    if (!pill || !txt) return;
    pill.className = `status-pill status-${kind}`;
    txt.textContent = t(`status.${kind}`);
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    for (const btn of document.querySelectorAll('.nav-item[data-tab]')) {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    }
    for (const sec of document.querySelectorAll('.tab-panel')) {
      sec.classList.toggle('active', sec.id === `tab-${tabName}`);
    }
    $('sidebar').classList.remove('mobile-open');
  }

  function askConfirm(title, message, okDanger = true) {
    return new Promise((resolve) => {
      $('confirm-title').textContent = title;
      $('confirm-message').textContent = message;
      const okBtn = $('confirm-ok-btn');
      okBtn.className = okDanger ? 'btn btn-danger' : 'btn btn-primary';
      const modal = $('confirm-modal');
      modal.classList.remove('hidden');

      const cleanup = (val) => {
        modal.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        $('confirm-cancel-btn').removeEventListener('click', onCancel);
        resolve(val);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      okBtn.addEventListener('click', onOk);
      $('confirm-cancel-btn').addEventListener('click', onCancel);
    });
  }

  // ---- Data Loading & SSE ----

  async function refreshModels() {
    if (!state.keys.apiKey) {
      try {
        const k = await api('GET', '/_keys');
        state.keys = k;
      } catch {}
    }
    try {
      const headers = state.keys.apiKey ? { authorization: `Bearer ${state.keys.apiKey}` } : {};
      const res = await api('GET', '/v1/models', undefined, headers);
      state.models = Array.isArray(res.data) ? res.data : [];
      $('nav-models-count').textContent = String(state.models.length);
      renderModels();
      populateChatModelSelect();
    } catch (e) {
      showToast(e.message, 'err');
    }
  }

  async function loadAllData() {
    const [statusR, configR, keysR, usageR, logsR, installsR, startupR, backupsR, accountsR] = await Promise.allSettled([
      api('GET', '/_status'),
      api('GET', '/_config'),
      api('GET', '/_keys'),
      api('GET', '/_usage'),
      api('GET', '/_logs'),
      api('GET', '/_installs'),
      api('GET', '/_startup'),
      api('GET', '/_backups'),
      api('GET', '/_web/accounts'),
    ]);

    if (statusR.status === 'fulfilled') {
      state.status = statusR.value;
      state.uptimeBase = Number(state.status.uptime) || 0;
      state.uptimeSyncedAt = Date.now();
    }
    if (configR.status === 'fulfilled') {
      state.config = configR.value;
      if (state.config.theme && state.config.theme !== 'system') applyTheme(state.config.theme);
      if (state.config.language && state.config.language !== getLang()) {
        setLang(state.config.language);
        applyTranslations();
        $('lang-btn').textContent = getLang().toUpperCase();
      }
    }
    if (keysR.status === 'fulfilled') state.keys = keysR.value;
    if (usageR.status === 'fulfilled') state.usage = usageR.value;
    if (logsR.status === 'fulfilled') state.logs = Array.isArray(logsR.value.logs) ? logsR.value.logs : [];
    if (installsR.status === 'fulfilled') state.installs = installsR.value;
    if (startupR.status === 'fulfilled') state.startup = startupR.value;
    if (backupsR.status === 'fulfilled') state.backups = Array.isArray(backupsR.value.backups) ? backupsR.value.backups : [];
    if (accountsR.status === 'fulfilled') state.webAccounts = accountsR.value;

    renderAll();

    await Promise.allSettled([
      refreshLimits(),
      refreshModels(),
    ]);
  }

  async function refreshLimits() {
    try {
      state.limits = await api('GET', '/_limits');
      renderLimitsAndAuth();
    } catch {}
  }

  function openEventStream() {
    closeEventStream();
    setStatusPill('connecting');
    const es = new EventSource('/_events');
    state.es = es;

    es.addEventListener('open', () => setStatusPill('online'));
    es.addEventListener('error', () => {
      if (!state.authenticated) return;
      setStatusPill(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
    });

    es.addEventListener('init', (ev) => {
      setStatusPill('online');
      try {
        const data = JSON.parse(ev.data);
        if (data.status) {
          state.status = data.status;
          state.uptimeBase = Number(data.status.uptime) || 0;
          state.uptimeSyncedAt = Date.now();
        }
        if (Array.isArray(data.logs)) state.logs = data.logs;
        renderOverviewKpis();
        renderLogsAndTelemetry();
      } catch {}
    });

    es.addEventListener('heartbeat', (ev) => {
      setStatusPill('online');
      try {
        const hb = JSON.parse(ev.data);
        if (state.status) {
          state.status.uptime = hb.uptime;
          state.status.requests = hb.requests;
          state.status.errors = hb.errors;
          state.status.blocked = hb.blocked;
          state.uptimeBase = Number(hb.uptime) || 0;
          state.uptimeSyncedAt = Date.now();
          renderOverviewKpis();
        }
      } catch {}
    });

    es.addEventListener('log', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.entry) {
          state.logs.unshift(data.entry);
          if (state.logs.length > 200) state.logs.length = 200;
        }
        if (data.stats && state.status) {
          state.status.requests = data.stats.requests;
          state.status.errors = data.stats.errors;
          state.status.blocked = data.stats.blocked;
          renderOverviewKpis();
        }
        renderLogsAndTelemetry();
      } catch {}
    });
  }

  function closeEventStream() {
    if (state.es) {
      try { state.es.close(); } catch {}
      state.es = null;
    }
  }

  // ---- Rendering ----

  function renderAll() {
    renderOverviewKpis();
    renderLimitsAndAuth();
    renderUsageSection();
    renderLogsAndTelemetry();
    renderInstalls();
    renderBackups();
    renderModels();
    renderWebSection();
    renderConnection();
    renderSettings();
    populateChatModelSelect();
    renderChatMessages();
  }

  function renderOverviewKpis() {
    const s = state.status;
    if (!s) return;
    $('sidebar-version').textContent = `v${s.version || '2.0.0'}`;
    $('sidebar-listen').textContent = `${s.host || '127.0.0.1'}:${s.port || 8317}`;
    $('sidebar-node').textContent = s.nodeVersion || '—';
    $('topbar-uptime').textContent = formatUptime(s.uptime || 0);

    $('kpi-requests').textContent = fmtCompact(s.requests || 0);
    const guardSum = state.usage && state.usage.summary;
    $('kpi-requests-sub').textContent = guardSum
      ? t('overview.todayUsage', { req: guardSum.requestsToday || 0, tok: fmtCompact(guardSum.tokensToday || 0) })
      : `port ${s.port || 8317}`;

    $('kpi-errors').textContent = `${s.errors || 0} / ${s.blocked || 0}`;
    $('kpi-errors-sub').textContent = s.supervised ? 'Supervised daemon' : 'Direct process';

    if (s.cloudDisabled) {
      $('kpi-cloud-status').innerHTML = `<span class="badge badge-warn">${esc(t('overview.cloudDisabled'))}</span>`;
      $('kpi-cloud-sub').textContent = 'AG_NO_CLOUD=1';
    } else if (s.cloudAuthReady && s.tokens && s.tokens.configured) {
      $('kpi-cloud-status').innerHTML = `<span class="badge badge-ok">${esc(t('overview.cloudActive'))}</span>`;
      $('kpi-cloud-sub').textContent = s.tokens.email || s.tokens.projectId || t('overview.tokenExpires', {
        sec: s.tokens.accessTokenValidForSec || 0, ref: s.tokenRefreshes || 0,
      });
    } else {
      $('kpi-cloud-status').innerHTML = `<span class="badge badge-neutral">${esc(t('overview.cloudMissing'))}</span>`;
      $('kpi-cloud-sub').textContent = 'Web-Only';
    }

    const gw = s.geminiWeb || {};
    const webOk = !!(gw.enabled && (gw.hasCookie || gw.cookieConfigured || gw.accountsCount > 0 || (state.config && state.config.geminiWeb && state.config.geminiWeb.cookieSet)));
    $('kpi-web-status').innerHTML = webOk
      ? `<span class="badge badge-ok">${esc(t('overview.webReady'))}</span>`
      : `<span class="badge badge-neutral">${esc(t('overview.webNotConfigured'))}</span>`;
    $('kpi-web-sub').textContent = gw.activeAccount ? `Active: ${gw.activeAccount}` : (gw.enabled ? 'Enabled' : 'Disabled');
  }

  function renderLimitsAndAuth() {
    const l = state.limits;
    renderQuotaGauges($('quota-gauges-root'), l, t);

    const acc = l && l.account;
    const metaEl = $('cloud-account-meta');
    if (acc && !acc.error) {
      const parts = [acc.tier || acc.tierId, acc.region, acc.project ? `project: ${acc.project}` : ''].filter(Boolean);
      metaEl.textContent = parts.join(' · ') || '—';
    } else if (state.status && state.status.tokens && state.status.tokens.configured) {
      metaEl.textContent = `${state.status.tokens.email || 'OAuth'} · ${t('overview.tokenExpires', {
        sec: state.status.tokens.accessTokenValidForSec || 0, ref: state.status.tokenRefreshes || 0,
      })}`;
    } else {
      metaEl.textContent = (l && l.modelsError) || t('overview.cloudMissing');
    }

    const g = (l && l.local) || (state.usage && state.usage.summary);
    const bar = $('guard-summary-bar');
    if (!g) { bar.innerHTML = ''; return; }
    const lim = g.limits || {};
    const chips = [
      `<span class="badge ${g.enabled ? 'badge-ok' : 'badge-neutral'}">${esc(t(g.enabled ? 'overview.guardOn' : 'overview.guardOff'))}</span>`,
      `<span class="badge badge-neutral">${esc(t('overview.todayUsage', { req: g.requestsToday || 0, tok: fmtCompact(g.tokensToday || 0) }))}</span>`,
      `<span class="badge badge-neutral">${esc(t('overview.weekUsage', { req: (g.week && g.week.requests) || 0, tok: fmtCompact((g.week && g.week.tokens) || 0) }))}</span>`,
    ];
    if (lim.perMinute) chips.push(`<span class="muted">RPM ${lim.perMinute} · Day ${lim.perDay} · Concurrent ${lim.maxConcurrent}</span>`);
    for (const [fam, cd] of Object.entries(g.cooldowns || {})) {
      chips.push(`<span class="badge badge-err">429 ${esc(fam)}: ${esc(cd)}</span>`);
    }
    bar.innerHTML = chips.join('');
  }

  function renderUsageSection() {
    const hist = state.usage && state.usage.history ? state.usage.history : [];
    renderUsageChart($('usage-chart-root'), hist, state.usageMetric, state.usageDays, t);
  }

  function renderLogsAndTelemetry() {
    renderLiveTelemetry($('telemetry-sparkline-root'), state.logs, t);

    const wrap = $('live-logs-list');
    const q = ($('log-search-input').value || '').trim().toLowerCase();
    const stFilter = $('log-status-filter').value;

    const filtered = state.logs.filter((entry) => {
      const code = Number(entry.status) || 0;
      if (stFilter === 'ok' && (code < 200 || code >= 400)) return false;
      if (stFilter === 'err' && code < 400) return false;
      if (q) {
        const hay = `${entry.kind || ''} ${entry.model || ''} ${entry.error || ''} ${entry.route || ''} ${code}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).slice(0, 80);

    if (!filtered.length) {
      wrap.innerHTML = `<div style="padding:14px" class="muted">${esc(t('overview.noLogs'))}</div>`;
      return;
    }

    const rows = filtered.map((e) => {
      const code = Number(e.status) || 0;
      const cls = code >= 500 ? 'badge-err' : (code >= 400 ? 'badge-warn' : 'badge-ok');
      const timeStr = e.ts ? new Date(e.ts).toLocaleTimeString() : '—';
      return `
        <tr>
          <td class="mono-num muted">${esc(timeStr)}</td>
          <td><span class="badge ${cls}">${esc(code || '—')}</span></td>
          <td><code>${esc(e.kind || e.route || 'req')}</code></td>
          <td><code>${esc(e.model || '—')}</code></td>
          <td class="mono-num">${esc(e.ms != null ? `${e.ms}ms` : '—')}</td>
          <td class="muted">${esc(e.error || '')}</td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `
      <table class="log-table">
        <thead><tr><th>Time</th><th>Status</th><th>Kind</th><th>Model</th><th>Latency</th><th>Note</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderInstalls() {
    const root = $('installs-list');
    const items = (state.installs && state.installs.items) || [];
    if (!items.length) { root.innerHTML = '<p class="muted">—</p>'; return; }

    root.innerHTML = items.map((item) => `
      <div class="account-item">
        <div class="row-between">
          <strong>${esc(item.label || item.key)}</strong>
          <span class="badge ${item.found ? 'badge-ok' : 'badge-neutral'}">${item.found ? 'Found' : 'Missing'}</span>
        </div>
        <div class="input-row">
          <input type="text" data-install-key="${esc(item.key)}" value="${esc(item.path || '')}" placeholder="${esc(item.detectedPath || 'Path...')}">
          <button type="button" class="btn btn-secondary btn-sm save-install-btn" data-key="${esc(item.key)}">${esc(t('actions.save'))}</button>
        </div>
      </div>`).join('');

    for (const btn of root.querySelectorAll('.save-install-btn')) {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        const inp = root.querySelector(`input[data-install-key="${key}"]`);
        try {
          state.installs = await api('POST', '/_installs', { key, path: inp ? inp.value.trim() : '' });
          renderInstalls();
          showToast('Saved', 'ok');
        } catch (e) {
          showToast(e.message, 'err');
        }
      });
    }
  }

  function renderBackups() {
    const root = $('backups-list');
    if (!state.backups.length) {
      root.innerHTML = `<p class="muted">${esc(t('overview.noBackups'))}</p>`;
      return;
    }
    root.innerHTML = state.backups.slice(0, 8).map((b) => `
      <div class="account-item">
        <div class="row-between">
          <code>${esc(b.id)}</code>
          <div class="badge-row">
            ${b.hasBundle ? '<span class="badge badge-accent">git bundle</span>' : ''}
            <span class="badge badge-neutral">${esc(b.reason)}</span>
          </div>
        </div>
        <div class="row-between muted">
          <span>${esc(b.createdAt ? new Date(b.createdAt).toLocaleString() : '—')}</span>
          <span>v${esc(b.version || '?')} · ${esc(b.fileCount || 0)} state files</span>
        </div>
      </div>`).join('');
  }

  // ---- Models Tab ----

  function renderModels() {
    const grid = $('models-grid');
    const q = ($('models-search').value || '').trim().toLowerCase();
    const f = state.modelFilter;

    const list = state.models.filter((m) => {
      const id = String(m.id || '').toLowerCase();
      const name = String(m.display_name || m.displayName || '').toLowerCase();
      if (f === 'cloud' && m.provider !== 'cloud') return false;
      if (f === 'web' && m.provider !== 'web') return false;
      if (f === 'claude' && !id.includes('claude')) return false;
      if (f === 'gemini' && !id.includes('gemini')) return false;
      if (f === 'gpt' && !id.includes('gpt')) return false;
      if (q && !id.includes(q) && !name.includes(q)) return false;
      return true;
    });

    if (!list.length) {
      grid.innerHTML = `<p class="muted">${esc(t('models.noModels'))}</p>`;
      return;
    }

    grid.innerHTML = list.map((m) => {
      const isWeb = m.provider === 'web';
      const caps = m.capabilities || {};
      const capBadges = [];
      if (caps.tools === 'emulated') capBadges.push('<span class="badge badge-warn">tools: emulated</span>');
      else if (caps.tools) capBadges.push('<span class="badge badge-ok">tools</span>');
      if (caps.thinking) capBadges.push('<span class="badge badge-accent">thinking</span>');

      return `
        <div class="model-card">
          <div class="stack-sm">
            <div class="row-between">
              <span class="badge ${isWeb ? 'badge-accent' : 'badge-ok'}">${esc(m.provider || 'cloud')}</span>
              <div class="badge-row">${capBadges.join('')}</div>
            </div>
            <div class="model-id">${esc(m.id)}</div>
            <div class="muted">${esc(m.displayName || m.display_name || m.id)}</div>
            <div class="muted mono-num">
              ${m.context_length ? `${esc(t('models.context'))}: ${esc(fmtCompact(m.context_length))}` : ''}
              ${m.max_completion_tokens ? ` · ${esc(t('models.maxOut'))}: ${esc(fmtCompact(m.max_completion_tokens))}` : ''}
            </div>
          </div>
          <div class="btn-group">
            <button type="button" class="btn btn-ghost btn-xs model-copy-btn" data-id="${esc(m.id)}">${esc(t('models.copyId'))}</button>
            <button type="button" class="btn btn-primary btn-xs model-chat-btn" data-id="${esc(m.id)}">${esc(t('models.testInChat'))}</button>
          </div>
        </div>`;
    }).join('');

    for (const btn of grid.querySelectorAll('.model-copy-btn')) {
      btn.addEventListener('click', () => copyText(btn.dataset.id));
    }
    for (const btn of grid.querySelectorAll('.model-chat-btn')) {
      btn.addEventListener('click', () => {
        const sel = $('chat-model-select');
        if (sel) sel.value = btn.dataset.id;
        switchTab('chat');
      });
    }
  }

  // ---- Gemini Web Tab ----

  function updateCookieValidationBadges() {
    const rawInput = $('web-cookie-input').value.trim();
    const fileInput = $('web-cookie-file-input').value.trim();
    const gw = (state.config && state.config.geminiWeb) || {};
    const badges = [];

    if (rawInput) {
      const hasSap = /(?:^|;\s*)(?:__Secure-1P|__Secure-3P)?SAPISID=/.test(rawInput);
      const hasPsid = /__Secure-1PSID=/.test(rawInput);
      badges.push(`<span class="badge ${hasSap ? 'badge-ok' : 'badge-err'}">SAPISID: ${hasSap ? 'OK' : 'Missing'}</span>`);
      badges.push(`<span class="badge ${hasPsid ? 'badge-ok' : 'badge-warn'}">1PSID: ${hasPsid ? 'OK' : 'No'}</span>`);
    } else if (state.webCookieMode === 'file' && fileInput) {
      badges.push(`<span class="badge badge-accent">File: ${esc(fileInput)}</span>`);
    } else if (gw.cookieSet) {
      badges.push(`<span class="badge badge-ok">${esc(t('web.cookieSet'))} (${gw.cookieLength || 'file'})</span>`);
      if (gw.cookieHasSapisid) badges.push('<span class="badge badge-ok">SAPISID</span>');
      if (gw.cookieHas1Psid) badges.push('<span class="badge badge-ok">1PSID</span>');
    } else {
      badges.push(`<span class="badge badge-neutral">${esc(t('web.cookieMissing'))}</span>`);
    }
    if (gw.hasAtToken) badges.push('<span class="badge badge-accent">atToken</span>');
    $('web-cookie-badges').innerHTML = badges.join('');
  }

  function renderWebSection() {
    const gw = (state.config && state.config.geminiWeb) || {};
    $('web-cookie-state-desc').textContent = gw.cookieSet
      ? `${t('web.cookieSet')}${gw.cookie_file ? ` · file: ${gw.cookie_file}` : ''}`
      : t('web.cookieMissing');
    $('web-cookie-file-input').value = gw.cookie_file || '';
    $('web-authuser-input').value = gw.authUser != null ? String(gw.authUser) : '';
    $('web-thinkmode-select').value = gw.thinkMode || '';
    $('web-proxy-input').value = gw.proxy || '';
    $('web-historymax-input').value = gw.historyMaxChars || 60000;
    $('web-attoken-input').value = '';
    $('web-bl-input').value = gw.bl || '';
    $('web-enabled-chk').checked = gw.enabled !== false;
    $('web-tempchats-chk').checked = gw.temporaryChats === true;
    $('web-autorotate-chk').checked = gw.autoRotateOn429 === true;
    $('web-xsrf-chk').checked = gw.xsrf !== false;

    const useFile = !!gw.cookie_file && !gw.cookieLength;
    setWebCookieMode(useFile ? 'file' : state.webCookieMode);
    updateCookieValidationBadges();
    renderWebAccounts();
  }

  function setWebCookieMode(mode) {
    state.webCookieMode = mode === 'file' ? 'file' : 'raw';
    for (const btn of $('web-cookie-mode-switch').querySelectorAll('.seg-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === state.webCookieMode);
    }
    $('web-raw-cookie-wrap').classList.toggle('hidden', state.webCookieMode !== 'raw');
    $('web-file-cookie-wrap').classList.toggle('hidden', state.webCookieMode !== 'file');
    updateCookieValidationBadges();
  }

  function renderWebAccounts() {
    const root = $('web-accounts-list');
    const list = (state.webAccounts && state.webAccounts.accounts) || [];
    const active = (state.webAccounts && state.webAccounts.activeAccount) || '';

    if (!list.length) {
      root.innerHTML = `<p class="muted">${esc(t('web.noAccounts'))}</p>`;
      return;
    }

    root.innerHTML = list.map((acc) => {
      const isAct = acc.name === active;
      const st = acc.stats || {};
      return `
        <div class="account-item ${isAct ? 'is-active' : ''}">
          <div class="row-between">
            <div class="badge-row">
              <strong>${esc(acc.name)}</strong>
              ${acc.label ? `<span class="badge badge-neutral">${esc(acc.label)}</span>` : ''}
              ${isAct ? `<span class="badge badge-accent">★ ${esc(t('actions.active'))}</span>` : ''}
              ${acc.hasCookie || acc.hasCookieFile ? '<span class="badge badge-ok">Cookie OK</span>' : '<span class="badge badge-err">No Cookie</span>'}
              ${acc.temporaryChats ? '<span class="badge badge-neutral">tempChats</span>' : ''}
            </div>
            <div class="btn-group">
              ${isAct ? '' : `<button type="button" class="btn btn-secondary btn-xs acc-act-btn" data-name="${esc(acc.name)}">${esc(t('actions.activate'))}</button>`}
              <button type="button" class="btn btn-ghost btn-xs acc-edit-btn" data-name="${esc(acc.name)}">${esc(t('actions.edit'))}</button>
              <button type="button" class="btn btn-danger-soft btn-xs acc-del-btn" data-name="${esc(acc.name)}">${esc(t('actions.delete'))}</button>
            </div>
          </div>
          <div class="muted">
            ${acc.proxy ? `proxy: <code>${esc(acc.proxy)}</code> · ` : ''}
            ${acc.authUser != null ? `/u/${esc(acc.authUser)} · ` : ''}
            req: ${esc(st.requests || 0)}, err: ${esc(st.failures || 0)}
            ${st.inCooldown ? ' · <strong style="color:var(--red)">cooldown</strong>' : ''}
          </div>
        </div>`;
    }).join('');

    for (const b of root.querySelectorAll('.acc-act-btn')) {
      b.addEventListener('click', () => mutateWebAccount({ action: 'activate', name: b.dataset.name }));
    }
    for (const b of root.querySelectorAll('.acc-edit-btn')) {
      b.addEventListener('click', () => {
        const acc = list.find((x) => x.name === b.dataset.name);
        if (!acc) return;
        state.editingAccountName = acc.name;
        $('web-acc-form-title').textContent = `${t('web.editAccountTitle')}: ${acc.name}`;
        $('acc-name-input').value = acc.name;
        $('acc-label-input').value = acc.label || '';
        $('acc-proxy-input').value = acc.proxy || '';
        $('acc-authuser-input').value = acc.authUser != null ? String(acc.authUser) : '';
        $('acc-cookie-input').value = '';
        $('acc-cookiefile-input').value = acc.cookie_file || '';
        $('acc-thinkmode-select').value = acc.thinkMode || '';
        $('acc-tempchats-chk').checked = acc.temporaryChats === true;
      });
    }
    for (const b of root.querySelectorAll('.acc-del-btn')) {
      b.addEventListener('click', async () => {
        const name = b.dataset.name;
        const ok = await askConfirm(t('confirm.deleteAccountTitle'), t('confirm.deleteAccountMsg', { name }));
        if (ok) await mutateWebAccount({ action: 'remove', name });
      });
    }
  }

  async function mutateWebAccount(payload) {
    try {
      const res = await api('POST', '/_web/accounts', payload);
      state.webAccounts = { activeAccount: res.activeAccount, accounts: res.accounts };
      state.config = await api('GET', '/_config');
      renderWebSection();
      renderOverviewKpis();
      showToast('OK', 'ok');
    } catch (e) {
      showToast(e.message, 'err');
    }
  }

  // ---- Diagnostic Chat Tab ----

  function populateChatModelSelect() {
    const sel = $('chat-model-select');
    if (!sel) return;
    const prev = sel.value;
    const opts = state.models.length
      ? state.models.map((m) => m.id)
      : ['cloud/claude-sonnet-4-6', 'cloud/gemini-2.5-flash', 'web/gemini-4-argon'];
    sel.innerHTML = opts.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
    if (prev && opts.includes(prev)) sel.value = prev;
  }

  function renderMarkdownSafe(rawText) {
    const text = String(rawText || '');
    const segments = text.split(/```([^\n]*)\n([\s\S]*?)```/g);
    let html = '';
    for (let i = 0; i < segments.length; i += 3) {
      const prose = segments[i] || '';
      if (prose) {
        const escaped = esc(prose)
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/^### (.+)$/gm, '<h4>$1</h4>')
          .replace(/^## (.+)$/gm, '<h3>$1</h3>')
          .replace(/\n{2,}/g, '</p><p>')
          .replace(/\n/g, '<br>');
        html += `<p>${escaped}</p>`;
      }
      if (i + 2 < segments.length) {
        const lang = esc(segments[i + 1] || '');
        const code = esc(segments[i + 2] || '');
        html += `<pre data-lang="${lang}"><button type="button" class="btn btn-ghost btn-xs code-copy-inline">${esc(t('actions.copy'))}</button><code>${code}</code></pre>`;
      }
    }
    return `<div class="md-body">${html}</div>`;
  }

  function renderChatMessages() {
    const box = $('chat-messages');
    if (!state.chatHistory.length) {
      box.innerHTML = `<div class="muted" style="margin:auto;text-align:center;max-width:420px">${esc(t('chat.emptyState'))}</div>`;
      return;
    }

    box.innerHTML = state.chatHistory.map((msg) => {
      if (msg.role === 'user') {
        return `<div class="chat-bubble user">${esc(msg.text).replace(/\n/g, '<br>')}</div>`;
      }
      if (msg.error) {
        return `
          <div class="chat-bubble error">
            <strong>${esc(msg.error.code || 'error')}</strong> (${esc(msg.error.stage || 'request')}): ${esc(msg.error.message || '')}
          </div>`;
      }
      const diag = msg.diagnostics
        ? `<div class="chat-meta">
            <span>${esc(t('chat.bridgeUsed'))}: <code>${esc(msg.diagnostics.bridge || '—')}</code></span>
            <span>model: <code>${esc(msg.diagnostics.model || '—')}</code></span>
            <span>${esc(t('chat.durationMs'))}: <code>${esc(msg.diagnostics.durationMs ?? '—')}ms</code></span>
          </div>`
        : '';
      return `<div class="chat-bubble assistant">${renderMarkdownSafe(msg.text || '…')}${diag}</div>`;
    }).join('');

    for (const btn of box.querySelectorAll('.code-copy-inline')) {
      btn.addEventListener('click', () => {
        const codeEl = btn.parentElement.querySelector('code');
        if (codeEl) copyText(codeEl.textContent || '');
      });
    }
    box.scrollTop = box.scrollHeight;
  }

  async function sendDiagnosticChat(promptOverride = null) {
    if (state.chatAbort) return;
    const inputEl = $('chat-input');
    const message = promptOverride != null ? promptOverride : inputEl.value.trim();
    if (!message) return;

    state.chatLastUserMsg = message;
    if (promptOverride == null) inputEl.value = '';
    $('btn-chat-retry').classList.remove('hidden');

    const model = $('chat-model-select').value;
    const bridge = $('chat-bridge-select').value;
    const stream = $('chat-stream-chk').checked;

    state.chatHistory.push({ role: 'user', text: message });
    const assistantMsg = { role: 'assistant', text: '', diagnostics: null, error: null };
    state.chatHistory.push(assistantMsg);
    renderChatMessages();

    const ac = new AbortController();
    state.chatAbort = ac;
    $('btn-chat-send').disabled = true;
    $('btn-chat-stop').classList.remove('hidden');

    try {
      const res = await fetch('/api/diagnostics/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, message, bridge, stream }),
        signal: ac.signal,
      });

      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || '';
          for (const rawLine of lines) {
            if (!rawLine.startsWith('data:')) continue;
            const payload = rawLine.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let frame;
            try { frame = JSON.parse(payload); } catch { continue; }
            if (frame.type === 'delta' && frame.text) {
              assistantMsg.text += frame.text;
              renderChatMessages();
            } else if (frame.type === 'done') {
              if (!assistantMsg.text && frame.response) assistantMsg.text = frame.response;
              assistantMsg.diagnostics = frame.diagnostics || null;
              renderChatMessages();
            } else if (frame.type === 'error') {
              assistantMsg.error = frame.error || { message: 'Stream error' };
              renderChatMessages();
            }
          }
        }
      } else {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          assistantMsg.error = data.error || { message: `HTTP ${res.status}` };
        } else {
          assistantMsg.text = data.response || '';
          assistantMsg.diagnostics = data.diagnostics || null;
        }
        renderChatMessages();
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        assistantMsg.text = (assistantMsg.text ? assistantMsg.text + '\n\n' : '') + '[stopped]';
      } else {
        assistantMsg.error = { code: 'network_error', stage: 'client', message: e.message };
      }
      renderChatMessages();
    } finally {
      state.chatAbort = null;
      $('btn-chat-send').disabled = false;
      $('btn-chat-stop').classList.add('hidden');
    }
  }

  // ---- Connection Tab ----

  function currentBaseOrigin() {
    const s = state.status || state.config || {};
    const hostRaw = String(s.host || '127.0.0.1').trim();
    const clientHost = (!hostRaw || hostRaw === '0.0.0.0' || hostRaw === '::') ? (window.location.hostname || '127.0.0.1') : hostRaw;
    const port = s.port || window.location.port || 8317;
    return `http://${clientHost}:${port}`;
  }

  function renderConnection() {
    const origin = currentBaseOrigin();
    $('ep-openai').value = `${origin}/v1`;
    $('ep-anthropic').value = `${origin}/v1/messages`;
    $('ep-gemini').value = `${origin}/v1beta`;

    $('key-api-input').value = state.keys.apiKey || '';
    $('key-admin-input').value = state.keys.adminKey || '';

    const cfg = state.config || state.status || {};
    $('conn-host-input').value = cfg.host || '127.0.0.1';
    $('conn-port-input').value = cfg.port || 8317;

    const st = state.startup;
    const toggle = $('autostart-toggle');
    if (st) {
      toggle.disabled = !st.supported;
      toggle.checked = !!st.enabled;
      $('autostart-path-desc').textContent = st.supported ? (st.path || 'Supported') : 'Not supported on this OS';
    }
    renderSnippet();
  }

  function renderSnippet() {
    const origin = currentBaseOrigin();
    const key = state.keys.apiKey || 'YOUR_API_KEY';
    const model = (state.models[0] && state.models[0].id) || 'cloud/claude-sonnet-4-6';
    let code = '';

    if (state.snippetTab === 'curl') {
      code = `curl "${origin}/v1/chat/completions" \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello!' }] })}'`;
    } else if (state.snippetTab === 'claude') {
      code = `# PowerShell\n$env:ANTHROPIC_BASE_URL="${origin}"\n$env:ANTHROPIC_AUTH_TOKEN="${key}"\nclaude --model ${model}\n\n# Bash / Zsh\nexport ANTHROPIC_BASE_URL="${origin}"\nexport ANTHROPIC_AUTH_TOKEN="${key}"\nclaude --model ${model}`;
    } else if (state.snippetTab === 'python') {
      code = `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${origin}/v1",\n    api_key="${key}",\n)\n\nresp = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(resp.choices[0].message.content)`;
    } else {
      code = `Base URL: ${origin}/v1\nAPI Key:  ${key}\nModel:    ${model}`;
    }
    $('snippet-code').textContent = code;
  }

  // ---- Settings Tab ----

  function renderSettings() {
    const c = state.config;
    if (!c) return;
    const net = c.network || {};
    $('set-net-proxy').value = net.proxy || '';
    $('set-net-doh').value = net.dohUrl || '';
    $('set-net-timeout').value = net.timeoutMs || 30000;
    $('set-net-dns').value = Array.isArray(net.dnsServers) ? net.dnsServers.join(', ') : '';
    $('set-net-envproxy').checked = net.useEnvProxy !== false;

    const sm = c.safeMode || {};
    $('set-safe-enabled').checked = sm.enabled === true;
    $('set-safe-rpm').value = sm.maxRequestsPerMinute ?? 60;
    $('set-safe-rph').value = sm.maxRequestsPerHour ?? 600;
    $('set-safe-rpd').value = sm.maxRequestsPerDay ?? 3000;
    $('set-safe-rpw').value = sm.maxRequestsPerWeek ?? 20000;
    $('set-safe-tpd').value = sm.maxTokensPerDay ?? 50000000;
    $('set-safe-tpw').value = sm.maxTokensPerWeek ?? 200000000;
    $('set-safe-interval').value = sm.minIntervalMs ?? 200;
    $('set-safe-jitter').value = sm.jitterMs ?? 100;
    $('set-safe-concurrent').value = sm.maxConcurrent ?? 4;
    $('set-safe-cd429').value = sm.cooldownAfter429Ms ?? 30000;
    $('set-safe-maxcd').value = sm.maxCooldownMs ?? 300000;

    $('set-default-model').value = c.defaultModel || '';
    $('set-retries').value = c.retries ?? 2;
    $('set-headroom').value = c.outputHeadroomTokens ?? 256;
    $('set-think-budget').value = c.thinking && c.thinking.defaultBudget != null ? c.thinking.defaultBudget : '';
    $('set-include-thoughts').checked = c.includeThoughts === true;
    $('set-map-effort').checked = !!(c.thinking && c.thinking.mapReasoningEffort);

    const cors = c.cors || {};
    $('set-cors-enabled').checked = cors.enabled !== false;
    $('set-cors-any').checked = cors.allowAnyOrigin === true;
    $('set-cors-origins').value = Array.isArray(cors.origins) ? cors.origins.join('\n') : '';

    const ag = c.agent || {};
    $('set-agent-enabled').checked = ag.enabled !== false;
    $('set-agent-webagent').checked = ag.allowWebAgent === true;
    $('set-agent-planner').checked = !(ag.planner && ag.planner.enabled === false);
    $('set-agent-root').value = ag.workspaceRoot || '';
    $('set-agent-iters').value = ag.maxIterations ?? 8;
    $('set-agent-read').value = ag.maxReadBytes ?? 20480;
    $('set-agent-write').value = ag.maxWriteBytes ?? 2097152;
    $('set-agent-shellto').value = ag.shellTimeoutMs ?? 60000;
    $('set-agent-pcalls').value = ag.planner ? (ag.planner.maxCalls ?? 2) : 2;

    $('agent-diskonly-badges').innerHTML = [
      `allowDelete=${!!ag.allowDelete}`,
      `allowShell=${!!ag.allowShell}`,
      `allowAbsolutePaths=${!!ag.allowAbsolutePaths}`,
      `auditFile=${ag.auditFile || '(default)'}`,
    ].map((txt) => `<span class="badge badge-neutral"><code>${esc(txt)}</code></span>`).join('');
  }

  function showSettingsFeedback(res) {
    const el = $('settings-feedback');
    const lines = [];
    if (res.applied && res.applied.length) lines.push(`Applied: ${res.applied.join(', ')}`);
    if (res.ignored && res.ignored.length) lines.push(`Ignored: ${res.ignored.join(', ')}`);
    if (res.warnings && res.warnings.length) lines.push(`Warnings: ${res.warnings.join('; ')}`);
    if (res.restartRequired && res.restartRequired.length) lines.push(`Restart required for: ${res.restartRequired.join(', ')}`);
    el.className = `alert ${(res.warnings && res.warnings.length) || (res.restartRequired && res.restartRequired.length) ? 'alert-warn' : 'alert-ok'}`;
    el.textContent = lines.join(' | ') || 'Saved.';
    el.classList.remove('hidden');
  }

  async function restartAndFollowPort(targetPort) {
    try {
      await api('POST', '/_server/restart', {});
      showToast('Restarting...', 'warn');
    } catch (e) {
      showToast(e.message, 'err');
      return;
    }
    const deadline = Date.now() + 18000;
    const pollUrl = `${window.location.protocol}//${window.location.hostname}:${targetPort}/_health`;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        showToast('Server restart wait timed out', 'warn');
        return;
      }
      try {
        const r = await fetch(pollUrl, { cache: 'no-store' });
        if (r.ok) {
          clearInterval(timer);
          if (String(window.location.port) !== String(targetPort)) {
            window.location.href = `${window.location.protocol}//${window.location.hostname}:${targetPort}/`;
          } else {
            await loadAllData();
            openEventStream();
            showToast('Server restarted!', 'ok');
          }
        }
      } catch {}
    }, 650);
  }

  // ---- Event Bindings ----

  function bindEvents() {
    $('auth-toggle-vis').addEventListener('click', () => {
      const inp = $('auth-key-input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = $('auth-key-input').value.trim();
      const errBox = $('auth-error');
      errBox.classList.add('hidden');
      try {
        await api('POST', '/_auth/session', { adminKey: key });
        $('auth-key-input').value = '';
        state.authenticated = true;
        $('auth-screen').classList.add('hidden');
        $('app-shell').classList.remove('hidden');
        await loadAllData();
        openEventStream();
      } catch (err) {
        errBox.textContent = err.status === 429
          ? t('auth.rateLimited', { sec: err.retryAfter || 30 })
          : (err.status === 401 ? t('auth.invalidKey') : err.message);
        errBox.classList.remove('hidden');
      }
    });

    $('btn-logout').addEventListener('click', async () => {
      await api('POST', '/_auth/logout', {}).catch(() => {});
      handleUnauthorized();
    });

    for (const btn of document.querySelectorAll('.nav-item[data-tab]')) {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    }
    $('sidebar-collapse-btn').addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));
    $('mobile-menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('mobile-open'));

    for (const btn of document.querySelectorAll('.lang-toggle-btn')) {
      btn.addEventListener('click', async () => {
        const next = getLang() === 'ru' ? 'en' : 'ru';
        setLang(next);
        applyTranslations();
        $('lang-btn').textContent = next.toUpperCase();
        renderAll();
        await persistUiPref({ language: next });
      });
    }

    for (const btn of document.querySelectorAll('.theme-toggle-btn')) {
      btn.addEventListener('click', async () => {
        const next = state.theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        await persistUiPref({ theme: next });
      });
    }

    $('btn-refresh-all').addEventListener('click', () => loadAllData().then(() => showToast('Refreshed', 'ok')));
    $('btn-refresh-limits').addEventListener('click', refreshLimits);
    $('btn-refresh-models').addEventListener('click', refreshModels);
    $('btn-refresh-installs').addEventListener('click', async () => {
      state.installs = await api('GET', '/_installs');
      renderInstalls();
    });

    const createBackupAction = async () => {
      try {
        const res = await api('POST', '/_backup', {});
        showToast(`Backup created: ${res.backup && res.backup.id ? res.backup.id : 'OK'}`, 'ok');
        const list = await api('GET', '/_backups');
        state.backups = list.backups || [];
        renderBackups();
      } catch (e) {
        showToast(e.message, 'err');
      }
    };
    $('btn-quick-backup').addEventListener('click', createBackupAction);
    $('btn-create-backup').addEventListener('click', createBackupAction);

    $('btn-restart-server').addEventListener('click', async () => {
      if (await askConfirm(t('confirm.restartTitle'), t('confirm.restartMsg'), false)) {
        await restartAndFollowPort((state.status && state.status.port) || 8317);
      }
    });

    $('btn-stop-server').addEventListener('click', async () => {
      if (await askConfirm(t('confirm.stopTitle'), t('confirm.stopMsg'), true)) {
        await api('POST', '/_server/shutdown', {}).catch(() => {});
        setStatusPill('offline');
        closeEventStream();
        showToast('Server stopped.', 'warn');
      }
    });

    $('btn-extract-token').addEventListener('click', async () => {
      try {
        const res = await api('POST', '/_auth/extract', {});
        showToast(`Extracted (${res.dbSource || 'IDE'})`, 'ok');
        await loadAllData();
      } catch (e) {
        showToast(e.message, 'err');
      }
    });

    $('btn-reload-token').addEventListener('click', async () => {
      try {
        await api('POST', '/_auth/reload', {});
        showToast('Reloaded auth.json', 'ok');
        await loadAllData();
      } catch (e) {
        showToast(e.message, 'err');
      }
    });

    for (const b of $('usage-metric-switch').querySelectorAll('.seg-btn')) {
      b.addEventListener('click', () => {
        state.usageMetric = b.dataset.metric;
        for (const x of $('usage-metric-switch').querySelectorAll('.seg-btn')) x.classList.toggle('active', x === b);
        renderUsageSection();
      });
    }
    for (const b of $('usage-days-switch').querySelectorAll('.seg-btn')) {
      b.addEventListener('click', () => {
        state.usageDays = Number(b.dataset.days) || 14;
        for (const x of $('usage-days-switch').querySelectorAll('.seg-btn')) x.classList.toggle('active', x === b);
        renderUsageSection();
      });
    }

    $('log-search-input').addEventListener('input', renderLogsAndTelemetry);
    $('log-status-filter').addEventListener('change', renderLogsAndTelemetry);

    $('models-search').addEventListener('input', renderModels);
    for (const p of $('models-filter-pills').querySelectorAll('.pill')) {
      p.addEventListener('click', () => {
        state.modelFilter = p.dataset.filter;
        for (const x of $('models-filter-pills').querySelectorAll('.pill')) x.classList.toggle('active', x === p);
        renderModels();
      });
    }

    // Gemini Web
    for (const b of $('web-cookie-mode-switch').querySelectorAll('.seg-btn')) {
      b.addEventListener('click', () => setWebCookieMode(b.dataset.mode));
    }
    $('web-cookie-input').addEventListener('input', updateCookieValidationBadges);
    $('web-cookie-file-input').addEventListener('input', updateCookieValidationBadges);

    $('btn-web-open-browser').addEventListener('click', async () => {
      try {
        const res = await api('POST', '/_web/browser/open', {});
        showToast(`Opened browser (${res.executable ? res.executable.split(/[\\/]/).pop() : 'CDP'})`, 'ok');
      } catch (e) {
        showToast(e.message, 'err');
      }
    });

    $('btn-web-import-cdp').addEventListener('click', async () => {
      try {
        const res = await api('POST', '/_web/browser/import-cookies', { saveTo: 'single' });
        showToast(`Imported ${res.count || 0} cookies (SAPISID: ${res.hasSapisid ? 'OK' : 'No'})`, res.hasSapisid ? 'ok' : 'warn');
        state.config = await api('GET', '/_config');
        renderWebSection();
        renderOverviewKpis();
      } catch (e) {
        showToast(e.message, 'err');
      }
    });

    $('btn-web-save').addEventListener('click', async () => {
      const geminiWeb = {
        enabled: $('web-enabled-chk').checked,
        temporaryChats: $('web-tempchats-chk').checked,
        autoRotateOn429: $('web-autorotate-chk').checked,
        xsrf: $('web-xsrf-chk').checked,
        proxy: $('web-proxy-input').value.trim(),
        historyMaxChars: Number($('web-historymax-input').value) || 60000,
        bl: $('web-bl-input').value.trim(),
        thinkMode: $('web-thinkmode-select').value || null,
      };
      const au = $('web-authuser-input').value.trim();
      geminiWeb.authUser = au === '' ? null : Number(au);
      const at = $('web-attoken-input').value.trim();
      if (at) geminiWeb.atToken = at;

      if (state.webCookieMode === 'raw') {
        const rawC = $('web-cookie-input').value.trim();
        if (rawC) {
          geminiWeb.cookie = rawC;
          geminiWeb.cookie_file = '';
        }
      } else {
        geminiWeb.cookie_file = $('web-cookie-file-input').value.trim();
        if (geminiWeb.cookie_file) geminiWeb.cookie = '';
      }

      try {
        const res = await api('POST', '/_config', { geminiWeb });
        $('web-cookie-input').value = '';
        state.config = await api('GET', '/_config');
        renderWebSection();
        renderOverviewKpis();
        showToast(`Saved (${(res.applied || []).length} fields)`, 'ok');
      } catch (e) {
        showToast(e.message, 'err');
      }
    });

    $('btn-web-clear-cookie').addEventListener('click', async () => {
      if (!(await askConfirm(t('confirm.clearCookieTitle'), t('confirm.clearCookieMsg'), true))) return;
      try {
        await api('POST', '/_config', { geminiWeb: { cookie: '', cookie_file: '', atToken: '' } });
        $('web-cookie-input').value = '';
        $('web-cookie-file-input').value = '';
        state.config = await api('GET', '/_config');
        renderWebSection();
        renderOverviewKpis();
        showToast('Cookie cleared', 'ok');
      } catch (e) {
        showToast(e.message, 'err');
      }
    });

    $('web-account-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('acc-name-input').value.trim();
      if (!name) return;
      const existing = (state.webAccounts.accounts || []).find((a) => a.name === state.editingAccountName || a.name === name);
      const action = existing ? 'update' : 'add';
      const au = $('acc-authuser-input').value.trim();
      const payload = {
        action,
        name,
        label: $('acc-label-input').value.trim(),
        proxy: $('acc-proxy-input').value.trim(),
        authUser: au === '' ? null : Number(au),
        thinkMode: $('acc-thinkmode-select').value || null,
        temporaryChats: $('acc-tempchats-chk').checked,
      };
      const ck = $('acc-cookie-input').value.trim();
      const cf = $('acc-cookiefile-input').value.trim();
      if (ck) { payload.cookie = ck; payload.cookie_file = ''; }
      else if (cf || action === 'add') { payload.cookie_file = cf; }
      await mutateWebAccount(payload);
      $('acc-cookie-input').value = '';
      state.editingAccountName = '';
      $('web-acc-form-title').textContent = t('web.addAccountTitle');
    });

    $('btn-acc-import-cdp').addEventListener('click', async () => {
      const accountName = $('acc-name-input').value.trim();
      if (!accountName) { showToast('Enter Account Name first', 'warn'); return; }
      try {
        const res = await api('POST', '/_web/browser/import-cookies', { saveTo: 'account', accountName });
        showToast(`Imported ${res.count || 0} cookies -> ${accountName}`, 'ok');
        state.webAccounts = await api('GET', '/_web/accounts');
        state.config = await api('GET', '/_config');
        renderWebSection();
      } catch (e) {
        showToast(e.message, 'err');
      }
    });

    $('btn-acc-reset').addEventListener('click', () => {
      state.editingAccountName = '';
      $('web-account-form').reset();
      $('web-acc-form-title').textContent = t('web.addAccountTitle');
    });

    // Diagnostic Chat
    $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendDiagnosticChat(); });
    $('chat-input').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendDiagnosticChat();
      }
    });
    $('btn-chat-stop').addEventListener('click', () => { if (state.chatAbort) state.chatAbort.abort(); });
    $('btn-chat-retry').addEventListener('click', () => { if (state.chatLastUserMsg) sendDiagnosticChat(state.chatLastUserMsg); });
    $('btn-chat-clear').addEventListener('click', () => { state.chatHistory = []; renderChatMessages(); });

    // Connection
    for (const b of document.querySelectorAll('.copy-btn[data-copy-target]')) {
      b.addEventListener('click', () => {
        const el = $(b.dataset.copyTarget);
        if (el) copyText(el.value);
      });
    }
    for (const b of document.querySelectorAll('.toggle-secret-btn[data-secret-target]')) {
      b.addEventListener('click', () => {
        const el = $(b.dataset.secretTarget);
        if (!el) return;
        const hidden = el.type === 'password';
        el.type = hidden ? 'text' : 'password';
        b.textContent = t(hidden ? 'actions.hide' : 'actions.show');
      });
    }
    for (const b of $('snippet-tabs').querySelectorAll('.seg-btn')) {
      b.addEventListener('click', () => {
        state.snippetTab = b.dataset.snippet;
        for (const x of $('snippet-tabs').querySelectorAll('.seg-btn')) x.classList.toggle('active', x === b);
        renderSnippet();
      });
    }
    $('btn-copy-snippet').addEventListener('click', () => copyText($('snippet-code').textContent));

    $('btn-save-listen').addEventListener('click', async () => {
      const host = $('conn-host-input').value.trim() || '127.0.0.1';
      const port = Number($('conn-port-input').value) || 8317;
      try {
        const res = await api('POST', '/_config', { host, port });
        state.config = await api('GET', '/_config');
        showToast(`Saved (${host}:${port})`, 'ok');
        if (res.restartRequired && res.restartRequired.length) {
          if (await askConfirm(t('confirm.restartTitle'), `Restart now to listen on ${host}:${port}?`, false)) {
            await restartAndFollowPort(port);
          }
        }
      } catch (e) {
        showToast(e.message, 'err');
      }
    });

    $('autostart-toggle').addEventListener('change', async (e) => {
      try {
        state.startup = await api('POST', '/_startup', { enabled: e.target.checked });
        renderConnection();
        showToast(state.startup.enabled ? 'Autostart enabled' : 'Autostart disabled', 'ok');
      } catch (err) {
        e.target.checked = !e.target.checked;
        showToast(err.message, 'err');
      }
    });

    // Settings
    $('btn-detect-proxy').addEventListener('click', async () => {
      const wrap = $('detected-proxies-wrap');
      try {
        const res = await api('POST', '/_network/detect-proxy', {});
        const proxies = res.proxies || [];
        if (!proxies.length) {
          wrap.innerHTML = '<span class="muted">No local proxies found.</span>';
          wrap.classList.remove('hidden');
          return;
        }
        wrap.innerHTML = proxies.map((p) => `
          <button type="button" class="pill" data-proxy="${esc(p.url)}" title="${esc(p.source)}">
            ${esc(p.maskedUrl || p.url)} (${esc(p.source)}${p.reachable ? ' ✓' : ''})
          </button>`).join('');
        wrap.classList.remove('hidden');
        for (const btn of wrap.querySelectorAll('.pill[data-proxy]')) {
          btn.addEventListener('click', () => {
            $('set-net-proxy').value = btn.dataset.proxy;
            showToast('Proxy filled into form', 'info');
          });
        }
      } catch (e) {
        showToast(e.message, 'err');
      }
    });

    $('btn-test-network').addEventListener('click', async () => {
      const box = $('network-test-result');
      box.classList.remove('hidden');
      box.textContent = 'Testing DNS & Upstream connectivity…';
      const draftNet = {
        proxy: $('set-net-proxy').value.trim(),
        dohUrl: $('set-net-doh').value.trim(),
        timeoutMs: Number($('set-net-timeout').value) || 30000,
        useEnvProxy: $('set-net-envproxy').checked,
        dnsServers: $('set-net-dns').value.split(',').map((s) => s.trim()).filter(Boolean),
      };
      try {
        const res = await api('POST', '/_network/test', { timeout: 6000, network: draftNet });
        const routesHtml = Object.entries(res.routes || {}).map(([name, info]) => {
          const ok = info && info.ok;
          return `<span class="badge ${ok ? 'badge-ok' : 'badge-err'}">${esc(name)}: ${ok ? `OK (${info.ms}ms)` : esc(info && info.error ? info.error : 'ERR')}</span>`;
        }).join(' ');
        box.innerHTML = `<div class="badge-row"><span>DNS: <code>${esc(res.dnsMode || 'system')}</code></span><span>Proxy: <code>${esc(res.proxy || 'direct')}</code></span>${routesHtml}</div>`;
      } catch (e) {
        box.textContent = `Test failed: ${e.message}`;
      }
    });

    $('btn-save-settings').addEventListener('click', async () => {
      const thinkBudgetRaw = $('set-think-budget').value.trim();
      const plannerBase = (state.config && state.config.agent && state.config.agent.planner) || {};
      const patch = {
        network: {
          proxy: $('set-net-proxy').value.trim(),
          dohUrl: $('set-net-doh').value.trim(),
          timeoutMs: Number($('set-net-timeout').value) || 30000,
          useEnvProxy: $('set-net-envproxy').checked,
          dnsServers: $('set-net-dns').value.split(',').map((s) => s.trim()).filter(Boolean),
        },
        safeMode: {
          enabled: $('set-safe-enabled').checked,
          maxRequestsPerMinute: Number($('set-safe-rpm').value),
          maxRequestsPerHour: Number($('set-safe-rph').value),
          maxRequestsPerDay: Number($('set-safe-rpd').value),
          maxRequestsPerWeek: Number($('set-safe-rpw').value),
          maxTokensPerDay: Number($('set-safe-tpd').value),
          maxTokensPerWeek: Number($('set-safe-tpw').value),
          minIntervalMs: Number($('set-safe-interval').value),
          jitterMs: Number($('set-safe-jitter').value),
          maxConcurrent: Number($('set-safe-concurrent').value),
          cooldownAfter429Ms: Number($('set-safe-cd429').value),
          maxCooldownMs: Number($('set-safe-maxcd').value),
        },
        defaultModel: $('set-default-model').value.trim(),
        retries: Number($('set-retries').value),
        outputHeadroomTokens: Number($('set-headroom').value),
        includeThoughts: $('set-include-thoughts').checked,
        thinking: {
          mapReasoningEffort: $('set-map-effort').checked,
          defaultBudget: thinkBudgetRaw === '' ? null : Number(thinkBudgetRaw),
        },
        cors: {
          enabled: $('set-cors-enabled').checked,
          allowAnyOrigin: $('set-cors-any').checked,
          origins: $('set-cors-origins').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        },
        agent: {
          enabled: $('set-agent-enabled').checked,
          allowWebAgent: $('set-agent-webagent').checked,
          workspaceRoot: $('set-agent-root').value.trim(),
          maxIterations: Number($('set-agent-iters').value),
          maxReadBytes: Number($('set-agent-read').value),
          maxWriteBytes: Number($('set-agent-write').value),
          shellTimeoutMs: Number($('set-agent-shellto').value),
          planner: {
            ...plannerBase,
            enabled: $('set-agent-planner').checked,
            maxCalls: Number($('set-agent-pcalls').value),
          },
        },
      };
      try {
        const res = await api('POST', '/_config', patch);
        state.config = await api('GET', '/_config');
        renderSettings();
        showSettingsFeedback(res);
        showToast('Settings saved', 'ok');
      } catch (e) {
        showToast(e.message, 'err');
      }
    });
  }

  async function init() {
    applyTranslations();
    applyTheme('dark');
    bindEvents();

    setInterval(() => {
      if (!state.authenticated) return;
      if (state.uptimeSyncedAt) {
        const elapsed = Math.floor((Date.now() - state.uptimeSyncedAt) / 1000);
        $('topbar-uptime').textContent = formatUptime(state.uptimeBase + elapsed);
      }
      tickResetCountdowns($('quota-gauges-root'), t);
    }, 1000);

    setInterval(() => {
      if (state.authenticated && state.activeTab === 'overview') {
        refreshLimits();
      }
    }, 30000);

    try {
      const sess = await api('GET', '/_auth/session');
      state.supervised = !!sess.supervised;
      state.authenticated = !!sess.authenticated;
    } catch {
      state.authenticated = false;
    }

    if (state.authenticated) {
      $('auth-screen').classList.add('hidden');
      $('app-shell').classList.remove('hidden');
      await loadAllData();
      openEventStream();
    } else {
      $('auth-screen').classList.remove('hidden');
      $('auth-key-input').focus();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

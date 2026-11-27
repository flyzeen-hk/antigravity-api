'use strict';

(function (global) {
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtCompact(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(Math.round(v));
  }

  function formatCountdown(iso) {
    if (!iso) return '—';
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return '—';
    if (ms <= 0) return '0m';
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hrs = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (days > 0) return `${days}d ${hrs}h`;
    if (hrs > 0) return `${hrs}h ${m}m`;
    return `${m}m`;
  }

  function gaugeColor(pct) {
    if (pct === null || pct === undefined) return 'var(--text-muted)';
    if (pct <= 15) return 'var(--red)';
    if (pct <= 40) return 'var(--amber)';
    return 'var(--green)';
  }

  function buildArcSvg(pct) {
    const r = 34;
    const c = 2 * Math.PI * r;
    const clamped = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, Number(pct)));
    const dash = (clamped / 100) * c;
    const color = gaugeColor(pct);
    const label = pct === null || pct === undefined ? '—' : `${Math.round(clamped)}%`;
    return `
      <svg width="86" height="86" viewBox="0 0 86 86" aria-hidden="true">
        <circle cx="43" cy="43" r="${r}" fill="none" stroke="var(--border)" stroke-width="7"></circle>
        <circle class="gauge-arc" cx="43" cy="43" r="${r}" fill="none" stroke="${color}" stroke-width="7"
          stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}"
          transform="rotate(-90 43 43)"></circle>
        <text x="43" y="47" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="700" font-family="var(--font-sans)">${esc(label)}</text>
      </svg>`;
  }

  function renderQuotaGauges(container, limitsData, t) {
    if (!container) return;
    if (!limitsData) {
      container.innerHTML = `<p class="muted">${esc(t('overview.noQuotas'))}</p>`;
      return;
    }

    const accErr = limitsData.account && limitsData.account.error;
    if (accErr === 'server_stopped') {
      container.innerHTML = `<div class="alert alert-info"><span>${esc(t('overview.quotasServerStopped'))}</span></div>`;
      return;
    }
    if (accErr === 'cloud_disabled' || accErr === 'auth_missing') {
      container.innerHTML = `<div class="alert alert-info"><span>${esc(limitsData.modelsError || t('overview.noQuotas'))}</span></div>`;
      return;
    }

    const cards = [];
    const groups = limitsData.serverQuotas && Array.isArray(limitsData.serverQuotas.groups)
      ? limitsData.serverQuotas.groups : [];

    for (const g of groups) {
      for (const b of (g.buckets || [])) {
        if (b.disabled) continue;
        const pct = b.remainingPercent;
        const winLabel = b.window ? ` (${b.window})` : '';
        const title = `${g.displayName || g.name}${winLabel}`;
        const resetAttr = b.resetTime ? `data-reset-iso="${esc(b.resetTime)}"` : '';
        const resetStr = b.resetTime ? t('overview.resetIn', { time: formatCountdown(b.resetTime) }) : '—';
        cards.push(`
          <div class="gauge-card">
            ${buildArcSvg(pct)}
            <div class="gauge-title">${esc(title)}</div>
            <div class="gauge-sub" ${resetAttr}>${esc(resetStr)}</div>
          </div>`);
      }
    }

    const fams = limitsData.quotaFamilies || {};
    for (const [famKey, label] of [['gemini', 'Gemini Catalog'], ['claude', 'Claude Catalog'], ['gpt', 'GPT Catalog']]) {
      const f = fams[famKey];
      if (!f || (!f.modelCount && f.percent === null)) continue;
      const resetAttr = f.resetTime ? `data-reset-iso="${esc(f.resetTime)}"` : '';
      const resetStr = f.resetTime ? t('overview.resetIn', { time: formatCountdown(f.resetTime) }) : `${f.modelCount} models`;
      cards.push(`
        <div class="gauge-card">
          ${buildArcSvg(f.percent)}
          <div class="gauge-title">${esc(label)}</div>
          <div class="gauge-sub" ${resetAttr}>${esc(resetStr)}</div>
        </div>`);
    }

    if (!cards.length) {
      const errText = (limitsData.serverQuotas && limitsData.serverQuotas.error) || limitsData.modelsError || t('overview.noQuotas');
      container.innerHTML = `<div class="alert alert-warn"><span>${esc(errText)}</span></div>`;
      return;
    }

    container.innerHTML = `<div class="quota-grid">${cards.join('')}</div>`;
  }

  function tickResetCountdowns(root, t) {
    if (!root) return;
    for (const el of root.querySelectorAll('[data-reset-iso]')) {
      const iso = el.getAttribute('data-reset-iso');
      el.textContent = t('overview.resetIn', { time: formatCountdown(iso) });
    }
  }

  function renderUsageChart(container, history, metric, daysCount, t) {
    if (!container) return;
    const rows = Array.isArray(history) ? history.slice(-daysCount) : [];
    if (!rows.length || rows.every((r) => !(r[metric] > 0))) {
      container.innerHTML = `<p class="muted">${esc(t('overview.noUsage'))}</p>`;
      return;
    }

    const vals = rows.map((r) => Number(r[metric]) || 0);
    const maxVal = Math.max(1, ...vals);
    const totalReq = rows.reduce((s, r) => s + (Number(r.requests) || 0), 0);
    const totalTok = rows.reduce((s, r) => s + (Number(r.tokens) || 0), 0);

    const W = 540;
    const H = 175;
    const padL = 42;
    const padR = 12;
    const padT = 14;
    const padB = 26;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const step = innerW / rows.length;
    const barW = Math.max(4, Math.min(26, step * 0.68));

    const grid = [0, 0.5, 1].map((frac) => {
      const y = padT + innerH * (1 - frac);
      const val = fmtCompact(maxVal * frac);
      return `
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-dasharray="3 3"></line>
        <text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--text-muted)" font-size="10.5" font-family="var(--font-mono)">${esc(val)}</text>`;
    }).join('');

    const bars = rows.map((r, i) => {
      const val = Number(r[metric]) || 0;
      const barH = Math.max(val > 0 ? 2 : 0, (val / maxVal) * innerH);
      const x = padL + i * step + (step - barW) / 2;
      const y = padT + innerH - barH;
      const showLabel = i === 0 || i === rows.length - 1 || i === Math.floor(rows.length / 2);
      const dateShort = String(r.date || '').slice(5);
      return `
        <g class="usage-bar-group" data-date="${esc(r.date)}" data-req="${Number(r.requests) || 0}" data-tok="${Number(r.tokens) || 0}">
          <rect x="${x.toFixed(1)}" y="${padT}" width="${barW.toFixed(1)}" height="${innerH}" fill="transparent"></rect>
          <rect class="usage-bar-rect" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"
            rx="3" fill="${metric === 'tokens' ? 'var(--cyan)' : 'var(--accent)'}" opacity="0.86"></rect>
          ${showLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${esc(dateShort)}</text>` : ''}
        </g>`;
    }).join('');

    container.innerHTML = `
      <div class="row-between mb-sm">
        <span class="badge badge-neutral">${esc(t('overview.metricRequests'))}: ${esc(fmtCompact(totalReq))}</span>
        <span class="badge badge-neutral">${esc(t('overview.metricTokens'))}: ${esc(fmtCompact(totalTok))}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible">
        ${grid}
        ${bars}
      </svg>
      <div class="chart-tooltip hidden"></div>`;

    const tip = container.querySelector('.chart-tooltip');
    const svg = container.querySelector('svg');
    for (const g of container.querySelectorAll('.usage-bar-group')) {
      g.addEventListener('mouseenter', () => {
        const d = g.getAttribute('data-date');
        const req = g.getAttribute('data-req');
        const tok = fmtCompact(g.getAttribute('data-tok'));
        tip.innerHTML = `<strong>${esc(d)}</strong><br>${esc(req)} req · ${esc(tok)} tok`;
        tip.classList.remove('hidden');
      });
      g.addEventListener('mousemove', (ev) => {
        const rect = container.getBoundingClientRect();
        tip.style.left = `${Math.min(rect.width - 140, Math.max(8, ev.clientX - rect.left + 12))}px`;
        tip.style.top = `${Math.max(4, ev.clientY - rect.top - 42)}px`;
      });
      g.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    }
    svg.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  }

  function renderLiveTelemetry(container, logs, t) {
    if (!container) return;
    const recent = (Array.isArray(logs) ? logs.slice(0, 40) : []).reverse();
    const latencies = recent.map((l) => Number(l.ms)).filter((v) => Number.isFinite(v) && v >= 0);

    let okCount = 0;
    let warnCount = 0;
    let errCount = 0;
    for (const l of recent) {
      const s = Number(l.status) || 0;
      if (s >= 200 && s < 400) okCount++;
      else if (s >= 400 && s < 500) warnCount++;
      else if (s >= 500) errCount++;
    }
    const total = Math.max(1, okCount + warnCount + errCount);

    let sparkSvg = '<span class="muted">—</span>';
    let avgMs = 0;
    let maxMs = 0;
    if (latencies.length >= 2) {
      avgMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      maxMs = Math.round(Math.max(...latencies));
      const ceil = Math.max(10, maxMs);
      const w = 220;
      const h = 34;
      const pts = latencies.map((v, i) => {
        const x = (i / (latencies.length - 1)) * w;
        const y = h - 3 - (v / ceil) * (h - 6);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      sparkSvg = `
        <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">
          <polyline fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linejoin="round" points="${pts}"></polyline>
        </svg>`;
    } else if (latencies.length === 1) {
      avgMs = Math.round(latencies[0]);
      maxMs = avgMs;
    }

    container.innerHTML = `
      <div class="badge-row">
        <span class="badge badge-ok">2xx: ${okCount}</span>
        <span class="badge badge-warn">4xx: ${warnCount}</span>
        <span class="badge badge-err">5xx: ${errCount}</span>
        <div style="width:120px;height:8px;background:var(--bg-input);border-radius:99px;overflow:hidden;display:flex;border:1px solid var(--border)">
          <div style="width:${(okCount / total) * 100}%;background:var(--green);transition:width 0.3s ease"></div>
          <div style="width:${(warnCount / total) * 100}%;background:var(--amber);transition:width 0.3s ease"></div>
          <div style="width:${(errCount / total) * 100}%;background:var(--red);transition:width 0.3s ease"></div>
        </div>
      </div>
      <div class="badge-row">
        ${sparkSvg}
        <span class="muted mono-num">avg ${avgMs}ms / max ${maxMs}ms</span>
      </div>`;
  }

  global.AGCharts = {
    esc,
    fmtCompact,
    renderQuotaGauges,
    tickResetCountdowns,
    renderUsageChart,
    renderLiveTelemetry,
  };
})(window);

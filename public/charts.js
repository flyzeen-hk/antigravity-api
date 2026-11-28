'use strict';

(function (global) {
  let gradSeq = 0;

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

  function gaugeStops(pct) {
    if (pct === null || pct === undefined) return ['#64748b', '#94a3b8'];
    if (pct <= 15) return ['#ea4335', '#fb7185'];
    if (pct <= 40) return ['#f59e0b', '#fbbc05'];
    return ['#3182ff', '#34a853'];
  }

  function buildArcSvg(pct) {
    const gid = `ag-g-${++gradSeq}`;
    const r = 36;
    const c = 2 * Math.PI * r;
    const clamped = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, Number(pct)));
    const dash = (clamped / 100) * c;
    const [c1, c2] = gaugeStops(pct);
    let label = '—';
    if (pct !== null && pct !== undefined) {
      if (clamped > 99 && clamped < 100) label = `${clamped.toFixed(1)}%`;
      else if (clamped > 0 && clamped < 10 && Math.abs(clamped - Math.round(clamped)) >= 0.05) label = `${clamped.toFixed(1)}%`;
      else label = `${Math.floor(clamped + 1e-6)}%`;
    }
    return `
      <svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
        <defs>
          <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${c1}"></stop>
            <stop offset="100%" stop-color="${c2}"></stop>
          </linearGradient>
        </defs>
        <circle cx="46" cy="46" r="${r}" fill="none" stroke="var(--border)" stroke-width="7.5"></circle>
        <circle class="gauge-arc" cx="46" cy="46" r="${r}" fill="none" stroke="url(#${gid})" stroke-width="7.5"
          stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}"
          transform="rotate(-90 46 46)"></circle>
        <text x="46" y="50" text-anchor="middle" fill="var(--text)" font-size="15" font-weight="750" font-family="var(--font-sans)">${esc(label)}</text>
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
        const tip = [g.description, b.description].filter(Boolean).join(' — ');
        cards.push(`
          <div class="gauge-card" title="${esc(tip)}">
            ${buildArcSvg(pct)}
            <div class="gauge-title">${esc(title)}</div>
            <div class="gauge-sub" ${resetAttr}>${esc(resetStr)}</div>
          </div>`);
      }
    }

    // Fallback to catalog quotaFamilies ONLY when official retrieveUserQuotaSummary returned no groups.
    if (!cards.length) {
      const fams = limitsData.quotaFamilies || {};
      for (const [famKey, label] of [['gemini', 'Gemini Models'], ['claude', 'Claude Models'], ['gpt', 'GPT Models']]) {
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
    }

    if (!cards.length) {
      const errText = (limitsData.serverQuotas && limitsData.serverQuotas.error) || limitsData.modelsError || t('overview.noQuotas');
      container.innerHTML = `<div class="alert alert-warn"><span>${esc(errText)}</span></div>`;
      return;
    }

    const acc = limitsData.account || {};
    const fetchedAt = limitsData.serverQuotas && limitsData.serverQuotas.fetchedAt
      ? new Date(limitsData.serverQuotas.fetchedAt).toLocaleTimeString()
      : '';
    const metaParts = [
      acc.email ? acc.email : null,
      acc.tierId ? `${acc.tier || 'Tier'} (${acc.tierId})` : (acc.tier || null),
      acc.region ? acc.region : null,
      fetchedAt ? `${t('overview.updatedAt')}: ${fetchedAt}` : null,
    ].filter(Boolean);

    const footer = metaParts.length
      ? `<p class="hint mt-sm">${esc(metaParts.join(' · '))}</p>`
      : '';
    const tierNote = (acc.tierId === 'standard-tier' && acc.paidTier)
      ? `<p class="hint mt-xs">${esc(t('overview.freeTierHint', { paid: acc.paidTier }))}</p>`
      : '';

    container.innerHTML = `<div class="quota-grid">${cards.join('')}</div>${footer}${tierNote}`;
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
    const H = 180;
    const padL = 44;
    const padR = 12;
    const padT = 14;
    const padB = 26;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const step = innerW / rows.length;
    const barW = Math.max(5, Math.min(28, step * 0.66));
    const barGradId = `ag-bar-${++gradSeq}`;
    const [topColor, botColor] = metric === 'tokens'
      ? ['#34d399', '#0ea5e9']
      : ['#60a5fa', '#2563eb'];

    const grid = [0, 0.5, 1].map((frac) => {
      const y = padT + innerH * (1 - frac);
      const val = fmtCompact(maxVal * frac);
      return `
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-dasharray="3 3"></line>
        <text x="${padL - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--text-muted)" font-size="10.5" font-family="var(--font-mono)">${esc(val)}</text>`;
    }).join('');

    const bars = rows.map((r, i) => {
      const val = Number(r[metric]) || 0;
      const barH = Math.max(val > 0 ? 3 : 0, (val / maxVal) * innerH);
      const x = padL + i * step + (step - barW) / 2;
      const y = padT + innerH - barH;
      const showLabel = i === 0 || i === rows.length - 1 || i === Math.floor(rows.length / 2);
      const dateShort = String(r.date || '').slice(5);
      return `
        <g class="usage-bar-group" data-date="${esc(r.date)}" data-req="${Number(r.requests) || 0}" data-tok="${Number(r.tokens) || 0}">
          <rect x="${x.toFixed(1)}" y="${padT}" width="${barW.toFixed(1)}" height="${innerH}" fill="transparent"></rect>
          <rect class="usage-bar-rect" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"
            rx="4" fill="url(#${barGradId})" opacity="0.92"></rect>
          ${showLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${esc(dateShort)}</text>` : ''}
        </g>`;
    }).join('');

    container.innerHTML = `
      <div class="row-between mb-sm">
        <span class="badge badge-accent">${esc(t('overview.metricRequests'))}: ${esc(fmtCompact(totalReq))}</span>
        <span class="badge badge-ok">${esc(t('overview.metricTokens'))}: ${esc(fmtCompact(totalTok))}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible">
        <defs>
          <linearGradient id="${barGradId}" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="${topColor}"></stop>
            <stop offset="100%" stop-color="${botColor}"></stop>
          </linearGradient>
        </defs>
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

  function renderLiveTelemetry(container, logs) {
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
      const sparkGradId = `ag-sp-${++gradSeq}`;
      const coords = latencies.map((v, i) => {
        const x = (i / (latencies.length - 1)) * w;
        const y = h - 4 - (v / ceil) * (h - 8);
        return [x, y];
      });
      const pts = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      const areaPts = `0,${h} ${pts} ${w},${h}`;
      sparkSvg = `
        <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">
          <defs>
            <linearGradient id="${sparkGradId}" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#3182ff" stop-opacity="0.32"></stop>
              <stop offset="100%" stop-color="#3182ff" stop-opacity="0.0"></stop>
            </linearGradient>
          </defs>
          <polygon fill="url(#${sparkGradId})" points="${areaPts}"></polygon>
          <polyline fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pts}"></polyline>
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
        <div style="width:128px;height:8px;background:var(--bg-input);border-radius:99px;overflow:hidden;display:flex;border:1px solid var(--border)">
          <div style="width:${(okCount / total) * 100}%;background:var(--green-solid);transition:width 0.3s ease"></div>
          <div style="width:${(warnCount / total) * 100}%;background:var(--ag-yellow);transition:width 0.3s ease"></div>
          <div style="width:${(errCount / total) * 100}%;background:var(--ag-red);transition:width 0.3s ease"></div>
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

'use strict';

// fetch() с автоматическим фолбэком на резервный хост апстрима.
// Срабатывает ТОЛЬКО при сетевой ошибке (fetch кинул исключение: DNS/TCP/TLS).
// HTTP-статусы (401/429/503...) фолбэк НЕ вызывают — их разбирает вызывающий код.
//
// Практика сообщества (antigravity-claude-proxy): daily -> prod.
// daily:  https://daily-cloudcode-pa.googleapis.com   (staging)
// prod:   https://cloudcode-pa.googleapis.com         (production)
async function fetchWithFallback(primaryHost, fallbackHost, path, opts = {}, fetchImpl = fetch) {
  const norm = (h) => String(h || '').replace(/\/+$/, '');
  const hosts = [norm(primaryHost)];
  const fb = norm(fallbackHost);
  if (fb && fb !== hosts[0]) hosts.push(fb);
  let lastErr = null;
  for (let i = 0; i < hosts.length; i++) {
    try {
      return await fetchImpl(hosts[i] + path, opts);
    } catch (e) {
      lastErr = e;
      // Cancellation and an expired shared deadline cannot be fixed by another host.
      if (opts.signal?.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError') throw e;
      if (i < hosts.length - 1) {
        // Never log hostnames or transport exceptions: they may contain private routing data.
        console.log('  ! upstream недоступен — пробую резервный хост');
      }
    }
  }
  throw lastErr;
}

function netWhy(error) {
  const message = error?.message || String(error);
  const cause = error?.cause;
  const detail = cause?.message || cause?.code;
  return detail && detail !== message ? `${message}: ${detail}` : message;
}

module.exports = { fetchWithFallback, netWhy };

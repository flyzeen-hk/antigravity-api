'use strict';

/**
 * Pure Node.js local proxy auto-detector (zero external dependencies).
 *
 * Checks:
 * - Environment variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`)
 * - Windows Registry (`Internet Settings` ProxyEnable/ProxyServer)
 * - macOS `scutil --proxy`
 * - Common local proxy ports (Clash, v2rayN, Tor, Squid, local relays)
 *
 * Each unique `(scheme, host, port)` candidate is verified with a real local
 * SOCKS5 greeting or HTTP CONNECT handshake to `127.0.0.1:9` (zero external traffic).
 */

const net = require('net');
const { execFileSync } = require('child_process');

const COMMON_PORTS = [
  [7890, 'Clash / Mihomo'],
  [7897, 'Clash Verge'],
  [10809, 'v2rayN HTTP'],
  [10808, 'v2rayN SOCKS'],
  [18082, 'Local proxy / Relay'],
  [1080, 'SOCKS'],
  [8080, 'HTTP proxy'],
  [3128, 'Squid'],
  [8888, 'HTTP proxy'],
  [9150, 'Tor Browser'],
  [9050, 'Tor SOCKS'],
];

const DEFAULT_TIMEOUT_MS = 400;

function maskProxyUrl(url) {
  return String(url || '').replace(/(^[a-z0-9+.-]+:\/\/)([^/@\s]+@)/i, '$1***@');
}

function buildProxyUrl(scheme, host, port, username = '', password = '') {
  const auth = username ? `${username}${password ? ':' + password : ''}@` : '';
  const safeHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${scheme}://${auth}${safeHost}:${port}`;
}

function splitHostPort(raw, defaultPort = 80) {
  let value = String(raw || '').trim();
  if (!value) return null;
  let schemeHint = '';
  const schemeMatch = value.match(/^([a-z0-9+.-]+):\/\//i);
  if (schemeMatch) {
    schemeHint = schemeMatch[1].toLowerCase();
    value = value.slice(schemeMatch[0].length);
  }
  value = value.replace(/\/.*$/, '');
  let host = '';
  let portStr = '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    host = value.slice(1, end).trim();
    const rest = value.slice(end + 1).trim();
    portStr = rest.startsWith(':') ? rest.slice(1) : String(defaultPort);
  } else {
    const idx = value.lastIndexOf(':');
    if (idx === -1) {
      host = value;
      portStr = String(defaultPort);
    } else {
      host = value.slice(0, idx).trim();
      portStr = value.slice(idx + 1).trim();
    }
  }
  const port = Number(portStr);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, schemeHint };
}

function parseProxyUrl(url) {
  const m = String(url || '').trim().match(/^([a-z0-9+.-]+):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/]+):(\d+)(?:\/.*)?$/i);
  if (!m) return null;
  let scheme = m[1].toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h', 'socks'].includes(scheme)) return null;
  if (scheme.startsWith('socks')) scheme = 'socks5';
  const host = m[4].replace(/^\[|\]$/g, '');
  const port = Number(m[5]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    scheme,
    host,
    port,
    username: m[2] || '',
    password: m[3] || '',
  };
}

function envCandidates(env = process.env) {
  const out = [];
  const entries = [
    ['HTTPS_PROXY', 'http'], ['https_proxy', 'http'],
    ['HTTP_PROXY', 'http'], ['http_proxy', 'http'],
    ['ALL_PROXY', 'socks5'], ['all_proxy', 'socks5'],
  ];
  for (const [key, fallbackScheme] of entries) {
    let raw = String(env[key] || '').trim();
    if (!raw) continue;
    if (!raw.includes('://')) raw = `${fallbackScheme}://${raw}`;
    out.push({ url: raw, source: key });
  }
  return out;
}

function parseWindowsProxyServer(serverRaw) {
  const out = [];
  const server = String(serverRaw || '').trim();
  if (!server) return out;
  if (server.includes('=')) {
    for (const part of server.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const kind = part.slice(0, eq).trim().toLowerCase();
      const addr = part.slice(eq + 1).trim();
      const parsed = splitHostPort(addr, 80);
      if (!parsed) continue;
      const scheme = (parsed.schemeHint || (kind.startsWith('socks') ? 'socks5' : 'http'));
      const normScheme = scheme.startsWith('socks') ? 'socks5' : 'http';
      out.push({ url: buildProxyUrl(normScheme, parsed.host, parsed.port), source: 'Windows Internet Settings' });
    }
    return out;
  }
  const parsed = splitHostPort(server, 80);
  if (parsed) {
    const scheme = parsed.schemeHint && parsed.schemeHint.startsWith('socks') ? 'socks5' : 'http';
    out.push({ url: buildProxyUrl(scheme, parsed.host, parsed.port), source: 'Windows Internet Settings' });
  }
  return out;
}

function windowsSystemCandidates() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const enableMatch = out.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    const enabled = enableMatch ? parseInt(enableMatch[1], 16) : 0;
    if (!enabled) return [];
    const serverMatch = out.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!serverMatch) return [];
    return parseWindowsProxyServer(serverMatch[1]);
  } catch {
    return [];
  }
}

function macSystemCandidates() {
  if (process.platform !== 'darwin') return [];
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] });
    const get = (k) => {
      const m = out.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const res = [];
    if (get('HTTPEnable') === '1' && get('HTTPProxy') && get('HTTPPort')) {
      res.push({ url: buildProxyUrl('http', get('HTTPProxy'), Number(get('HTTPPort'))), source: 'macOS System Proxy' });
    }
    if (get('HTTPSEnable') === '1' && get('HTTPSProxy') && get('HTTPSPort')) {
      res.push({ url: buildProxyUrl('http', get('HTTPSProxy'), Number(get('HTTPSPort'))), source: 'macOS System Proxy' });
    }
    if (get('SOCKSEnable') === '1' && get('SOCKSProxy') && get('SOCKSPort')) {
      res.push({ url: buildProxyUrl('socks5', get('SOCKSProxy'), Number(get('SOCKSPort'))), source: 'macOS System Proxy' });
    }
    return res;
  } catch {
    return [];
  }
}

function portCandidates(ports = COMMON_PORTS) {
  const out = [];
  for (const [port, label] of ports) {
    out.push({ url: buildProxyUrl('http', '127.0.0.1', port), source: label });
    out.push({ url: buildProxyUrl('socks5', '127.0.0.1', port), source: label });
  }
  return out;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const ordered = [];
  for (const candidate of candidates) {
    const parsed = parseProxyUrl(candidate.url);
    if (!parsed) continue;
    // Key by (scheme, host, port) so SOCKS5 on the same port as HTTP is NOT dropped
    const key = `${parsed.scheme}://${parsed.host.toLowerCase()}:${parsed.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push({ ...candidate, parsed });
  }
  return ordered;
}

function probeSocks5(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.createConnection({ host, port });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('error', () => done(false));
    sock.on('connect', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    sock.on('data', (chunk) => {
      done(chunk.length >= 2 && chunk[0] === 0x05 && (chunk[1] === 0x00 || chunk[1] === 0x02));
    });
    sock.on('close', () => done(false));
  });
}

function probeHttp(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    const sock = net.createConnection({ host, port });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('error', () => done(false));
    sock.on('connect', () => {
      sock.write('CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\nProxy-Connection: close\r\n\r\n');
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 7) {
        done(buf.subarray(0, 7).toString('ascii') === 'HTTP/1.');
      }
    });
    sock.on('close', () => done(buf.subarray(0, 7).toString('ascii') === 'HTTP/1.'));
  });
}

async function probeCandidate(candidate, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const parsed = candidate.parsed || parseProxyUrl(candidate.url);
  if (!parsed) return null;
  const { scheme, host, port, username, password } = parsed;
  let actual = null;
  if (scheme === 'socks5') {
    if (await probeSocks5(host, port, timeoutMs)) actual = 'socks5';
  } else {
    if (await probeHttp(host, port, timeoutMs)) actual = 'http';
    else if (await probeSocks5(host, port, timeoutMs)) actual = 'socks5';
  }
  if (!actual) return null;
  const url = actual === scheme ? candidate.url : buildProxyUrl(actual, host, port, username, password);
  return {
    url,
    maskedUrl: maskProxyUrl(url),
    source: candidate.source,
    type: actual,
    reachable: true,
  };
}

async function detectProxies({ timeoutMs = DEFAULT_TIMEOUT_MS, includeSystem = true, ports = COMMON_PORTS } = {}) {
  const raw = [
    ...envCandidates(),
    ...(includeSystem ? [...windowsSystemCandidates(), ...macSystemCandidates()] : []),
    ...portCandidates(ports),
  ];
  const ordered = dedupeCandidates(raw);
  const results = await Promise.all(ordered.map((c) => probeCandidate(c, timeoutMs)));
  const found = [];
  const seen = new Set();
  for (const res of results) {
    if (!res) continue;
    const p = parseProxyUrl(res.url);
    if (!p) continue;
    const norm = `${res.type}://${p.host.toLowerCase()}:${p.port}`;
    if (seen.has(norm)) continue;
    seen.add(norm);
    found.push(res);
  }
  return found;
}

if (require.main === module) {
  const asJson = process.argv.includes('--json');
  detectProxies().then((proxies) => {
    if (asJson) {
      console.log(JSON.stringify(proxies, null, 2));
      return;
    }
    if (!proxies.length) {
      console.log('Прокси не найден (env, системные настройки и типовые порты проверены).');
      return;
    }
    for (const p of proxies) {
      console.log(`  ${p.maskedUrl.padEnd(40)} ${p.type.padEnd(6)} ${p.source}`);
    }
  }).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = {
  COMMON_PORTS,
  maskProxyUrl,
  splitHostPort,
  parseProxyUrl,
  parseWindowsProxyServer,
  dedupeCandidates,
  probeSocks5,
  probeHttp,
  probeCandidate,
  detectProxies,
};

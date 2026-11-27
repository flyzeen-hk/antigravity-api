'use strict';

// Единый сетевой слой: HTTP/HTTPS CONNECT, SOCKS5, DoH/custom DNS,
// агенты с keep-alive и probe-запросы для проверки маршрутов.
// Без внешних зависимостей: только http/https/tls/net/dns из Node.

const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const dns = require('dns');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 30000;

// ---------- config ----------

function normalizeNetworkConfig(config = {}) {
  const n = (config && config.network) || {};
  const legacyDns = Array.isArray(config.dnsServers) ? config.dnsServers : [];
  const netDns = Array.isArray(n.dnsServers) ? n.dnsServers : [];
  const dnsServers = (netDns.length ? netDns : legacyDns)
    .map((s) => String(s || '').trim())
    .filter((s) => net.isIP(s) !== 0);
  return {
    proxy: String(n.proxy || '').trim(),
    webProxy: String((config.geminiWeb && config.geminiWeb.proxy) || '').trim(),
    dohUrl: String(n.dohUrl || '').trim(),
    dnsServers,
    useEnvProxy: n.useEnvProxy !== false,
    timeoutMs: Number(n.timeoutMs) > 0 ? Number(n.timeoutMs) : DEFAULT_TIMEOUT_MS,
  };
}

function stripBrackets(host) {
  return String(host || '').replace(/^\[|\]$/g, '');
}

function parseProxyUrl(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'http://' + value;
  let u;
  try { u = new URL(value); } catch { return null; }
  const protocol = u.protocol.toLowerCase();
  if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks:'].includes(protocol)) return null;
  const type = protocol.startsWith('socks') ? 'socks5' : 'http';
  const port = Number(u.port) || (type === 'socks5' ? 1080 : protocol === 'https:' ? 443 : 80);
  const host = stripBrackets(u.hostname);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    url: `${protocol}//${u.username ? u.username + (u.password ? ':' + u.password : '') + '@' : ''}${host}:${port}`,
    type,
    tls: protocol === 'https:',
    host,
    port,
    username: u.username ? decodeURIComponent(u.username) : '',
    password: u.password ? decodeURIComponent(u.password) : '',
  };
}

function redactProxy(raw) {
  if (!raw) return '';
  const p = parseProxyUrl(raw);
  if (!p) return '(invalid proxy)';
  return `${p.type === 'socks5' ? 'socks5' : p.tls ? 'https' : 'http'}://${p.username ? '***@' : ''}${p.host}:${p.port}`;
}

function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isBypassed(hostname) {
  if (isLocalHost(hostname)) return true;
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!raw) return false;
  const host = String(hostname || '').toLowerCase();
  for (const itemRaw of raw.split(',')) {
    const item = itemRaw.trim().toLowerCase();
    if (!item) continue;
    if (item === '*') return true;
    const entryHost = item.split(':')[0].replace(/^\./, '');
    if (!entryHost) continue;
    if (host === entryHost || host.endsWith('.' + entryHost)) return true;
  }
  return false;
}

function envProxyFor(hostname) {
  if (isBypassed(hostname)) return '';
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
}

// VPN-клиенты (в том числе Antigravity Unlocker) часто включают только
// системный прокси Windows. Node его не читает сам, поэтому берём из реестра.
let systemProxyCache = { at: 0, value: '' };

function windowsSystemProxy() {
  if (process.platform !== 'win32') return '';
  const now = Date.now();
  if (now - systemProxyCache.at < 30000) return systemProxyCache.value;
  let value = '';
  try {
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    if (/\bProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) {
      const m = out.match(/\bProxyServer\s+REG_SZ\s+(.+)/i);
      if (m) {
        const raw = m[1].trim();
        let picked = '';
        if (raw.includes('=')) {
          for (const part of raw.split(';')) {
            const eq = part.indexOf('=');
            if (eq < 0) continue;
            const scheme = part.slice(0, eq).trim().toLowerCase();
            const addr = part.slice(eq + 1).trim();
            if (!addr) continue;
            if (scheme === 'https') { picked = addr; break; }
            if (scheme === 'http' && !picked) picked = addr;
          }
        } else {
          picked = raw;
        }
        if (picked && parseProxyUrl(picked)) value = picked;
      }
    }
  } catch {}
  systemProxyCache = { at: now, value };
  return value;
}

function systemProxyFor(hostname) {
  if (isBypassed(hostname)) return '';
  return windowsSystemProxy();
}

// AGUnlocker/antigravity-proxy поднимают локальный DNS, который отдаёт
// loopback-адреса для Cloud Code. Relay принимает только эти SNI;
// gemini.google.com идёт обычным маршрутом (relay получает captcha "sorry").
const RELAY_HOSTS = new Set([
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
]);

function isRelayHost(hostname) {
  return RELAY_HOSTS.has(String(hostname || '').toLowerCase());
}

async function detectRelayDns(hostname = 'daily-cloudcode-pa.googleapis.com', timeoutMs = 1200) {
  try {
    const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
    resolver.setServers(['127.0.0.53']);
    const addrs = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs + 300);
      resolver.resolve4(hostname, (err, list) => {
        clearTimeout(timer);
        if (err) reject(err); else resolve(list || []);
      });
    });
    const loopback = addrs.find((a) => /^127\./.test(a));
    if (loopback) return { server: '127.0.0.53', ip: loopback };
  } catch {}
  return null;
}

function makeRelayLookup(relayIp) {
  return makeCachedLookup(async (hostname, family) => {
    if (isRelayHost(hostname)) {
      return { addresses: [{ address: relayIp, family: 4 }], ttlMs: 3600000 };
    }
    const list = await dns.promises.lookup(hostname, { all: true, family: family || 0 });
    const addresses = (list || []).map((a) => ({ address: a.address, family: a.family }));
    if (!addresses.length) {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    return { addresses, ttlMs: 60000 };
  });
}

// ---------- DNS ----------

function normalizeLookupOptions(options) {
  if (typeof options === 'number') return { family: options, all: false };
  const o = options || {};
  return { family: o.family || 0, all: !!o.all };
}

function addressesForCallback(hostname, addresses, options, callback) {
  const list = (addresses || []).filter(Boolean);
  if (!list.length) {
    const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    return callback(err);
  }
  if (options.all) return callback(null, list);
  const picked = options.family === 6
    ? list.find((a) => a.family === 6)
    : options.family === 4
      ? list.find((a) => a.family === 4)
      : list[0];
  if (!picked) {
    const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    return callback(err);
  }
  return callback(null, picked.address, picked.family);
}

function makeCachedLookup(query, fallback = dns.lookup) {
  const cache = new Map();
  const inflight = new Map();

  function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = normalizeLookupOptions(options);
    if (net.isIP(hostname)) {
      if (opts.all) return callback(null, [{ address: hostname, family: net.isIP(hostname) }]);
      return callback(null, hostname, net.isIP(hostname));
    }
    if (isLocalHost(hostname)) {
      if (opts.all) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
      return callback(null, '127.0.0.1', 4);
    }

    const key = `${hostname}|${opts.family}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) {
      return addressesForCallback(hostname, hit.addresses, opts, callback);
    }

    let pending = inflight.get(key);
    if (!pending) {
      pending = query(hostname, opts.family)
        .then((result) => {
          const ttl = Math.max(30000, Math.min(600000, result.ttlMs || 120000));
          cache.set(key, { addresses: result.addresses, expires: Date.now() + ttl });
          return result.addresses;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    pending.then(
      (addresses) => addressesForCallback(hostname, addresses, opts, callback),
      () => fallback(hostname, options, callback)
    );
  }
  return lookup;
}

const DOH_BOOTSTRAP = {
  'cloudflare-dns.com': '1.1.1.1',
  'dns.google': '8.8.8.8',
  'dns.quad9.net': '9.9.9.9',
};
const DOH_SNI = {
  '1.1.1.1': 'cloudflare-dns.com',
  '1.0.0.1': 'cloudflare-dns.com',
  '8.8.8.8': 'dns.google',
  '8.8.4.4': 'dns.google',
  '9.9.9.9': 'dns.quad9.net',
};

function dohQuery(hostname, family, dohUrl, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(dohUrl); } catch { return reject(new Error('Invalid DoH URL')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('DoH URL must be http(s)'));
    const literal = net.isIP(u.hostname) !== 0;
    const connectHost = literal ? stripBrackets(u.hostname) : (DOH_BOOTSTRAP[u.hostname] || u.hostname);
    const sni = literal ? (DOH_SNI[u.hostname] || stripBrackets(u.hostname)) : u.hostname;
    const hostHeader = literal ? sni : u.hostname;
    const type = family === 6 ? 'AAAA' : 'A';
    const basePath = u.pathname && u.pathname !== '/' ? u.pathname : '/dns-query';
    const path = `${basePath}${basePath.includes('?') ? '&' : '?'}name=${encodeURIComponent(hostname)}&type=${type}`;
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      host: connectHost,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path,
      method: 'GET',
      servername: u.protocol === 'https:' ? sni : undefined,
      headers: { host: hostHeader, accept: 'application/dns-json', 'user-agent': 'antigravity-api/network' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 65536) chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`DoH HTTP ${res.statusCode}`));
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('DoH invalid JSON')); }
        const answers = Array.isArray(data.Answer) ? data.Answer : [];
        const wanted = family === 6 ? 28 : 1;
        const addresses = answers
          .filter((a) => Number(a.type) === wanted && typeof a.data === 'string')
          .map((a) => ({ address: a.data, family }))
          .filter((a) => net.isIP(a.address) === family);
        if (!addresses.length) return reject(new Error(`DoH: no ${type} answer`));
        const ttl = Math.min(...answers.map((a) => Number(a.TTL) || 300));
        resolve({ addresses, ttlMs: (Number.isFinite(ttl) ? ttl : 300) * 1000 });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('DoH timeout'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end();
  });
}

function createDohLookup(dohUrl, { timeoutMs = 5000 } = {}) {
  const query = async (hostname, family) => {
    if (family === 4 || family === 6) return dohQuery(hostname, family, dohUrl, timeoutMs);
    const [a, aaaa] = await Promise.allSettled([
      dohQuery(hostname, 4, dohUrl, timeoutMs),
      dohQuery(hostname, 6, dohUrl, timeoutMs),
    ]);
    const addresses = [];
    let ttlMs = 0;
    for (const result of [a, aaaa]) {
      if (result.status === 'fulfilled') {
        addresses.push(...result.value.addresses);
        ttlMs = Math.max(ttlMs, result.value.ttlMs || 0);
      }
    }
    if (!addresses.length) throw (a.status === 'rejected' ? a.reason : aaaa.reason);
    return { addresses, ttlMs: ttlMs || 120000 };
  };
  return makeCachedLookup(query);
}

function createPlainDnsLookup(servers) {
  const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(servers);
  const query = async (hostname, family) => {
    const lookupOne = (fam) => new Promise((resolve, reject) => {
      const fn = fam === 6 ? resolver.resolve6.bind(resolver) : resolver.resolve4.bind(resolver);
      fn(hostname, (err, list) => {
        if (err) return reject(err);
        resolve((list || []).map((address) => ({ address, family: fam })));
      });
    });
    if (family === 4 || family === 6) {
      return { addresses: await lookupOne(family), ttlMs: 300000 };
    }
    const [a, aaaa] = await Promise.allSettled([lookupOne(4), lookupOne(6)]);
    const addresses = [];
    for (const result of [a, aaaa]) {
      if (result.status === 'fulfilled') addresses.push(...result.value);
    }
    if (!addresses.length) throw (a.status === 'rejected' ? a.reason : aaaa.reason);
    return { addresses, ttlMs: 300000 };
  };
  return makeCachedLookup(query);
}

// ---------- socket helpers ----------

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.failure = null;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    };
    this.onError = (err) => this.fail(err);
    this.onClose = () => this.fail(new Error('Connection closed by proxy'));
    socket.on('data', this.onData);
    socket.once('error', this.onError);
    socket.once('close', this.onClose);
  }

  read(n, timeoutMs = 10000) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.buffer.length >= n) {
      const out = this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      return Promise.resolve(out);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(Object.assign(new Error('Proxy handshake timeout'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      const waiter = { n, resolve, reject, timer };
      this.waiters.push(waiter);
    });
  }

  flush() {
    while (this.waiters.length && this.buffer.length >= this.waiters[0].n) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      const out = this.buffer.subarray(0, waiter.n);
      this.buffer = this.buffer.subarray(waiter.n);
      waiter.resolve(out);
    }
  }

  fail(err) {
    if (!this.failure) this.failure = err;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  detach() {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    if (rest.length) this.socket.unshift(rest);
    return rest;
  }
}

function connectTcp({ host, port, lookup, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host,
      port,
      lookup: net.isIP(host) ? undefined : lookup,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`TCP connect timeout ${host}:${port}`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    });
    const onError = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once('error', onError);
  });
}

const SOCKS_REPLIES = {
  1: 'general SOCKS server failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

async function socks5Connect(proxy, targetHost, targetPort, lookup, timeoutMs) {
  const socket = await connectTcp({ host: proxy.host, port: proxy.port, lookup, timeoutMs });
  const reader = new SocketReader(socket);
  try {
    const methods = proxy.username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const hello = await reader.read(2, timeoutMs);
    if (hello[0] !== 0x05) throw new Error('SOCKS5: invalid version');
    if (hello[1] === 0xff) throw new Error('SOCKS5: no acceptable auth method');
    if (hello[1] === 0x02) {
      if (!proxy.username) throw new Error('SOCKS5: proxy requires authentication');
      const user = Buffer.from(proxy.username, 'utf8');
      const pass = Buffer.from(proxy.password || '', 'utf8');
      if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5: credentials too long');
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await reader.read(2, timeoutMs);
      if (auth[1] !== 0x00) throw new Error('SOCKS5: authentication failed');
    } else if (hello[1] !== 0x00) {
      throw new Error('SOCKS5: unsupported auth method');
    }

    const hostBuf = Buffer.from(String(targetHost), 'utf8');
    let addr;
    const ipVer = net.isIP(targetHost);
    if (ipVer === 4) {
      addr = Buffer.from([0x01, ...targetHost.split('.').map(Number)]);
    } else if (ipVer === 6) {
      const parts = targetHost.split(':');
      const expanded = [];
      // :: shorthand is expanded by the URL parser upstream only for URLs; handle common cases.
      const fill = 8 - parts.filter(Boolean).length;
      for (const part of parts) {
        if (part === '') { for (let i = 0; i < fill; i++) expanded.push(0); }
        else expanded.push(parseInt(part, 16));
      }
      const buf = Buffer.alloc(16);
      expanded.slice(0, 8).forEach((v, i) => buf.writeUInt16BE(v || 0, i * 2));
      addr = Buffer.concat([Buffer.from([0x04]), buf]);
    } else {
      if (hostBuf.length > 255) throw new Error('SOCKS5: hostname too long');
      addr = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
    }
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));

    const head = await reader.read(4, timeoutMs);
    if (head[0] !== 0x05) throw new Error('SOCKS5: invalid reply version');
    if (head[1] !== 0x00) throw new Error(`SOCKS5: ${SOCKS_REPLIES[head[1]] || 'request failed'}`);
    const atyp = head[3];
    if (atyp === 0x01) await reader.read(4, timeoutMs);
    else if (atyp === 0x04) await reader.read(16, timeoutMs);
    else if (atyp === 0x03) {
      const len = (await reader.read(1, timeoutMs))[0];
      await reader.read(len, timeoutMs);
    } else throw new Error('SOCKS5: invalid address type');
    await reader.read(2, timeoutMs);

    reader.detach();
    return socket;
  } catch (err) {
    reader.detach();
    socket.destroy();
    throw err;
  }
}

function httpProxyConnect(proxy, targetHost, targetPort, lookup, timeoutMs, callback) {
  const mod = proxy.tls ? https : http;
  const headers = { host: `${targetHost}:${targetPort}`, 'proxy-connection': 'keep-alive' };
  if (proxy.username) {
    const creds = Buffer.from(`${proxy.username}:${proxy.password || ''}`, 'utf8').toString('base64');
    headers['proxy-authorization'] = `Basic ${creds}`;
  }
  const req = mod.request({
    host: proxy.host,
    port: proxy.port,
    method: 'CONNECT',
    path: `${targetHost}:${targetPort}`,
    headers,
    agent: false,
    lookup: net.isIP(proxy.host) ? undefined : lookup,
    servername: proxy.tls && !net.isIP(proxy.host) ? proxy.host : undefined,
    timeout: timeoutMs,
  });
  let settled = false;
  const done = (err, socket) => {
    if (settled) { if (socket) socket.destroy(); return; }
    settled = true;
    callback(err, socket);
  };
  req.once('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      return done(new Error(`HTTP proxy CONNECT failed: ${res.statusCode}`));
    }
    done(null, socket);
  });
  req.once('timeout', () => req.destroy(Object.assign(new Error('HTTP proxy timeout'), { name: 'TimeoutError' })));
  req.once('error', (err) => done(err));
  req.end();
}

function connectThroughProxy(proxy, targetHost, targetPort, lookup, timeoutMs) {
  return proxy.type === 'socks5'
    ? socks5Connect(proxy, targetHost, targetPort, lookup, timeoutMs)
    : new Promise((resolve, reject) => {
        httpProxyConnect(proxy, targetHost, targetPort, lookup, timeoutMs, (err, socket) => {
          if (err) reject(err); else resolve(socket);
        });
      });
}

class ProxyHttpsAgent extends https.Agent {
  constructor(proxy, lookup, timeoutMs = DEFAULT_TIMEOUT_MS) {
    super({ keepAlive: true, maxSockets: 32 });
    this._proxy = proxy;
    this._lookup = lookup;
    this._timeoutMs = timeoutMs;
  }

  createConnection(options, callback) {
    const targetHost = stripBrackets(options.host || options.hostname || '');
    const targetPort = Number(options.port) || 443;
    let settled = false;
    const finish = (err, sock) => {
      if (settled) {
        if (sock) { try { sock.destroy(); } catch {} }
        return;
      }
      settled = true;
      callback(err, sock);
    };
    connectThroughProxy(this._proxy, targetHost, targetPort, this._lookup, this._timeoutMs).then((socket) => {
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || (net.isIP(targetHost) ? undefined : targetHost),
        ALPNProtocols: ['http/1.1'],
        ...(options.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
      }, () => finish(null, tlsSocket));
      tlsSocket.once('error', (err) => {
        try { socket.destroy(); } catch {}
        finish(err);
      });
    }, finish);
  }
}

class ProxyHttpAgent extends http.Agent {
  constructor(proxy, lookup, timeoutMs = DEFAULT_TIMEOUT_MS) {
    super({ keepAlive: true, maxSockets: 32 });
    this._proxy = proxy;
    this._lookup = lookup;
    this._timeoutMs = timeoutMs;
  }

  createConnection(options, callback) {
    const targetHost = stripBrackets(options.host || options.hostname || '');
    const targetPort = Number(options.port) || 80;
    let settled = false;
    const finish = (err, sock) => {
      if (settled) {
        if (sock) { try { sock.destroy(); } catch {} }
        return;
      }
      settled = true;
      callback(err, sock);
    };
    connectThroughProxy(this._proxy, targetHost, targetPort, this._lookup, this._timeoutMs)
      .then((socket) => finish(null, socket), finish);
  }
}

function createProxyAgent(proxy, lookup, timeoutMs = DEFAULT_TIMEOUT_MS, isHttps = true) {
  return isHttps
    ? new ProxyHttpsAgent(proxy, lookup, timeoutMs)
    : new ProxyHttpAgent(proxy, lookup, timeoutMs);
}

function createDirectAgent(lookup, isHttps = true, keepAlive = true) {
  const Mod = isHttps ? https : http;
  return new Mod.Agent({
    keepAlive,
    maxSockets: 32,
    lookup,
  });
}

// ---------- fetch-like client ----------

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

function timeoutError(ms) {
  return Object.assign(new Error(`Request timed out (${ms}ms)`), { name: 'TimeoutError' });
}

function responseFrom(res) {
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage || '',
    headers: res.headers || {},
    body: res,
    raw: res,
    async text() {
      const chunks = [];
      for await (const chunk of res) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    },
    async json() {
      return JSON.parse(await this.text());
    },
  };
}

function buildRequestOptions(network, url, opts = {}, route = 'default') {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const agent = network.agentFor(route, u.hostname, undefined, u.protocol);
  return {
    u,
    isHttps,
    agent,
    options: {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: opts.method || 'GET',
      headers: { ...(opts.headers || {}) },
      agent,
      // Google иногда отвечает огромными заголовками (Set-Cookie) — без этого
      // парсер Node падает HPE_HEADER_OVERFLOW и маршрут помечается недоступным.
      maxHeaderSize: 131072,
      // Fetch has no socket-idle timeout; only opt-in deadlines are applied below.
      timeout: opts.timeoutMs || 0,
    },
  };
}

async function netFetch(network, url, opts = {}, route = 'default') {
  const { isHttps, options } = buildRequestOptions(network, url, opts, route);
  if (opts.body != null) {
    const length = Buffer.isBuffer(opts.body) ? opts.body.length
      : typeof opts.body === 'string' ? Buffer.byteLength(opts.body) : null;
    if (length !== null && options.headers['content-length'] === undefined && options.headers['Content-Length'] === undefined) {
      options.headers['content-length'] = String(length);
    }
  }
  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(options);
    let signal = opts.signal || null;
    let activeRes = null;
    let settled = false;
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
        signal = null;
      }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      const err = abortError();
      req.destroy(err);
      if (activeRes) {
        try { activeRes.destroy(err); } catch {}
      }
      fail(err);
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (options.timeout > 0) {
      req.setTimeout(options.timeout, () => req.destroy(timeoutError(options.timeout)));
    }
    req.once('response', (res) => {
      settled = true;
      activeRes = res;
      res.once('end', cleanup);
      res.once('close', cleanup);
      res.once('error', cleanup);
      if (options.timeout > 0) res.setTimeout(options.timeout, () => res.destroy(timeoutError(options.timeout)));
      else if (req.socket) req.socket.setTimeout(0);
      resolve(responseFrom(res));
    });
    req.once('timeout', () => req.destroy(timeoutError(options.timeout)));
    req.once('error', fail);
    if (opts.body != null) {
      req.write(opts.body);
    }
    req.end();
  });
}

// ---------- network manager ----------

class NetworkManager {
  constructor(config = {}) {
    this._agents = new Map();
    this._autoDnsPromise = null;
    this._relayIp = '';
    this.updateConfig(config);
  }

  // Закрыть все keep-alive сокеты (вызывается при остановке сервера).
  destroyAll() {
    for (const agent of this._agents.values()) {
      try { agent.destroy(); } catch {}
    }
    this._agents.clear();
  }

  updateConfig(config = {}) {
    for (const agent of this._agents.values()) {
      try { agent.destroy(); } catch {}
    }
    this.config = config || {};
    this.settings = normalizeNetworkConfig(this.config);
    // Явный DNS/DoH пользователя отменяет авто-relay.
    if (this.settings.dnsServers.length || this.settings.dohUrl) this._relayIp = '';
    this._agents.clear();
    this._lookup = this._createLookup();
  }

  _createLookup() {
    if (this._relayIp) return makeRelayLookup(this._relayIp);
    if (this.settings.dohUrl) {
      try {
        return createDohLookup(this.settings.dohUrl, { timeoutMs: Math.min(5000, this.settings.timeoutMs) });
      } catch {
        return null;
      }
    }
    if (this.settings.dnsServers.length) return createPlainDnsLookup(this.settings.dnsServers);
    return null;
  }

  get lookup() {
    return this._lookup;
  }

  get active() {
    if (this._relayIp) return true;
    if (this.settings.proxy || this.settings.webProxy || this.settings.dohUrl || this.settings.dnsServers.length) return true;
    if (!this.settings.useEnvProxy) return false;
    if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY ||
      process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy) return true;
    return !!windowsSystemProxy();
  }

  // Однократный best-effort поиск локального relay-DNS (AGUnlocker).
  autoDetect() {
    if (!this.settings.useEnvProxy || this.settings.dnsServers.length || this.settings.dohUrl) {
      return Promise.resolve(this._relayIp);
    }
    if (this._autoDnsPromise) return this._autoDnsPromise;
    this._autoDnsPromise = (async () => {
      const info = await detectRelayDns();
      if (info && !this.settings.dnsServers.length && !this.settings.dohUrl) {
        this._relayIp = info.ip;
        this.updateConfig(this.config); // пересобрать lookup/агенты под relay
      }
      return this._relayIp;
    })();
    return this._autoDnsPromise;
  }

  proxyForHost(route, hostname, override) {
    // Relay-хосты обслуживает AGUnlocker: прокси их только ломает.
    if (this._relayIp && isRelayHost(hostname)) return null;
    let raw;
    if (override !== undefined && override !== null && override !== '') raw = override;
    else if (route === 'web' && this.settings.webProxy) raw = this.settings.webProxy;
    else raw = this.settings.proxy;
    // Explicit DNS relay wins for the API route; web still needs the browser proxy.
    const ambient = route !== 'upstream' || (!this.settings.dnsServers.length && !this.settings.dohUrl);
    if (!raw && ambient && this.settings.useEnvProxy) raw = envProxyFor(hostname);
    if (!raw && ambient && this.settings.useEnvProxy) raw = systemProxyFor(hostname);
    return raw ? parseProxyUrl(raw) : null;
  }

  agentFor(route, hostname, override, protocol = 'https:') {
    const isHttps = protocol === 'https:';
    const proxy = this.proxyForHost(route, hostname, override);
    if (proxy) {
      const key = `proxy|${isHttps ? 'https' : 'http'}|${proxy.url}`;
      if (!this._agents.has(key)) {
        this._agents.set(key, createProxyAgent(proxy, this._lookup, this.settings.timeoutMs, isHttps));
      }
      return this._agents.get(key);
    }
    if (!this._lookup || (protocol !== 'https:' && protocol !== 'http:')) return null;
    const useKeepAlive = !this._relayIp;
    const key = `${isHttps ? 'direct:https' : 'direct:http'}:${useKeepAlive ? 'ka' : 'noka'}`;
    if (!this._agents.has(key)) this._agents.set(key, createDirectAgent(this._lookup, isHttps, useKeepAlive));
    return this._agents.get(key);
  }

  async fetch(url, opts = {}, route = 'default') {
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch { return fetch(url, opts); }
    const proxy = this.proxyForHost(route, hostname);
    if (!proxy && !this._lookup) return fetch(url, opts);
    return netFetch(this, url, opts, route);
  }

  async probe(url, route = 'default', timeoutMs = 5000) {
    let parsed;
    try { parsed = new URL(url); } catch { return { ok: false, error: 'invalid URL' }; }
    const proxy = this.proxyForHost(route, parsed.hostname);
    const started = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve({ ms: Date.now() - started, via: proxy ? 'proxy' : 'direct', proxyType: proxy ? proxy.type : null, ...result });
      };
      let options;
      try {
        ({ options } = buildRequestOptions(this, url, { method: 'GET', timeoutMs }, route));
      } catch (err) {
        return finish({ ok: false, error: err.message });
      }
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(options);
      req.setTimeout(timeoutMs, () => req.destroy(timeoutError(timeoutMs)));
      req.once('response', (res) => {
        finish({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode });
        res.destroy();
      });
      req.once('timeout', () => req.destroy(timeoutError(timeoutMs)));
      req.once('error', (err) => finish({ ok: false, error: err.message, code: err.code || err.name }));
      req.end();
    });
  }

  async probeProxy(proxy, timeoutMs = 5000) {
    const started = Date.now();
    const targetHost = 'daily-cloudcode-pa.googleapis.com';
    try {
      if (proxy.type === 'socks5') {
        const socket = await socks5Connect(proxy, targetHost, 443, this._lookup, timeoutMs);
        socket.destroy();
      } else {
        await new Promise((resolve, reject) => {
          httpProxyConnect(proxy, targetHost, 443, this._lookup, timeoutMs, (err, socket) => {
            if (err) reject(err); else { socket.destroy(); resolve(); }
          });
        });
      }
      return { ok: true, ms: Date.now() - started, type: proxy.type, host: proxy.host, port: proxy.port };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, type: proxy.type, host: proxy.host, port: proxy.port, error: err.message };
    }
  }

  async test(timeoutMs = 5000) {
    const upstreamHost = String(this.config.upstreamHost || 'https://daily-cloudcode-pa.googleapis.com').replace(/\/+$/, '');
    const targets = [
      { name: 'cloudcode', label: 'Cloud Code', url: upstreamHost + '/' },
      { name: 'oauth', label: 'OAuth', url: 'https://oauth2.googleapis.com/' },
      { name: 'web', label: 'Gemini Web', url: 'https://gemini.google.com/app' },
    ];
    const hostnames = [...new Set(targets.map((t) => new URL(t.url).hostname))];
    const dnsResults = await Promise.all(hostnames.map(async (hostname) => {
      const started = Date.now();
      try {
        const addresses = await new Promise((resolve, reject) => {
          const fn = this._lookup || dns.lookup;
          fn(hostname, { all: true }, (err, list) => {
            if (err) reject(err); else resolve(list);
          });
        });
        return { host: hostname, ok: true, ms: Date.now() - started, addresses: addresses.map((a) => a.address).slice(0, 4) };
      } catch (err) {
        return { host: hostname, ok: false, ms: Date.now() - started, error: err.message, code: err.code };
      }
    }));
    const routes = await Promise.all(targets.map((t) => this.probe(t.url, t.name === 'cloudcode' ? 'upstream' : t.name, timeoutMs)));
    const proxy = this.proxyForHost('upstream', 'daily-cloudcode-pa.googleapis.com');
    const proxyResult = proxy ? await this.probeProxy(proxy, timeoutMs) : null;
    const routesOut = targets.map((t, i) => ({ name: t.name, label: t.label, host: new URL(t.url).hostname, ...routes[i] }));
    return {
      ok: routesOut.every((r) => r.ok) && (!proxyResult || proxyResult.ok),
      proxy: proxyResult,
      dnsMode: this.settings.dohUrl ? 'doh' : this.settings.dnsServers.length ? 'custom' : 'system',
      dohHost: this.settings.dohUrl ? (() => { try { return new URL(this.settings.dohUrl).hostname; } catch { return ''; } })() : '',
      dnsServers: this.settings.dnsServers,
      dns: dnsResults,
      routes: routesOut,
    };
  }

  summary() {
    let dohHost = '';
    if (this.settings.dohUrl) {
      try { dohHost = new URL(this.settings.dohUrl).hostname; } catch { dohHost = this.settings.dohUrl; }
    }
    const envProxy = this.settings.useEnvProxy ? envProxyFor('daily-cloudcode-pa.googleapis.com') : '';
    const systemProxy = this.settings.useEnvProxy ? systemProxyFor('daily-cloudcode-pa.googleapis.com') : '';
    return {
      active: this.active,
      relay: this._relayIp || '',
      proxy: redactProxy(this.settings.proxy),
      webProxy: redactProxy(this.settings.webProxy),
      envProxy: redactProxy(envProxy),
      systemProxy: redactProxy(systemProxy),
      dohHost,
      dnsMode: this.settings.dohUrl ? 'doh' : this.settings.dnsServers.length ? 'custom' : 'system',
      dnsServers: this.settings.dnsServers,
    };
  }
}

module.exports = {
  NetworkManager,
  normalizeNetworkConfig,
  parseProxyUrl,
  redactProxy,
  isBypassed,
  isRelayHost,
  detectRelayDns,
  createDohLookup,
  createPlainDnsLookup,
  createProxyAgent,
  createDirectAgent,
  socks5Connect,
  httpProxyConnect,
};

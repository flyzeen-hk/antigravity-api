'use strict';

/**
 * Opt-in Free Gemini Auto-Proxy Tunnel Manager (`lib/free_tunnel.js`).
 *
 * Strictly opt-in (`enabled: false` by default): nothing is downloaded or spawned
 * unless the user explicitly enables Free Auto-Proxy in the Gemini Web tab
 * (or supplies their own `vless://` link / subscription URL).
 *
 * How it works:
 * 1. Downloads official `XTLS/Xray-core` release into `%LOCALAPPDATA%\AntigravityAPI\bin\xray`
 *    and verifies SHA-256 against the official release digest before extracting.
 * 2. Fetches open auto-updated `VLESS + Reality / TLS` community feeds (or user's custom
 *    `vless://` key / Base64 subscription), filtering out private/loopback IPs (SSRF guard)
 *    and Gemini-unsupported regions (RU/BY/CN/HK/IR).
 * 3. Pre-filters candidates by fast TCP handshake (<950ms), then launches a single temporary
 *    multi-inbound Xray probe to test ~10 candidates concurrently against `gemini.google.com/app`
 *    and `StreamGenerate` — rejecting TSPU resets, Google `/sorry/` CAPTCHAs, and region error `1060`.
 * 4. Runs a local loopback-only SOCKS5 proxy (`socks5://127.0.0.1:<port>`) for Gemini Web & browser
 *    cookie import without touching OS-wide network settings or requiring administrator privileges.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { NetworkManager } = require('./net');
const { readJsonFile, writeFileAtomic, removeTree } = require('./safe_files');

const XRAY_RELEASE_API = 'https://api.github.com/repos/XTLS/Xray-core/releases/latest';
const PREFERRED_SOCKS_PORT = 18480;

const DEFAULT_VLESS_FEEDS = [
  'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/Vless-Reality-White-Lists-Rus-Mobile.txt',
  'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS_mobile.txt',
  'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS.txt',
  'https://raw.githubusercontent.com/zieng2/wl/main/vless_universal.txt',
  'https://raw.githubusercontent.com/Andrejewild/happ-v2rayng-configs/main/sub.txt',
  'https://raw.githubusercontent.com/slxkware/Vless-list/main/White%20Vless.txt',
  'https://raw.githubusercontent.com/slxkware/Vless-list/main/Black%20Vless.txt',
  'https://raw.githubusercontent.com/nikita29a/FreeProxyList/main/mirror/26.txt',
  'https://raw.githubusercontent.com/lm705/vair/main/all_alive.txt',
  'https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/Countries/Finland.txt',
  'https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/Countries/Germany.txt',
  'https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/Countries/Sweden.txt',
  'https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/Countries/Poland.txt',
  'https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/Countries/Estonia.txt',
  'https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/Countries/Kazakhstan.txt',
  'https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/Countries/Singapore.txt',
  'https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/Countries/Japan.txt',
];

const DEFAULT_FALLBACK_FEEDS = [
  'https://raw.githubusercontent.com/nikita29a/FreeProxyList/main/mirror/25.txt',
  'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Splitted-By-Protocol/vless.txt',
  'https://raw.githubusercontent.com/kort0881/vpn-vless-configs-russia/main/data/githubmirror/clean/vless.txt',
  'https://raw.githubusercontent.com/kort0881/vpn-vless-configs-russia/main/data/githubmirror/clean/trojan.txt',
  'https://raw.githubusercontent.com/kort0881/vpn-vless-configs-russia/main/data/githubmirror/clean/hysteria2.txt',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PBK_RE = /^[A-Za-z0-9_-]{40,48}=*$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const VALID_FP = new Set(['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized']);
const BLOCKED_REMARK_RE = /(?:🇷🇺|🇧🇾|🇨🇳|🇭🇰|🇮🇷|🇰🇵|\b(?:russia|moscow|spb|petersburg|belarus|minsk|china|hong\s*kong|iran|ru|rus|by|blr|cn|hk|ir)\b|(?:^|[^а-яё])(?:россия|москва|беларусь|минск|китай|иран|рф)(?=$|[^а-яё]))/i;
const NEARBY_COUNTRY_REMARK_RE = /(?:🇳🇱|🇩🇪|🇫🇮|🇸🇪|🇵🇱|🇪🇪|🇱🇻|🇱🇹|🇦🇹|🇨🇿|🇬🇧|🇫🇷|🇨🇭|🇳🇴|🇩🇰|🇮🇹|🇪🇸|🇷🇴|🇧🇬|🇭🇺|🇰🇿|🇹🇷|🇸🇬|🇯🇵|🇰🇷|🇦🇪|🇬🇪|🇦🇲|🇺🇿|🇲🇩|\b(?:nl|netherlands|amsterdam|de|germany|frankfurt|fi|finland|helsinki|se|sweden|stockholm|pl|poland|warsaw|ee|estonia|tallinn|lv|latvia|riga|lt|lithuania|at|austria|vienna|cz|czechia|prague|ch|switzerland|zurich|no|norway|dk|denmark|gb|uk|london|fr|france|paris|it|italy|milan|es|spain|ro|romania|bg|bulgaria|kz|kazakhstan|almaty|astana|tr|turkey|istanbul|sg|singapore|jp|japan|tokyo|kr|korea|seoul)\b|(?:^|[^а-яё])(?:польш[а-яё]*|германи[а-яё]*|финлянди[а-яё]*|нидерланд[а-яё]*|голланди[а-яё]*|швеци[а-яё]*|латви[а-яё]*|эстони[а-яё]*|литв[а-яё]*|казахстан[а-яё]*|швейцари[а-яё]*|франци[а-яё]*|итали[а-яё]*|япони[а-яё]*|сингапур[а-яё]*|коре[а-яё]*|турци[а-яё]*|чехи[а-яё]*|австри[а-яё]*|великобритани[а-яё]*)(?=$|[^а-яё]))/i;
const DISTANT_COUNTRY_REMARK_RE = /(?:🇺🇸|🇨🇦|🇧🇷|🇲🇽|🇦🇺|🇦🇷|🇨🇱|\b(?:us|usa|united\s*states|ca|canada|toronto|montreal|new\s*york|dallas|seattle|brazil|australia)\b|(?:^|[^а-яё])(?:сша|канада|бразилия|австралия)(?=$|[^а-яё]))/i;
const PREFERRED_REMARK_RE = new RegExp(`(?:${NEARBY_COUNTRY_REMARK_RE.source}|${DISTANT_COUNTRY_REMARK_RE.source})`, 'i');

function isDistantOrAnycastNode(node) {
  const lbl = String((node && node.label) || '');
  if (/(?:anycast|cloudflare)/i.test(lbl)) return true;
  if (DISTANT_COUNTRY_REMARK_RE.test(lbl) && !NEARBY_COUNTRY_REMARK_RE.test(lbl)) return true;
  return false;
}

function computeNodeRankMs(node, warmMs) {
  const base = Number(warmMs) || 9999;
  const usesFrag = node && node.security === 'tls' && node.proto !== 'hy2';
  // Penalize shared fragmented TLS tunnels & transoceanic locations vs direct EU/CIS/Asia Reality servers
  return base + (usesFrag ? 450 : 0) + (isDistantOrAnycastNode(node) ? 250 : 0);
}

function isBlockedRegionRemark(remark) {
  if (!remark) return false;
  if (!BLOCKED_REMARK_RE.test(remark)) return false;
  // Multi-country Anycast CDN labels list multiple edge countries (e.g. "Anycast-IP | CA DE RU")
  // while exiting via supported Cloudflare PoPs; don't discard them for mentioning RU/IR alongside EU/US.
  if (/(?:anycast|cloudflare)/i.test(remark) && PREFERRED_REMARK_RE.test(remark)) return false;
  return true;
}

// ---- Helpers: Proxy Link Converters & Private IP Guard ----

function convertTelegramSocksLink(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^(?:tg:\/\/proxy|https?:\/\/t\.me\/proxy)\b/i.test(s)) {
    const err = new Error('MTProto-прокси Telegram (tg://proxy) поддерживают только протокол мессенджера Telegram и технически не могут открывать сайты. Используйте переключатель «Бесплатный авто-прокси для Gemini» или SOCKS5/VLESS.');
    err.code = 'mtproto_unsupported';
    throw err;
  }
  if (/^(?:tg:\/\/socks|https?:\/\/t\.me\/socks)\b/i.test(s)) {
    try {
      const normalized = s.replace(/^tg:\/\/socks/i, 'http://t.me/socks');
      const u = new URL(normalized);
      const server = (u.searchParams.get('server') || '').trim();
      const port = Number(u.searchParams.get('port'));
      const user = (u.searchParams.get('user') || '').trim();
      const pass = (u.searchParams.get('pass') || '').trim();
      if (!server || !Number.isInteger(port) || port < 1 || port > 65535) return s;
      const auth = user ? `${encodeURIComponent(user)}${pass ? ':' + encodeURIComponent(pass) : ''}@` : '';
      return `socks5://${auth}${server}:${port}`;
    } catch {
      return s;
    }
  }
  return s;
}

function isPrivateOrReservedHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const ipKind = net.isIP(h);
  if (ipKind === 6) return true; // skip IPv6 literals to prevent IPv6 routing leaks / SSRF
  if (ipKind === 4) {
    const p = h.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  return !DOMAIN_RE.test(h);
}

function cleanNodeRemark(remark, address, port) {
  return (remark || `${address}:${port}`)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 64);
}

function parseVlessUri(rawUri, { allowAnyRegion = false } = {}) {
  const line = String(rawUri || '').trim();
  if (!line.toLowerCase().startsWith('vless://')) return null;
  let u;
  try { u = new URL(line); } catch { return null; }

  const uuid = decodeURIComponent(u.username || '').trim();
  if (!UUID_RE.test(uuid)) return null;

  const address = u.hostname.replace(/^\[|\]$/g, '').trim();
  if (isPrivateOrReservedHost(address)) return null;

  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  let remark = '';
  try { remark = decodeURIComponent((u.hash || '').replace(/^#/, '')).trim(); } catch { remark = (u.hash || '').replace(/^#/, '').trim(); }
  if (!allowAnyRegion && isBlockedRegionRemark(remark)) return null;

  const sp = u.searchParams;
  if (sp.get('allowInsecure') === '1' || sp.get('insecure') === '1') return null;
  let network = (sp.get('type') || 'tcp').trim().toLowerCase();
  if (network === 'raw') network = 'tcp';
  if (network === 'splithttp') network = 'xhttp';
  if (!['tcp', 'ws', 'grpc', 'httpupgrade', 'xhttp'].includes(network)) return null;
  if (network === 'tcp' && sp.get('headerType') && sp.get('headerType') !== 'none') return null;

  const encryption = (sp.get('encryption') || 'none').trim().toLowerCase();
  if (encryption !== 'none') return null;

  const security = (sp.get('security') || 'none').trim().toLowerCase();
  if (security !== 'reality' && security !== 'tls') return null;

  const flow = (sp.get('flow') || '').trim();
  if (flow && (flow !== 'xtls-rprx-vision' || network !== 'tcp')) return null;

  const fpRaw = (sp.get('fp') || 'chrome').trim().toLowerCase();
  const fp = VALID_FP.has(fpRaw) ? fpRaw : 'chrome';

  let sni = (sp.get('sni') || sp.get('host') || '').trim();
  let pbk = '';
  let sid = '';
  let spx = '/';
  let alpn = undefined;

  if (security === 'reality') {
    pbk = (sp.get('pbk') || '').trim();
    sid = (sp.get('sid') || '').trim();
    spx = (sp.get('spx') || '/').trim() || '/';
    if (!PBK_RE.test(pbk)) return null;
    if (!sni || !DOMAIN_RE.test(sni)) return null;
    if (!/^[0-9a-fA-F]{0,16}$/.test(sid) || (sid.length % 2 !== 0)) return null;
  } else {
    if (!sni) sni = net.isIP(address) ? '' : address;
    if (!sni || !DOMAIN_RE.test(sni)) return null;
    const alpnRaw = (sp.get('alpn') || '').trim();
    if (alpnRaw) {
      const list = alpnRaw.split(',').map((x) => x.trim()).filter((x) => ['h2', 'http/1.1', 'h3'].includes(x));
      if (list.length) alpn = list;
    }
  }

  let score = 0;
  if (security === 'reality') score += 48;
  else if (network === 'xhttp') score += 28;
  else if (network === 'ws') score += 20;
  if (net.isIP(address) === 4) score += 10;
  if (network === 'tcp') score += 15;
  if (port === 443 || port === 8443) score += 8;
  if (remark && NEARBY_COUNTRY_REMARK_RE.test(remark)) score += 28;
  if (remark && /(?:anycast|cloudflare)/i.test(remark)) score -= 12;

  return {
    proto: 'vless',
    key: `vless:${address.toLowerCase()}:${port}:${uuid.slice(0, 8)}:${sni.toLowerCase()}`,
    rawUri: line,
    uuid,
    address,
    port,
    network,
    security,
    flow,
    fp,
    sni,
    pbk,
    sid,
    spx,
    alpn,
    wsPath: sp.get('path') || '/',
    wsHost: sp.get('host') || '',
    serviceName: sp.get('serviceName') || '',
    grpcMulti: sp.get('mode') === 'multi',
    xhttpMode: sp.get('mode') || 'auto',
    label: cleanNodeRemark(remark, address, port),
    score,
  };
}

function parseTrojanUri(rawUri, { allowAnyRegion = false } = {}) {
  const line = String(rawUri || '').trim();
  if (!line.toLowerCase().startsWith('trojan://')) return null;
  let u;
  try { u = new URL(line); } catch { return null; }

  const password = decodeURIComponent(u.username || '').trim();
  if (!password || password.length > 256) return null;

  const address = u.hostname.replace(/^\[|\]$/g, '').trim();
  if (isPrivateOrReservedHost(address)) return null;

  const port = Number(u.port || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  let remark = '';
  try { remark = decodeURIComponent((u.hash || '').replace(/^#/, '')).trim(); } catch { remark = (u.hash || '').replace(/^#/, '').trim(); }
  if (!allowAnyRegion && isBlockedRegionRemark(remark)) return null;

  const sp = u.searchParams;
  if (sp.get('allowInsecure') === '1' || sp.get('insecure') === '1') return null;

  const network = (sp.get('type') || 'tcp').trim().toLowerCase();
  if (!['tcp', 'ws', 'grpc'].includes(network)) return null;

  const security = (sp.get('security') || 'tls').trim().toLowerCase();
  if (security !== 'tls') return null;

  const sni = (sp.get('sni') || sp.get('peer') || sp.get('host') || (net.isIP(address) ? '' : address)).trim();
  if (!sni || !DOMAIN_RE.test(sni)) return null;

  const fpRaw = (sp.get('fp') || 'chrome').trim().toLowerCase();
  const fp = VALID_FP.has(fpRaw) ? fpRaw : 'chrome';

  let alpn = undefined;
  const alpnRaw = (sp.get('alpn') || '').trim();
  if (alpnRaw) {
    const list = alpnRaw.split(',').map((x) => x.trim()).filter((x) => ['h2', 'http/1.1', 'h3'].includes(x));
    if (list.length) alpn = list;
  }

  let score = 20;
  if (port === 443 || port === 8443) score += 8;
  if (remark && NEARBY_COUNTRY_REMARK_RE.test(remark)) score += 24;

  return {
    proto: 'trojan',
    key: `trojan:${address.toLowerCase()}:${port}:${crypto.createHash('sha1').update(password).digest('hex').slice(0, 8)}:${sni.toLowerCase()}`,
    rawUri: line,
    password,
    address,
    port,
    network,
    security: 'tls',
    fp,
    sni,
    alpn,
    wsPath: sp.get('path') || '/',
    wsHost: sp.get('host') || '',
    serviceName: sp.get('serviceName') || '',
    grpcMulti: sp.get('mode') === 'multi',
    label: cleanNodeRemark(remark, address, port),
    score,
  };
}

function parseHy2Uri(rawUri, { allowAnyRegion = false } = {}) {
  const line = String(rawUri || '').trim();
  if (!/^(?:hysteria2|hy2):\/\//i.test(line)) return null;
  const normalizedUrl = line.replace(/^(?:hysteria2|hy2):\/\//i, 'https://');
  let u;
  try { u = new URL(normalizedUrl); } catch { return null; }

  const auth = decodeURIComponent(u.username || '').trim();
  if (!auth || auth.length > 256) return null;

  const address = u.hostname.replace(/^\[|\]$/g, '').trim();
  if (isPrivateOrReservedHost(address)) return null;

  const port = Number(u.port || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  let remark = '';
  try { remark = decodeURIComponent((u.hash || '').replace(/^#/, '')).trim(); } catch { remark = (u.hash || '').replace(/^#/, '').trim(); }
  if (!allowAnyRegion && isBlockedRegionRemark(remark)) return null;

  const sp = u.searchParams;
  if (sp.get('insecure') === '1' || sp.get('allowInsecure') === '1') return null;

  const sni = (sp.get('sni') || (net.isIP(address) ? '' : address)).trim();
  if (!sni || !DOMAIN_RE.test(sni)) return null;

  const obfs = (sp.get('obfs') || '').trim().toLowerCase();
  const obfsPassword = (sp.get('obfs-password') || '').trim();
  if (obfs && (obfs !== 'salamander' || !obfsPassword)) return null;

  let score = 22;
  if (port === 443 || port === 8443) score += 8;
  if (remark && NEARBY_COUNTRY_REMARK_RE.test(remark)) score += 24;

  return {
    proto: 'hy2',
    key: `hy2:${address.toLowerCase()}:${port}:${crypto.createHash('sha1').update(auth).digest('hex').slice(0, 8)}:${sni.toLowerCase()}`,
    rawUri: line,
    auth,
    address,
    port,
    network: 'hysteria',
    security: 'tls',
    sni,
    obfs,
    obfsPassword,
    label: cleanNodeRemark(remark, address, port),
    score,
  };
}

function parseProxyUri(rawUri, opts = {}) {
  const s = String(rawUri || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.startsWith('vless://')) return parseVlessUri(s, opts);
  if (lower.startsWith('trojan://')) return parseTrojanUri(s, opts);
  if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://')) return parseHy2Uri(s, opts);
  return null;
}

function buildFragmentOutbound(tag = 'frag') {
  return {
    tag,
    protocol: 'freedom',
    settings: {
      // Empirical balance for Russian TSPU: 10-20 byte segments defeat SNI reassembly
      // while 3-5ms spacing cuts Chrome multi-connection handshake sleep ~3x.
      fragment: { packets: 'tlshello', length: '10-20', interval: '3-5' },
    },
  };
}

function buildXrayOutbound(node, tag = 'proxy', { useFragment = true } = {}) {
  const proto = node.proto || 'vless';

  if (proto === 'hy2') {
    const streamSettings = {
      network: 'hysteria',
      security: 'tls',
      // Xray v26+ removed allowInsecure; standard TLS verification stays enabled by default.
      tlsSettings: { serverName: node.sni },
      hysteriaSettings: { version: 2, auth: node.auth },
    };
    if (node.obfs === 'salamander' && node.obfsPassword) {
      streamSettings.udpmaskManager = {
        type: 'salamander',
        settings: { password: node.obfsPassword },
      };
    }
    return {
      tag,
      protocol: 'hysteria',
      settings: { version: 2, address: node.address, port: node.port },
      streamSettings,
    };
  }

  if (proto === 'trojan') {
    const streamSettings = {
      network: node.network,
      security: 'tls',
      tlsSettings: {
        serverName: node.sni,
        fingerprint: node.fp || 'chrome',
        ...(node.alpn ? { alpn: node.alpn } : {}),
      },
      ...(useFragment ? { sockopt: { dialerProxy: 'frag' } } : {}),
    };
    if (node.network === 'ws') {
      streamSettings.wsSettings = {
        path: node.wsPath || '/',
        ...(node.wsHost ? { host: node.wsHost } : {}),
      };
    } else if (node.network === 'grpc') {
      streamSettings.grpcSettings = {
        serviceName: node.serviceName || '',
        multiMode: !!node.grpcMulti,
      };
    }
    return {
      tag,
      protocol: 'trojan',
      settings: {
        servers: [{ address: node.address, port: node.port, password: node.password }],
      },
      streamSettings,
    };
  }

  const user = {
    id: node.uuid,
    encryption: 'none',
  };
  if (node.flow) user.flow = node.flow;

  const streamSettings = {
    network: node.network,
    security: node.security,
  };

  if (node.security === 'reality') {
    streamSettings.realitySettings = {
      fingerprint: node.fp,
      serverName: node.sni,
      publicKey: node.pbk,
      shortId: node.sid,
      spiderX: node.spx,
    };
  } else if (node.security === 'tls') {
    streamSettings.tlsSettings = {
      serverName: node.sni,
      fingerprint: node.fp,
      ...(node.alpn ? { alpn: node.alpn } : {}),
    };
    if (useFragment) {
      // TSPU drops unfragmented ClientHello to Cloudflare & common CDNs in Russia;
      // tlshello fragmentation bypasses SNI DPI while leaving Reality handshakes untouched.
      streamSettings.sockopt = { dialerProxy: 'frag' };
    }
  }

  if (node.network === 'ws') {
    streamSettings.wsSettings = {
      path: node.wsPath || '/',
      ...(node.wsHost ? { host: node.wsHost } : {}),
    };
  } else if (node.network === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: node.serviceName || '',
      multiMode: !!node.grpcMulti,
    };
  } else if (node.network === 'httpupgrade') {
    streamSettings.httpupgradeSettings = {
      path: node.wsPath || '/',
      ...(node.wsHost ? { host: node.wsHost } : {}),
    };
  } else if (node.network === 'xhttp') {
    streamSettings.xhttpSettings = {
      path: node.wsPath || '/',
      mode: ['auto', 'packet-up', 'stream-up', 'stream-one'].includes(node.xhttpMode) ? node.xhttpMode : 'auto',
      ...(node.wsHost ? { host: node.wsHost } : {}),
    };
  }

  return {
    tag,
    protocol: 'vless',
    settings: {
      vnext: [
        {
          address: node.address,
          port: node.port,
          users: [user],
        },
      ],
    },
    streamSettings,
  };
}

// ---- HTTP Fetch & Xray Binary Installer ----

function httpsGetBuffer(url, { timeoutMs = 25000, idleTimeoutMs = 20000, maxBytes = 45 * 1024 * 1024, redirects = 5, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const wallTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch {}
      reject(new Error(`Timeout (${timeoutMs}ms) fetching ${url}`));
    }, timeoutMs);
    if (wallTimer.unref) wallTimer.unref();

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      if (err) reject(err);
      else resolve(val);
    };

    const req = https.get(url, {
      headers: {
        'user-agent': 'AntigravityAPI-FreeTunnel/2.2',
        accept: '*/*',
      },
      timeout: idleTimeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        clearTimeout(wallTimer);
        settled = true;
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(httpsGetBuffer(nextUrl, { timeoutMs, idleTimeoutMs, maxBytes, redirects: redirects - 1, onProgress }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const totalExpected = Number(res.headers['content-length']) || 0;
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          return finish(new Error('Download exceeded maxBytes limit'));
        }
        chunks.push(chunk);
        if (onProgress && totalExpected > 0) {
          onProgress(Math.min(99, Math.round((total / totalExpected) * 100)));
        }
      });
      res.on('end', () => {
        if (onProgress) onProgress(100);
        finish(null, Buffer.concat(chunks));
      });
      res.on('error', (e) => finish(e));
    });
    req.on('timeout', () => {
      req.destroy();
      finish(new Error(`Socket idle timeout fetching ${url}`));
    });
    req.on('error', (e) => finish(e));
  });
}

function getXrayAssetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    if (arch === 'arm64') return 'Xray-windows-arm64-v8a.zip';
    if (arch === 'ia32') return 'Xray-windows-32.zip';
    return 'Xray-windows-64.zip';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'Xray-macos-arm64-v8a.zip' : 'Xray-macos-64.zip';
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return 'Xray-linux-arm64-v8a.zip';
    return 'Xray-linux-64.zip';
  }
  throw new Error(`Unsupported platform for auto Xray download: ${platform}/${arch}`);
}

function getXrayPaths(dataDir) {
  const dir = path.join(dataDir, 'bin', 'xray');
  const exe = path.join(dir, process.platform === 'win32' ? 'xray.exe' : 'xray');
  return { dir, exe };
}

function isXrayInstalled(dataDir) {
  const { exe } = getXrayPaths(dataDir);
  if (!fs.existsSync(exe)) return false;
  try {
    const out = execFileSync(exe, ['version'], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return /Xray\s+\d+/i.test(out);
  } catch {
    return false;
  }
}

async function ensureXrayBinary(dataDir, onPhase = null, onProgress = null) {
  const { dir, exe } = getXrayPaths(dataDir);
  if (isXrayInstalled(dataDir)) return exe;

  if (onPhase) onPhase('downloading_xray');
  if (onProgress) onProgress(0);
  fs.mkdirSync(dir, { recursive: true });

  const relBuf = await httpsGetBuffer(XRAY_RELEASE_API, { timeoutMs: 20000, maxBytes: 2 * 1024 * 1024 });
  const rel = JSON.parse(relBuf.toString('utf8'));
  const assetName = getXrayAssetName();
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const zipAsset = assets.find((a) => a && a.name === assetName);
  if (!zipAsset || !zipAsset.browser_download_url) {
    throw new Error(`Не найден архив ${assetName} в релизе XTLS/Xray-core`);
  }

  let expectedSha256 = '';
  if (typeof zipAsset.digest === 'string' && zipAsset.digest.toLowerCase().startsWith('sha256:')) {
    expectedSha256 = zipAsset.digest.slice(7).trim().toLowerCase();
  } else {
    const dgstAsset = assets.find((a) => a && a.name === `${assetName}.dgst`);
    if (dgstAsset && dgstAsset.browser_download_url) {
      const dgstText = (await httpsGetBuffer(dgstAsset.browser_download_url, { timeoutMs: 15000, maxBytes: 65536 })).toString('utf8');
      const m = dgstText.match(/SHA2?-256\s*=\s*([0-9a-fA-F]{64})/i);
      if (m) expectedSha256 = m[1].toLowerCase();
    }
  }

  const zipBuf = await httpsGetBuffer(zipAsset.browser_download_url, {
    timeoutMs: 240000,
    idleTimeoutMs: 30000,
    maxBytes: 45 * 1024 * 1024,
    onProgress,
  });
  if (expectedSha256) {
    const actualSha256 = crypto.createHash('sha256').update(zipBuf).digest('hex').toLowerCase();
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Контрольная сумма SHA-256 архива ${assetName} не совпала (${actualSha256} !== ${expectedSha256})`);
    }
  }

  const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-xray-dl-'));
  const zipPath = path.join(tmpExtract, assetName);
  const binFile = process.platform === 'win32' ? 'xray.exe' : 'xray';
  try {
    fs.writeFileSync(zipPath, zipBuf);
    if (process.platform === 'win32') {
      try {
        execFileSync('tar.exe', ['-xf', zipPath, '-C', dir, binFile], { timeout: 25000, windowsHide: true, stdio: 'ignore' });
      } catch {
        execFileSync('powershell.exe', [
          '-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`,
        ], { timeout: 40000, windowsHide: true, stdio: 'ignore' });
      }
    } else {
      try {
        execFileSync('unzip', ['-o', zipPath, binFile, '-d', dir], { timeout: 25000, stdio: 'ignore' });
      } catch {
        execFileSync('tar', ['-xf', zipPath, '-C', dir, binFile], { timeout: 25000, stdio: 'ignore' });
      }
      if (fs.existsSync(exe)) fs.chmodSync(exe, 0o755);
    }
  } finally {
    try { removeTree(tmpExtract); } catch {}
  }

  if (!isXrayInstalled(dataDir)) {
    throw new Error('Не удалось запустить xray после распаковки архива.');
  }
  return exe;
}

// ---- Subscription Fetching & Two-Stage Gemini Node Selection ----

function decodeSubscriptionText(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return '';
  if (!/(?:vless|trojan|hysteria2|hy2):\/\//i.test(trimmed) && /^[A-Za-z0-9+/=\r\n_-]{32,}$/.test(trimmed)) {
    try {
      const norm = trimmed.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(norm, 'base64').toString('utf8');
      if (/(?:vless|trojan|hysteria2|hy2):\/\//i.test(decoded)) return decoded;
    } catch {}
  }
  return trimmed;
}

function extractProxyLinesFromText(rawText) {
  const text = decodeSubscriptionText(rawText);
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(?:vless|trojan|hysteria2|hy2):\/\//i.test(l));
}

function extractVlessLinesFromText(rawText) {
  return extractProxyLinesFromText(rawText).filter((l) => l.toLowerCase().startsWith('vless://'));
}

function interleaveBucketsByFeed(items) {
  const buckets = new Map();
  for (const it of items) {
    const fid = it._feedId || 0;
    if (!buckets.has(fid)) buckets.set(fid, []);
    buckets.get(fid).push(it);
  }
  const queues = [];
  for (const list of buckets.values()) {
    list.sort((a, b) => b._sortScore - a._sortScore);
    queues.push(list);
  }
  const out = [];
  const CHUNK = 4;
  let active = true;
  while (active) {
    active = false;
    for (const q of queues) {
      if (q.length > 0) {
        active = true;
        for (let k = 0; k < CHUNK && q.length > 0; k++) {
          out.push(q.shift());
        }
      }
    }
  }
  return out;
}

function getProviderGroupKey(node) {
  const cred = node.uuid || node.password || node.auth || '';
  return `${node.proto || 'vless'}:${cred.slice(0, 12)}:${(node.sni || '').toLowerCase()}`;
}

async function loadCandidateNodes({ customSource = '', deadKeys = new Set(), includeFallback = false, onlyFallback = false } = {}) {
  const src = String(customSource || '').trim();
  const taggedLines = [];
  let allowAnyRegion = false;

  if (src) {
    if (/^(?:vless|trojan|hysteria2|hy2):\/\//i.test(src) || /(?:vless|trojan|hysteria2|hy2):\/\//i.test(src)) {
      allowAnyRegion = true;
      for (const line of extractProxyLinesFromText(src)) taggedLines.push({ line, tier: 0, feedId: 0 });
    } else if (/^https?:\/\//i.test(src)) {
      const buf = await httpsGetBuffer(src, { timeoutMs: 12000, maxBytes: 4 * 1024 * 1024 });
      for (const line of extractProxyLinesFromText(buf.toString('utf8'))) taggedLines.push({ line, tier: 0, feedId: 0 });
    } else {
      throw new Error('Поле своего источника должно начинаться с vless://, trojan://, hy2:// или https://');
    }
  } else {
    const urls = onlyFallback
      ? DEFAULT_FALLBACK_FEEDS.map((u, idx) => ({ u, tier: 1, feedId: 100 + idx }))
      : includeFallback
        ? [...DEFAULT_VLESS_FEEDS.map((u, idx) => ({ u, tier: 0, feedId: idx })), ...DEFAULT_FALLBACK_FEEDS.map((u, idx) => ({ u, tier: 1, feedId: 100 + idx }))]
        : DEFAULT_VLESS_FEEDS.map((u, idx) => ({ u, tier: 0, feedId: idx }));
    const settled = await Promise.allSettled(
      urls.map(({ u }) => httpsGetBuffer(u, { timeoutMs: 8500, maxBytes: 3 * 1024 * 1024 }))
    );
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled' && r.value) {
        const { tier, feedId } = urls[i];
        for (const line of extractProxyLinesFromText(r.value.toString('utf8'))) {
          taggedLines.push({ line, tier, feedId });
        }
      }
    }
  }

  const byKey = new Map();
  for (const { line, tier, feedId } of taggedLines) {
    const parsed = parseProxyUri(line, { allowAnyRegion });
    if (!parsed) continue;
    if (deadKeys.has(parsed.key)) continue;
    const candidate = {
      ...parsed,
      _tier: tier,
      _feedId: feedId,
      _sortScore: parsed.score + Math.random() * 8,
    };
    const existing = byKey.get(parsed.key);
    if (!existing || candidate._tier < existing._tier || (candidate._tier === existing._tier && candidate._sortScore > existing._sortScore)) {
      byKey.set(parsed.key, candidate);
    }
  }

  const tier0 = interleaveBucketsByFeed([...byKey.values()].filter((n) => n._tier === 0));
  const tier1 = interleaveBucketsByFeed([...byKey.values()].filter((n) => n._tier !== 0));
  return [...tier0, ...tier1];
}

function tcpPing(host, port, timeoutMs = 950) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let sock = null;
    const wall = setTimeout(() => finish(false), timeoutMs);
    if (wall.unref) wall.unref();

    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(wall);
      try { if (sock) sock.destroy(); } catch {}
      resolve(ok ? Math.max(1, Date.now() - t0) : null);
    }

    try {
      sock = net.connect({ host, port });
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function filterTcpReachable(nodes, { maxProbe = 180, concurrency = 45, take = 50 } = {}) {
  const slice = nodes.slice(0, maxProbe);
  const pingCache = new Map(); // "addr:port" -> Promise<number|null>
  const reachable = [];
  const hostPortCounts = new Map();
  const providerCounts = new Map();
  let idx = 0;

  function cachedPing(addr, port) {
    const key = `${addr.toLowerCase()}:${port}`;
    if (!pingCache.has(key)) {
      pingCache.set(key, tcpPing(addr, port, 850));
    }
    return pingCache.get(key);
  }

  async function worker() {
    while (idx < slice.length && reachable.length < take * 2) {
      const n = slice[idx++];
      const hostPort = `${n.address.toLowerCase()}:${n.port}`;
      const seenCount = hostPortCounts.get(hostPort) || 0;
      const pKey = getProviderGroupKey(n);
      const pCount = providerCounts.get(pKey) || 0;
      if (seenCount >= 2 || pCount >= 2) continue;

      // Hysteria2 uses QUIC/UDP; pass through a capped subset directly to Xray probe.
      if (n.proto === 'hy2') {
        hostPortCounts.set(hostPort, seenCount + 1);
        providerCounts.set(pKey, pCount + 1);
        reachable.push({ node: n, tcpMs: 120 });
        continue;
      }

      const ms = await cachedPing(n.address, n.port);
      if (ms !== null) {
        hostPortCounts.set(hostPort, seenCount + 1);
        providerCounts.set(pKey, pCount + 1);
        reachable.push({ node: n, tcpMs: ms });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()));
  reachable.sort((a, b) => (a.tcpMs - a.node.score * 2) - (b.tcpMs - b.node.score * 2));
  return reachable.slice(0, take).map((x) => x.node);
}

function getFreeLoopbackPort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const tryListen = (p) => {
      const srv = net.createServer();
      srv.unref();
      srv.once('error', (err) => {
        if (p !== 0) return tryListen(0);
        reject(err);
      });
      srv.listen(p, '127.0.0.1', () => {
        const chosen = srv.address().port;
        srv.close(() => resolve(chosen));
      });
    };
    tryListen(preferred);
  });
}

async function waitForPortOpen(port, timeoutMs = 3500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ms = await tcpPing('127.0.0.1', port, 250);
    if (ms !== null) return true;
    await new Promise((r) => setTimeout(r, 90));
  }
  return false;
}

function withWallTimeout(promise, ms, label = 'timeout') {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function readHeadChunk(res, maxWaitMs = 2800) {
  if (!res) return '';
  if (res.body && typeof res.body.on === 'function') {
    return await new Promise((resolve) => {
      let buf = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        try { res.body.destroy(); } catch {}
        resolve(buf);
      };
      const t = setTimeout(finish, maxWaitMs);
      if (t.unref) t.unref();
      res.body.on('data', (ch) => {
        buf += Buffer.isBuffer(ch) ? ch.toString('utf8') : String(ch);
        if (
          buf.length >= 450
          || buf.includes('wrb.fr')
          || /\[\s*1060\s*\]|,\s*1060\s*(?:,|])/.test(buf)
          || /google\.com\/sorry/i.test(buf)
        ) {
          finish();
        }
      });
      res.body.on('end', finish);
      res.body.on('error', finish);
    });
  }
  return (await res.text()).slice(0, 600);
}

async function probeGoogleReachability(proxyUrl, timeoutMs = 4800) {
  const nm = new NetworkManager({
    network: { proxy: proxyUrl, useEnvProxy: false, timeoutMs },
  });
  const t0 = Date.now();
  try {
    const res = await withWallTimeout(
      nm.fetch(
        'https://www.google.com/generate_204',
        { method: 'GET', signal: AbortSignal.timeout(timeoutMs) },
        'web'
      ),
      timeoutMs + 250,
      'probe204_timeout'
    );
    if (!res || (res.status !== 204 && res.status !== 200)) return { ok: false };
    try { if (res.body && typeof res.body.resume === 'function') res.body.resume(); } catch {}
    const coldMs = Math.max(1, Date.now() - t0);

    // Measure second warm HTTP RTT reusing the keep-alive tunnel socket
    let warmMs = coldMs;
    try {
      const t1 = Date.now();
      const res2 = await withWallTimeout(
        nm.fetch(
          'https://www.google.com/generate_204',
          { method: 'GET', signal: AbortSignal.timeout(Math.min(3500, timeoutMs)) },
          'web'
        ),
        Math.min(3800, timeoutMs + 250),
        'probe204_warm_timeout'
      );
      if (res2 && (res2.status === 204 || res2.status === 200)) {
        try { if (res2.body && typeof res2.body.resume === 'function') res2.body.resume(); } catch {}
        warmMs = Math.max(1, Date.now() - t1);
      }
    } catch {}

    return { ok: true, warmMs, coldMs, rttMs: warmMs };
  } catch {
    return { ok: false };
  } finally {
    nm.destroyAll();
  }
}

async function verifyProxyAgainstGemini(proxyUrl, timeoutMs = 7500) {
  const nm = new NetworkManager({
    network: { proxy: proxyUrl, useEnvProxy: false, timeoutMs },
  });
  const t0 = Date.now();
  try {
    const sgRes = await withWallTimeout(
      nm.fetch(
        'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_assistant-bard-web-server_20260716.08_p0&rt=c',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: 'f.req=%5Bnull%2C%22%5B%5B%5C%22ping%5C%22%5D%5D%22%5D&at=invalid',
          signal: AbortSignal.timeout(timeoutMs),
        },
        'web'
      ),
      timeoutMs + 300,
      'gemini_probe_timeout'
    );
    const sgText = await readHeadChunk(sgRes, 2800);
    if (sgRes.status === 429 || /google\.com\/sorry|<title>Sorry/i.test(sgText)) {
      return { ok: false, reason: 'captcha' };
    }
    if (/\[\s*1060\s*\]|,\s*1060\s*(?:,|])|isn't available in your region/i.test(sgText)) {
      return { ok: false, reason: 'region_blocked_1060' };
    }
    if (sgRes.status !== 200 && sgRes.status !== 400) {
      return { ok: false, reason: `http_${sgRes.status}` };
    }
    if (!sgText.includes('wrb.fr')) {
      return { ok: false, reason: 'missing_wrb_marker' };
    }
    return { ok: true, latencyMs: Math.max(1, Date.now() - t0) };
  } catch (e) {
    return { ok: false, reason: e.message || 'network_error' };
  } finally {
    nm.destroyAll();
  }
}

async function probeNodesBatchWithXray(xrayExe, nodes, { googleOnly = false } = {}) {
  if (!nodes.length) return [];
  const ports = await Promise.all(nodes.map(() => getFreeLoopbackPort(0)));

  const inbounds = nodes.map((_, i) => ({
    tag: `in_${i}`,
    listen: '127.0.0.1',
    port: ports[i],
    protocol: 'socks',
    settings: { auth: 'noauth', udp: false },
  }));

  let needsFrag = false;
  const outbounds = nodes.map((n, i) => {
    const useFragment = n.security === 'tls' && n.proto !== 'hy2';
    if (useFragment) needsFrag = true;
    return buildXrayOutbound(n, `out_${i}`, { useFragment });
  });
  if (needsFrag) outbounds.push(buildFragmentOutbound('frag'));

  const rules = nodes.map((_, i) => ({
    type: 'field',
    inboundTag: [`in_${i}`],
    outboundTag: `out_${i}`,
  }));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-xray-probe-'));
  const cfgPath = path.join(tmpDir, 'probe.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    log: { loglevel: 'none' },
    inbounds,
    outbounds,
    routing: { domainStrategy: 'AsIs', rules },
  }));

  const proc = spawn(xrayExe, ['run', '-c', cfgPath], {
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    const ready = await waitForPortOpen(ports[0], 3500);
    if (!ready) return [];

    // Stage 2A: zero-payload reachability & warm HTTP RTT screen via google.com/generate_204
    const reachChecks = await Promise.all(
      nodes.map(async (node, i) => ({
        node,
        port: ports[i],
        ...(await probeGoogleReachability(`socks5://127.0.0.1:${ports[i]}`, 4800)),
      }))
    );

    const stage2Candidates = reachChecks
      .filter((c) => c.ok)
      .map((c) => ({
        node: c.node,
        port: c.port,
        latencyMs: c.warmMs,
        warmMs: c.warmMs,
        rankMs: computeNodeRankMs(c.node, c.warmMs),
      }))
      .sort((a, b) => a.rankMs - b.rankMs)
      .slice(0, 24);
    if (!stage2Candidates.length) return [];

    if (googleOnly) {
      return stage2Candidates.map((item) => ({
        node: item.node,
        ok: true,
        latencyMs: item.warmMs,
        warmMs: item.warmMs,
        rankMs: item.rankMs,
      }));
    }

    // Stage 2B: early-chunk StreamGenerate check verifying Gemini responds without geo-error 1060
    const checks = await Promise.all(
      stage2Candidates.map(async (item) => {
        const res = await verifyProxyAgainstGemini(`socks5://127.0.0.1:${item.port}`, 7500);
        return {
          node: item.node,
          ok: res.ok,
          reason: res.reason,
          latencyMs: item.warmMs,
          warmMs: item.warmMs,
          sgMs: res.latencyMs || null,
          rankMs: item.rankMs,
        };
      })
    );
    const sorted = checks.filter((c) => c.ok).sort((a, b) => a.rankMs - b.rankMs);
    // Keep verified list diverse: at most 2 Anycast/worker endpoints per shared credential+SNI
    const providerSeen = new Map();
    const diverse = [];
    for (const item of sorted) {
      const pKey = getProviderGroupKey(item.node);
      const cnt = providerSeen.get(pKey) || 0;
      if (cnt >= 2) continue;
      providerSeen.set(pKey, cnt + 1);
      diverse.push(item);
    }
    return diverse;
  } finally {
    try { proc.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 120));
    try { removeTree(tmpDir); } catch {}
  }
}

// ---- Cross-Process State & FreeTunnelManager ----

function stateFilePath(dataDir) {
  return path.join(dataDir, 'free_tunnel_state.json');
}

function cacheFilePath(dataDir) {
  return path.join(dataDir, 'free_tunnel_cache.json');
}

function activeConfigFilePath(dataDir) {
  return path.join(dataDir, 'bin', 'xray', 'active_tunnel.json');
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

class FreeTunnelManager {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.phase = 'idle'; // 'idle' | 'downloading_xray' | 'scanning_nodes' | 'starting' | 'running' | 'error'
    this.downloadPercent = 0;
    this.lastError = '';
    this.standbyNodes = [];
    this.deadKeys = new Set();
    this._startPromise = null;
    this._watchdogTimer = null;
  }

  readState() {
    try {
      return readJsonFile(stateFilePath(this.dataDir));
    } catch {
      return null;
    }
  }

  readVerifiedCache(customSource = '') {
    try {
      const c = readJsonFile(cacheFilePath(this.dataDir));
      if (!c || !Array.isArray(c.items)) return [];
      const src = String(customSource || '').trim();
      if ((c.customSource || '') !== src) return [];
      if (Date.now() - Number(c.updatedAt || 0) > 45 * 60 * 1000) return [];
      return c.items.filter((x) => x && x.node && x.node.key && !this.deadKeys.has(x.node.key));
    } catch {
      return [];
    }
  }

  writeVerifiedCache(items, customSource = '') {
    try {
      const cleaned = items.slice(0, 20).map((x) => ({
        node: x.node,
        latencyMs: x.latencyMs,
        rankMs: x.rankMs ?? computeNodeRankMs(x.node, x.latencyMs),
      }));
      writeFileAtomic(cacheFilePath(this.dataDir), JSON.stringify({
        customSource: String(customSource || '').trim(),
        updatedAt: Date.now(),
        items: cleaned,
      }, null, 2));
      this.standbyNodes = cleaned;
    } catch {}
  }

  _getSafeAvailableNodes(activeKey = '', customSource = '') {
    const cached = this.standbyNodes.length > 0 ? this.standbyNodes : this.readVerifiedCache(customSource);
    const seen = new Set();
    const list = [];
    for (const item of cached) {
      const n = item && item.node;
      if (!n || !n.key || this.deadKeys.has(n.key) || seen.has(n.key)) continue;
      seen.add(n.key);
      list.push({
        key: n.key,
        label: n.label || `${n.address}:${n.port}`,
        proto: n.proto || 'vless',
        security: n.security || '',
        transport: n.network || '',
        latencyMs: item.latencyMs || null,
        active: n.key === activeKey,
      });
    }
    return list;
  }

  async getStatus(customSource = '') {
    const st = this.readState();
    const xrayInstalled = isXrayInstalled(this.dataDir);
    if (st && st.pid && isPidAlive(st.pid) && st.socksPort) {
      const portAlive = (await tcpPing('127.0.0.1', st.socksPort, 300)) !== null;
      if (portAlive) {
        if (this.phase === 'idle' || this.phase === 'error') this.phase = 'running';
        const effectiveSrc = customSource || (st.customSource || '');
        const availableNodes = this._getSafeAvailableNodes(st.nodeKey || '', effectiveSrc);
        if (st.nodeKey && !availableNodes.some((x) => x.key === st.nodeKey)) {
          availableNodes.unshift({
            key: st.nodeKey,
            label: st.nodeLabel || '',
            proto: st.proto || 'vless',
            security: st.security || '',
            transport: st.transport || '',
            latencyMs: st.latencyMs || null,
            active: true,
          });
        }
        return {
          running: true,
          phase: 'running',
          xrayInstalled,
          proxyUrl: st.proxyUrl || `socks5://127.0.0.1:${st.socksPort}`,
          socksPort: st.socksPort,
          pid: st.pid,
          nodeKey: st.nodeKey || '',
          nodeLabel: st.nodeLabel || '',
          proto: st.proto || 'vless',
          security: st.security || '',
          transport: st.transport || '',
          latencyMs: st.latencyMs || null,
          startedAt: st.startedAt || null,
          custom: !!st.custom,
          availableNodes,
          error: '',
        };
      }
    }
    return {
      running: false,
      phase: this.phase === 'running' ? 'idle' : this.phase,
      downloadPercent: this.phase === 'downloading_xray' ? this.downloadPercent : 0,
      xrayInstalled,
      proxyUrl: '',
      socksPort: null,
      pid: null,
      nodeKey: '',
      nodeLabel: '',
      proto: '',
      security: '',
      transport: '',
      latencyMs: null,
      startedAt: null,
      custom: false,
      availableNodes: this._getSafeAvailableNodes('', customSource),
      error: this.lastError || '',
    };
  }

  getActiveProxyUrlSync() {
    const st = this.readState();
    if (st && st.pid && isPidAlive(st.pid) && st.socksPort) {
      return st.proxyUrl || `socks5://127.0.0.1:${st.socksPort}`;
    }
    return '';
  }

  async start({ customSource = '', rotate = false, forceScan = false, selectKey = '', markDead = false } = {}) {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._doStart({ customSource, rotate, forceScan, selectKey, markDead }).finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }

  async _doStart({ customSource = '', rotate = false, forceScan = false, selectKey = '', markDead = false } = {}) {
    this.lastError = '';
    const normCustom = String(customSource || '').trim();
    try {
      const current = await this.getStatus(normCustom);
      if (current.running && !rotate && !forceScan && !selectKey) {
        this._ensureWatchdog(normCustom);
        return current;
      }

      let preferredPort = PREFERRED_SOCKS_PORT;
      const oldState = this.readState();
      const oldKey = (oldState && oldState.nodeKey) || '';
      if (oldState && oldState.socksPort) preferredPort = oldState.socksPort;
      if (markDead && oldKey) {
        this.deadKeys.add(oldKey);
      }

      const xrayExe = await ensureXrayBinary(
        this.dataDir,
        (p) => { this.phase = p; },
        (pct) => { this.downloadPercent = pct; }
      );
      this.phase = 'scanning_nodes';

      let verifiedPool = this.readVerifiedCache(normCustom);
      let winner = null;

      // 1. Explicit node selection from verified list (< 2.5s fast reachability check)
      if (selectKey) {
        const idx = verifiedPool.findIndex((x) => x.node.key === selectKey);
        if (idx >= 0) {
          const picked = verifiedPool[idx];
          const recheck = await probeNodesBatchWithXray(xrayExe, [picked.node], { googleOnly: true });
          if (recheck.length > 0) {
            winner = recheck[0];
            verifiedPool[idx] = winner;
            verifiedPool.sort((a, b) => a.rankMs - b.rankMs);
          } else {
            this.deadKeys.add(selectKey);
            verifiedPool = verifiedPool.filter((x) => x.node.key !== selectKey);
            const backupCands = verifiedPool.filter((x) => !this.deadKeys.has(x.node.key)).slice(0, 8).map((x) => x.node);
            if (backupCands.length > 0) {
              const alive = await probeNodesBatchWithXray(xrayExe, backupCands, { googleOnly: true });
              if (alive.length > 0) winner = alive[0];
            }
          }
        }
      }

      // 2. Fast switch ("rotate" without forceScan) across verified nodes in one batch (< 3s)
      if (!winner && rotate && !forceScan && !selectKey && verifiedPool.length > 0) {
        const candidatesToTry = verifiedPool.filter((x) => x.node.key !== oldKey && !this.deadKeys.has(x.node.key)).slice(0, 8);
        if (candidatesToTry.length > 0) {
          const alive = await probeNodesBatchWithXray(xrayExe, candidatesToTry.map((x) => x.node), { googleOnly: true });
          if (alive.length > 0) {
            winner = alive[0];
            const refreshedByKey = new Map(alive.map((a) => [a.node.key, a]));
            verifiedPool = verifiedPool
              .filter((x) => x.node.key === oldKey || refreshedByKey.has(x.node.key))
              .map((x) => refreshedByKey.get(x.node.key) || x)
              .sort((a, b) => a.rankMs - b.rankMs);
          } else {
            for (const c of candidatesToTry) this.deadKeys.add(c.node.key);
            verifiedPool = verifiedPool.filter((x) => !this.deadKeys.has(x.node.key));
          }
        }
      }

      // 3. Full multi-country scan (Tier-0 includes curated global/EU/CIS/Asia feeds)
      if (!winner) {
        const byVerifiedKey = new Map();
        const addVerified = (list) => {
          for (const v of list) {
            if (!v || !v.node) continue;
            const prev = byVerifiedKey.get(v.node.key);
            if (!prev || v.rankMs < prev.rankMs) byVerifiedKey.set(v.node.key, v);
          }
        };

        const candidates = await loadCandidateNodes({
          customSource: normCustom,
          deadKeys: this.deadKeys,
          includeFallback: false,
        });
        const triedKeys = new Set();

        for (let wave = 0; wave < 2; wave++) {
          const slice = candidates.slice(wave * 180, (wave + 1) * 180);
          if (!slice.length) break;
          for (const n of slice) triedKeys.add(n.key);
          const reachable = await filterTcpReachable(slice, { maxProbe: 180, concurrency: 45, take: 55 });
          if (!reachable.length) continue;
          const batchOk = await probeNodesBatchWithXray(xrayExe, reachable);
          if (batchOk.length > 0) {
            addVerified(batchOk);
            if (byVerifiedKey.size >= 3) break;
          } else {
            for (const r of reachable) this.deadKeys.add(r.key);
          }
        }

        const needBroaderCountryWave = !normCustom && byVerifiedKey.size === 0;

        if (needBroaderCountryWave) {
          const fallbackAll = await loadCandidateNodes({
            customSource: '',
            deadKeys: this.deadKeys,
            onlyFallback: true,
          });
          const extra = fallbackAll.filter((n) => !triedKeys.has(n.key));
          if (extra.length) {
            const reachable = await filterTcpReachable(extra, { maxProbe: 180, concurrency: 45, take: 55 });
            if (reachable.length) {
              const batchOk = await probeNodesBatchWithXray(xrayExe, reachable);
              if (batchOk.length > 0) {
                addVerified(batchOk);
              } else {
                for (const r of reachable) this.deadKeys.add(r.key);
              }
            }
          }
        } else if (!candidates.length && byVerifiedKey.size === 0) {
          throw new Error('Не найдено подходящих прокси-узлов (VLESS / Trojan / Hysteria2) в списке источников.');
        }

        verifiedPool = [...byVerifiedKey.values()].sort((a, b) => a.rankMs - b.rankMs);
        if (verifiedPool.length > 0) {
          winner = verifiedPool[0];
        }
      }

      if (!winner) {
        throw new Error('Ни один бесплатный узел сейчас не прошёл проверку доступа к Gemini без региональной блокировки. Попробуйте нажать «Найти другие» через минуту или укажите свой ключ (vless://, trojan://, hy2://).');
      }

      this.writeVerifiedCache(verifiedPool, normCustom);
      this.phase = 'starting';
      await this.stop({ keepPhase: true });

      const socksPort = await getFreeLoopbackPort(preferredPort);
      const cfgPath = activeConfigFilePath(this.dataDir);
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      const winnerUseFragment = winner.node.security === 'tls' && winner.node.proto !== 'hy2';
      const activeOutbounds = [buildXrayOutbound(winner.node, 'proxy', { useFragment: winnerUseFragment })];
      if (winnerUseFragment) activeOutbounds.push(buildFragmentOutbound('frag'));

      writeFileAtomic(cfgPath, JSON.stringify({
        log: { loglevel: 'none' },
        inbounds: [
          {
            tag: 'gemini-local-socks',
            listen: '127.0.0.1',
            port: socksPort,
            protocol: 'socks',
            settings: { auth: 'noauth', udp: false },
          },
        ],
        outbounds: activeOutbounds,
      }, null, 2));

      const child = spawn(xrayExe, ['run', '-c', cfgPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();

      const ready = await waitForPortOpen(socksPort, 4000);
      if (!ready || !isPidAlive(child.pid)) {
        try { child.kill(); } catch {}
        throw new Error('Не удалось запустить локальный SOCKS5-порт Xray.');
      }

      const proxyUrl = `socks5://127.0.0.1:${socksPort}`;
      const stateObj = {
        pid: child.pid,
        socksPort,
        proxyUrl,
        nodeKey: winner.node.key,
        nodeLabel: winner.node.label,
        proto: winner.node.proto || 'vless',
        security: winner.node.security,
        transport: winner.node.network,
        latencyMs: winner.latencyMs,
        custom: !!normCustom,
        customSource: normCustom,
        startedAt: new Date().toISOString(),
      };
      writeFileAtomic(stateFilePath(this.dataDir), JSON.stringify(stateObj, null, 2));
      this.phase = 'running';
      this._ensureWatchdog(normCustom);
      return await this.getStatus(normCustom);
    } catch (e) {
      this.phase = 'error';
      this.lastError = e.message || String(e);
      throw e;
    }
  }

  _ensureWatchdog(customSource = '') {
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    this._watchdogTimer = setInterval(async () => {
      try {
        const st = await this.getStatus(customSource);
        if (!st.running) return;
        const check = await verifyProxyAgainstGemini(st.proxyUrl, 7000);
        if (!check.ok) {
          await this.start({ customSource, rotate: true, markDead: true }).catch(() => {});
        }
      } catch {}
    }, 180000);
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
  }

  async stop({ keepPhase = false } = {}) {
    if (!keepPhase && this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    const st = this.readState();
    if (st && st.pid && isPidAlive(st.pid)) {
      try { process.kill(st.pid); } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    try {
      if (fs.existsSync(stateFilePath(this.dataDir))) {
        fs.unlinkSync(stateFilePath(this.dataDir));
      }
    } catch {}
    if (!keepPhase) {
      this.phase = 'idle';
      this.lastError = '';
    }
    return this.getStatus();
  }
}

module.exports = {
  FreeTunnelManager,
  convertTelegramSocksLink,
  parseVlessUri,
  parseTrojanUri,
  parseHy2Uri,
  parseProxyUri,
  buildXrayOutbound,
  buildFragmentOutbound,
  extractProxyLinesFromText,
  extractVlessLinesFromText,
  isPrivateOrReservedHost,
  isBlockedRegionRemark,
  isDistantOrAnycastNode,
  computeNodeRankMs,
  NEARBY_COUNTRY_REMARK_RE,
  DEFAULT_VLESS_FEEDS,
  DEFAULT_FALLBACK_FEEDS,
};

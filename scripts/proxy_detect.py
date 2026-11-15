# -*- coding: utf-8 -*-
"""
Поиск локального прокси для сетевого слоя приложения.

Источники (без внешних зависимостей):
- переменные окружения HTTPS_PROXY / HTTP_PROXY / ALL_PROXY;
- системные настройки Windows (реестр Internet Settings, ProxyEnable/ProxyServer);
- типовые локальные порты популярных клиентов (Clash, v2rayN, Tor, Squid).

Каждый кандидат проверяется локальным рукопожатием:
- SOCKS5: приветствие 05 01 00;
- HTTP: CONNECT на 127.0.0.1:9 (заведомо закрытый порт) — наружу ничего не уходит.
"""

import json
import os
import re
import socket
import sys
from concurrent.futures import ThreadPoolExecutor

COMMON_PORTS = [
    (7890, "Clash / Mihomo"),
    (7897, "Clash Verge"),
    (10809, "v2rayN HTTP"),
    (10808, "v2rayN SOCKS"),
    (1080, "SOCKS"),
    (8080, "HTTP proxy"),
    (3128, "Squid"),
    (8888, "HTTP proxy"),
    (9150, "Tor Browser"),
    (9050, "Tor SOCKS"),
]
HANDSHAKE_TIMEOUT = 0.35


def _mask(url):
    return re.sub(r"(://)[^/@\s]+@", r"\1***@", str(url))


def _split_host_port(value, default_port):
    value = str(value or "").strip()
    if not value:
        return None
    # http=host:port;https=host:port -> caller splits first
    if value.startswith("["):
        host, _, rest = value[1:].partition("]")
        port = rest.lstrip(":")
    else:
        host, sep, port = value.rpartition(":")
        if not sep:
            host, port = value, str(default_port)
    try:
        port = int(port)
    except ValueError:
        return None
    host = host.strip()
    if not host or not (0 < port < 65536):
        return None
    return host, port


def _proxy_url(scheme, host, port, username="", password=""):
    auth = ""
    if username:
        auth = username + (":" + password if password else "") + "@"
    return f"{scheme}://{auth}{host}:{port}"


def _env_candidates():
    out = []
    for key, scheme in (
        ("HTTPS_PROXY", "http"), ("https_proxy", "http"),
        ("HTTP_PROXY", "http"), ("http_proxy", "http"),
        ("ALL_PROXY", "socks5"), ("all_proxy", "socks5"),
    ):
        raw = os.environ.get(key, "").strip()
        if not raw:
            continue
        if "://" not in raw:
            raw = scheme + "://" + raw
        out.append({"url": raw, "source": key})
    return out


def _system_candidates():
    if os.name != "nt":
        return []
    try:
        import winreg
    except Exception:
        return []

    out = []
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ) as key:
            enabled = int(winreg.QueryValueEx(key, "ProxyEnable")[0] or 0)
            server = str(winreg.QueryValueEx(key, "ProxyServer")[0] or "").strip()
    except Exception:
        return []
    if not enabled or not server:
        return []

    if "=" in server:
        for part in server.split(";"):
            kind, _, address = part.partition("=")
            kind = kind.strip().lower()
            parsed = _split_host_port(address, 80)
            if not parsed:
                continue
            scheme = "socks5" if kind.startswith("socks") else "http"
            out.append({"url": _proxy_url(scheme, *parsed), "source": "Windows Internet Settings"})
        return out

    parsed = _split_host_port(server, 80)
    if parsed:
        out.append({"url": _proxy_url("http", *parsed), "source": "Windows Internet Settings"})
    return out


def _port_candidates(port, label):
    host = "127.0.0.1"
    return [
        {"url": _proxy_url("http", host, port), "source": label},
        {"url": _proxy_url("socks5", host, port), "source": label},
    ]


def _parse(url):
    match = re.match(r"^([a-z0-9+.-]+)://(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/]+):(\d+)", url, re.I)
    if not match:
        return None
    scheme = match.group(1).lower()
    if scheme not in ("http", "https", "socks5", "socks5h", "socks"):
        return None
    scheme = "socks5" if scheme.startswith("socks") else scheme
    host = match.group(4).strip("[]")
    port = int(match.group(5))
    return scheme, host, port, match.group(2) or "", match.group(3) or ""


def _try_socks5(host, port, timeout):
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.sendall(b"\x05\x01\x00")
            reply = sock.recv(2)
            return len(reply) == 2 and reply[0] == 0x05 and reply[1] in (0x00, 0x02)
    except OSError:
        return False


def _try_http(host, port, timeout):
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.sendall(
                b"CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n"
                b"Proxy-Connection: close\r\n\r\n"
            )
            reply = sock.recv(64)
            return reply.startswith(b"HTTP/1.")
    except OSError:
        return False


def _probe(candidate, timeout=HANDSHAKE_TIMEOUT):
    parsed = _parse(candidate["url"])
    if not parsed:
        return None
    scheme, host, port, username, password = parsed
    if scheme == "socks5":
        actual = "socks5" if _try_socks5(host, port, timeout) else None
    elif _try_http(host, port, timeout):
        actual = "http"
    elif _try_socks5(host, port, timeout):
        actual = "socks5"
    else:
        actual = None
    if not actual:
        return None
    url = candidate["url"]
    if actual != scheme:
        url = _proxy_url(actual, host, port, username, password)
    return {**candidate, "url": url, "type": actual, "reachable": True}


def detect_proxies(timeout=HANDSHAKE_TIMEOUT):
    """Вернуть доступные прокси: [{url, source, type, reachable}], без дублей."""
    candidates = _env_candidates() + _system_candidates()
    with ThreadPoolExecutor(max_workers=10) as pool:
        scanned = list(pool.map(lambda p: _port_candidates(*p), COMMON_PORTS))
    for group in scanned:
        candidates.extend(group)

    seen = set()
    ordered = []
    for candidate in candidates:
        parsed = _parse(candidate["url"])
        if not parsed:
            continue
        key = (parsed[1].lower(), parsed[2])
        if key in seen:
            continue
        seen.add(key)
        ordered.append(candidate)

    # Сначала явные источники, затем перебор портов; рукопожатия параллельно.
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda p: _probe(p, timeout), ordered))

    found = []
    seen_urls = set()
    for result in results:
        if not result:
            continue
        parsed = _parse(result["url"])
        normalized = f"{result['type']}://{parsed[1].lower()}:{parsed[2]}"
        if normalized in seen_urls:
            continue
        seen_urls.add(normalized)
        found.append(result)
    return found


def main():
    proxies = detect_proxies()
    if "--json" in sys.argv:
        print(json.dumps(proxies, ensure_ascii=False, indent=2))
        return
    if not proxies:
        print("Прокси не найден (env, системные настройки Windows и типовые порты проверены).")
        return
    for item in proxies:
        print(f"  {_mask(item['url']):40} {item['type']:6} {item['source']}")


if __name__ == "__main__":
    main()

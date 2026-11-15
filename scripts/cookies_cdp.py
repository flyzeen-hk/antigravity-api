# -*- coding: utf-8 -*-
"""Импорт Google-куки из окна Gemini через Chrome DevTools Protocol.

Зачем: Chrome/Edge 127+ шифруют куки (App-Bound Encryption, v20), и файл
Cookies нельзя прочитать без запуска браузера. CDP обходит шифрование:
браузер сам отдаёт уже расшифрованные куки через loopback-порт.

Безопасность:
- подключаемся только к 127.0.0.1 и только к порту из DevToolsActivePort
  выделенного профиля приложения;
- читаются все куки браузера, но в заголовок попадают ТОЛЬКО домены google.com;
- значения куки не логируются и никуда не отправляются;
- отладочный порт слушает loopback (--remote-debugging-address=127.0.0.1).

Использование:
    python scripts/cookies_cdp.py --check   # диагностика без вывода секретов
    python scripts/cookies_cdp.py           # напечатать Cookie-заголовок
"""

import base64
import hashlib
import json
import os
import re
import secrets
import socket
import struct
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from .gemini_browser import find_browser_executable, get_profile_dir, launch_browser, close_profile_browser
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from gemini_browser import find_browser_executable, get_profile_dir, launch_browser, close_profile_browser

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_SAPISID_RE = re.compile(r"^[A-Za-z0-9_\-./=]+$")
_COOKIE_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class CdpError(RuntimeError):
    pass


def _read_devtools_port(profile):
    path = Path(profile) / "DevToolsActivePort"
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        port = int(lines[0].strip())
    except (OSError, ValueError, IndexError):
        return None
    if not 0 < port < 65536:
        return None
    return port


def _http_json(port, path, timeout=2.0):
    url = f"http://127.0.0.1:{port}{path}"
    with _OPENER.open(url, timeout=timeout) as response:
        if response.status != 200:
            raise CdpError(f"CDP HTTP {response.status}")
        return json.loads(response.read().decode("utf-8", errors="replace"))


def _probe_endpoint(profile, timeout=1.5):
    port = _read_devtools_port(profile)
    if not port:
        return None
    try:
        version = _http_json(port, "/json/version", timeout=timeout)
    except Exception:
        return None
    if not isinstance(version, dict):
        return None
    return port, version


def _wait_endpoint(profile, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        endpoint = _probe_endpoint(profile, timeout=0.8)
        if endpoint:
            return endpoint
        time.sleep(0.15)
    return None


def ensure_browser_endpoint(profile=None, timeout=8.0, launch=True):
    """Вернуть (port, /json/version), при необходимости запустив окно Gemini."""
    profile = Path(profile) if profile else get_profile_dir()
    endpoint = _probe_endpoint(profile)
    if endpoint:
        return endpoint
    if not launch:
        raise CdpError("Окно Gemini не запущено с отладочным портом.")
    executable = find_browser_executable()
    if not executable:
        raise CdpError("Chrome или Edge не найден — установите браузер.")
    # Окно входа открывалось без DevTools (иначе Google блокирует вход);
    # закрываем его и перезапускаем тот же профиль уже с отладочным портом.
    close_profile_browser(profile)
    time.sleep(0.6)
    launch_browser(executable, profile, remote_debugging=True)
    endpoint = _wait_endpoint(profile, timeout)
    if not endpoint:
        raise CdpError(
            "Не удалось подключиться к окну Gemini. Если оно уже открыто, закройте его "
            "и запустите scripts/cookies_cdp.py снова, чтобы браузер запустился с отладочным портом."
        )
    return endpoint


class WebSocket:
    """Минимальный RFC6455-клиент: текстовые кадры, ping/pong, безOrigin."""

    def __init__(self, sock, leftover=b""):
        self.sock = sock
        self.buf = leftover

    @classmethod
    def connect(cls, port, path, timeout=5.0):
        if not str(path).startswith("/"):
            raise CdpError("Некорректный WebSocket path")
        sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        try:
            key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
            request = (
                f"GET {path} HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{port}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            )
            sock.sendall(request.encode("ascii"))
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    raise CdpError("WebSocket: соединение закрыто при рукопожатии")
                head += chunk
                if len(head) > 65536:
                    raise CdpError("WebSocket: слишком большой ответ рукопожатия")
            header, _, leftover = head.partition(b"\r\n\r\n")
            lines = header.decode("iso-8859-1").split("\r\n")
            if not lines or " 101 " not in f" {lines[0]} ":
                raise CdpError(f"WebSocket: {lines[0] if lines else 'нет ответа'}")
            expected = base64.b64encode(
                hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
            accept = ""
            for line in lines[1:]:
                name, _, value = line.partition(":")
                if name.strip().lower() == "sec-websocket-accept":
                    accept = value.strip()
            if accept != expected:
                raise CdpError("WebSocket: неверный Sec-WebSocket-Accept")
            return cls(sock, leftover)
        except Exception:
            sock.close()
            raise

    def _send(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        size = len(payload)
        if size < 126:
            header.append(0x80 | size)
        elif size < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", size)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", size)
        mask = secrets.token_bytes(4)
        header += mask
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def send_text(self, text):
        self._send(0x1, text.encode("utf-8"))

    def _read_exact(self, size, deadline):
        while len(self.buf) < size:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise CdpError("WebSocket: таймаут ожидания ответа")
            self.sock.settimeout(remaining)
            chunk = self.sock.recv(max(4096, size - len(self.buf)))
            if not chunk:
                raise CdpError("WebSocket: соединение закрыто")
            self.buf += chunk
        out, self.buf = self.buf[:size], self.buf[size:]
        return out

    def recv_text(self, timeout=5.0):
        deadline = time.time() + timeout
        fragments = []
        frag_opcode = None
        while True:
            first, second = self._read_exact(2, deadline)
            fin = bool(first & 0x80)
            opcode = first & 0x0F
            masked = bool(second & 0x80)
            size = second & 0x7F
            if size == 126:
                size = struct.unpack(">H", self._read_exact(2, deadline))[0]
            elif size == 127:
                size = struct.unpack(">Q", self._read_exact(8, deadline))[0]
            if size > 16 * 1024 * 1024:
                raise CdpError("WebSocket: слишком большое сообщение")
            mask = self._read_exact(4, deadline) if masked else None
            payload = self._read_exact(size, deadline)
            if mask:
                payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))

            if opcode == 0x8:
                self._send(0x8, payload[:125])
                raise CdpError("WebSocket: CDP закрыл соединение")
            if opcode == 0x9:
                self._send(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                fragments = [payload]
                frag_opcode = opcode
            elif opcode == 0x0 and frag_opcode is not None:
                fragments.append(payload)
            else:
                continue
            if fin:
                data = b"".join(fragments)
                fragments = []
                if frag_opcode == 0x2:
                    raise CdpError("WebSocket: неожиданный бинарный кадр")
                frag_opcode = None
                return data.decode("utf-8", errors="replace")

    def close(self):
        try:
            self._send(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def _ws_path(version, port):
    url = str((version or {}).get("webSocketDebuggerUrl") or "")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "ws" or parsed.hostname not in ("127.0.0.1", "localhost"):
        raise CdpError("CDP вернул неожиданный WebSocket URL")
    if parsed.port and parsed.port != port:
        raise CdpError("CDP вернул неожиданный порт WebSocket")
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    return path


def cdp_call(ws, method, params=None, timeout=8.0):
    request_id = 1
    ws.send_text(json.dumps({"id": request_id, "method": method, "params": params or {}}))
    deadline = time.time() + timeout
    while True:
        remaining = max(0.1, deadline - time.time())
        message = json.loads(ws.recv_text(timeout=remaining))
        if message.get("id") != request_id:
            continue  # events
        if "error" in message:
            raise CdpError(f"CDP {method}: {message['error'].get('message') or 'error'}")
        return message.get("result") or {}


def fetch_cookies(profile=None, timeout=8.0, launch=True):
    """Прочитать куки через CDP. Возвращает список dict из Chrome."""
    port, version = ensure_browser_endpoint(profile, timeout=timeout, launch=launch)
    ws = WebSocket.connect(port, _ws_path(version, port), timeout=timeout)
    try:
        try:
            result = cdp_call(ws, "Storage.getCookies", {}, timeout=timeout)
        except CdpError:
            result = cdp_call(ws, "Network.getAllCookies", {}, timeout=timeout)
    finally:
        ws.close()
    cookies = result.get("cookies")
    if not isinstance(cookies, list):
        raise CdpError("CDP не вернул список куки")
    return cookies


def _domain_matches(host, domains):
    host = str(host or "").lower().lstrip(".")
    return any(host == d or host.endswith("." + d) for d in domains)


def build_cookie_header(cookies, domains=("google.com",)):
    """Отфильтровать google-куки, убрать дубли и собрать Cookie-заголовок."""
    now = time.time()
    chosen = {}
    for cookie in cookies or []:
        if not isinstance(cookie, dict):
            continue
        name = str(cookie.get("name") or "").strip()
        value = cookie.get("value")
        domain = str(cookie.get("domain") or "")
        if not name or not _COOKIE_NAME_RE.match(name) or len(name) > 256:
            continue
        if not isinstance(value, str) or not value:
            continue
        if any(ch in value for ch in ("\r", "\n", ";", "\x00", "\ufffd")):
            continue
        host = domain.lower().lstrip(".")
        if not _domain_matches(host, domains):
            continue
        expires = cookie.get("expires")
        if isinstance(expires, (int, float)) and expires > 0 and expires < now:
            continue
        path = str(cookie.get("path") or "/")
        rank = (len(host), len(path), 1 if not domain.startswith(".") else 0)
        current = chosen.get(name)
        if current is None or rank > current[0]:
            chosen[name] = (rank, name, value, host, path)
    ordered = sorted(chosen.values(), key=lambda item: (-item[0][0], -item[0][1], item[1]))
    pairs = [(item[3], f"{item[1]}={item[2]}") for item in ordered]
    header = "; ".join(pair for _, pair in pairs)
    sapisid = ""
    for _, pair in pairs:
        if pair.startswith("SAPISID="):
            value = pair.split("=", 1)[1]
            if len(value) >= 20 and _SAPISID_RE.match(value):
                sapisid = value
            break
    return header, pairs, sapisid


def fetch_xsrf_token(profile=None, timeout=6.0, launch=True):
    """Прочитать XSRF-токен at (SNlM0e) из живого окна Gemini через CDP."""
    port, version = ensure_browser_endpoint(profile, timeout=timeout, launch=launch)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            targets = _http_json(port, "/json/list", timeout=2.0)
        except Exception:
            targets = []
        target = next((t for t in targets if isinstance(t, dict)
                       and t.get("type") == "page"
                       and "gemini.google.com" in str(t.get("url") or "")), None)
        if target:
            try:
                ws = WebSocket.connect(port, _ws_path(target, port), timeout=3.0)
                try:
                    result = cdp_call(ws, "Runtime.evaluate", {
                        "expression": "window.WIZ_global_data && window.WIZ_global_data.SNlM0e",
                        "returnByValue": True,
                    }, timeout=4.0)
                finally:
                    ws.close()
                value = (result.get("result") or {}).get("value")
                if isinstance(value, str) and len(value) >= 10:
                    return value
            except Exception:
                pass
        time.sleep(0.3)
    return ""


def extract_cookie_header_via_cdp(profile_dir=None, timeout=8.0, launch=True):
    """Вернуть (cookie_header, info) из живого окна Gemini."""
    profile = Path(profile_dir) if profile_dir else get_profile_dir()
    cookies = fetch_cookies(profile, timeout=timeout, launch=launch)
    header, pairs, sapisid = build_cookie_header(cookies)
    if not pairs:
        raise CdpError(
            "В окне Gemini нет куки google.com. Войдите в аккаунт на gemini.google.com "
            "и запустите scripts/cookies_cdp.py снова."
        )
    xsrf = ""
    try:
        xsrf = fetch_xsrf_token(profile, timeout=timeout, launch=False)
    except Exception:
        xsrf = ""
    return header, {
        "count": len(pairs),
        "has_sapisid": bool(sapisid),
        "profile": str(profile),
        "browser": "AntigravityAPI",
        "source": "cdp",
        "appbound_skipped": 0,
        "decrypt_failed": 0,
        "corrupt_skipped": 0,
        "xsrf": xsrf,
    }


def main():
    check_only = "--check" in sys.argv
    try:
        if check_only:
            profile = get_profile_dir()
            port, version = ensure_browser_endpoint(profile, launch=False)
            print(f"CDP: 127.0.0.1:{port} · {version.get('Browser', '?')}")
            cookies = fetch_cookies(profile, launch=False)
            header, pairs, sapisid = build_cookie_header(cookies)
            print(f"Google-куки: {len(pairs)} шт., SAPISID: {'есть' if sapisid else 'НЕТ'}")
            return
        header, info = extract_cookie_header_via_cdp()
        print(f"Браузер: {info['browser']}, профиль: {info['profile']}")
        print(f"Куки: {info['count']} шт., SAPISID: {'есть' if info['has_sapisid'] else 'НЕТ'}")
        if not info["has_sapisid"]:
            print("ВНИМАНИЕ: нет SAPISID — войдите в аккаунт на gemini.google.com",
                  file=sys.stderr)
        print(header)
    except Exception as exc:
        print(f"✗ {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

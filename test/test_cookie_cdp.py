# -*- coding: utf-8 -*-
"""Юнит-тесты CDP-импорта куки на локальном mock-сервере (без браузера).

Проверяют HTTP /json/version, WebSocket-рукопожатие, кадры CDP,
фильтрацию Google-куки и сборку Cookie-заголовка.
Запуск: python test/test_cookie_cdp.py
"""

import base64
import hashlib
import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from scripts.cookies_cdp import (  # noqa: E402
    CdpError, build_cookie_header, ensure_browser_endpoint,
    extract_cookie_header_via_cdp,
)

SAPISID = "SapiSid_0123456789abcdefghijklmnopqrstuv"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _recv_exact(conn, size):
    data = b""
    while len(data) < size:
        chunk = conn.recv(size - len(data))
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
    return data


def _read_frame(conn):
    first, second = _recv_exact(conn, 2)
    opcode = first & 0x0F
    size = second & 0x7F
    if size == 126:
        size = struct.unpack(">H", _recv_exact(conn, 2))[0]
    elif size == 127:
        size = struct.unpack(">Q", _recv_exact(conn, 8))[0]
    mask = _recv_exact(conn, 4) if second & 0x80 else None
    payload = _recv_exact(conn, size)
    if mask:
        payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
    return opcode, payload


def _send_frame(conn, payload):
    size = len(payload)
    if size < 126:
        header = bytes([0x81, size])
    elif size < 65536:
        header = bytes([0x81, 126]) + struct.pack(">H", size)
    else:
        header = bytes([0x81, 127]) + struct.pack(">Q", size)
    conn.sendall(header + payload)


class MockCdpServer:
    def __init__(self, cookies):
        self.cookies = cookies
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while not self.stopped.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        try:
            request = b""
            while b"\r\n\r\n" not in request:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                request += chunk
            head, _, _rest = request.partition(b"\r\n\r\n")
            lines = head.decode("iso-8859-1").split("\r\n")
            path = lines[0].split(" ")[1]
            headers = {}
            for line in lines[1:]:
                name, _, value = line.partition(":")
                headers[name.strip().lower()] = value.strip()

            if path == "/json/version" and "upgrade" not in headers:
                body = json.dumps({
                    "Browser": "Chrome/Mock",
                    "webSocketDebuggerUrl": f"ws://127.0.0.1:{self.port}/devtools/browser/test",
                }).encode()
                conn.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                    + body
                )
                return

            if path == "/devtools/browser/test" and "upgrade" in headers.get("connection", "").lower():
                accept = base64.b64encode(hashlib.sha1(
                    (headers["sec-websocket-key"] + WS_GUID).encode()).digest()).decode()
                conn.sendall(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                    + b"Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept.encode() + b"\r\n\r\n"
                )
                opcode, payload = _read_frame(conn)
                assert opcode == 0x1, opcode
                message = json.loads(payload.decode())
                assert message["method"] == "Storage.getCookies", message
                _send_frame(conn, json.dumps({
                    "id": message["id"],
                    "result": {"cookies": self.cookies},
                }).encode())
                return

            conn.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def close(self):
        self.stopped.set()
        try:
            self.sock.close()
        except Exception:
            pass


def _cookie(name, value, domain=".google.com", path="/", expires=-1):
    return {"name": name, "value": value, "domain": domain, "path": path,
            "expires": expires, "secure": True, "httpOnly": False}


def test_header_filters_and_dedupes():
    cookies = [
        _cookie("SAPISID", "a" * 34),
        _cookie("SAPISID", SAPISID, domain="gemini.google.com"),
        _cookie("NID", "nid-value"),
        _cookie("AEC", "x;y"),
        _cookie("BAD\x00", "v"),
        _cookie("OTHER", "z", domain=".example.com"),
        _cookie("OLD", "z", expires=1),
    ]
    header, pairs, sapisid = build_cookie_header(cookies)
    assert sapisid == SAPISID, sapisid
    assert "NID=nid-value" in header
    assert "SAPISID=aaaaaaaa" not in header
    assert "OTHER" not in header and "AEC" not in header and "OLD" not in header
    assert len(pairs) == 2, pairs
    print("ok: header filters/domain/dedupe/expiry")


def test_no_sapisid():
    header, pairs, sapisid = build_cookie_header([_cookie("NID", "v")])
    assert header == "NID=v", header
    assert sapisid == ""
    print("ok: missing SAPISID is reported without failing")


def test_cdp_roundtrip():
    cookies = [
        _cookie("SAPISID", SAPISID),
        _cookie("NID", "nid"),
        _cookie("DUP", "google"),
        _cookie("DUP", "gemini", domain="gemini.google.com"),
        _cookie("X", "y", domain=".example.com"),
    ]
    server = MockCdpServer(cookies)
    profile = tempfile.mkdtemp(prefix="ag_cdp_mock_")
    try:
        with open(os.path.join(profile, "DevToolsActivePort"), "w", encoding="utf-8") as f:
            f.write(f"{server.port}\n/devtools/browser/test\n")
        port, version = ensure_browser_endpoint(profile, launch=False)
        assert port == server.port
        assert version["Browser"] == "Chrome/Mock"
        header, info = extract_cookie_header_via_cdp(profile_dir=profile, timeout=3, launch=False)
        assert info["count"] == 3, info
        assert info["has_sapisid"] is True
        assert f"SAPISID={SAPISID}" in header
        assert "NID=nid" in header and "DUP=gemini" in header
        assert "X=y" not in header
        print("ok: CDP HTTP + WebSocket roundtrip")
    finally:
        server.close()
        shutil.rmtree(profile, ignore_errors=True)


def test_no_endpoint():
    profile = tempfile.mkdtemp(prefix="ag_cdp_none_")
    try:
        try:
            ensure_browser_endpoint(profile, launch=False)
        except CdpError:
            print("ok: missing endpoint raises a clear error")
        else:
            raise AssertionError("expected CdpError")
    finally:
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    test_header_filters_and_dedupes()
    test_no_sapisid()
    test_cdp_roundtrip()
    test_no_endpoint()
    print("ALL CDP COOKIE UNIT TESTS PASSED!")

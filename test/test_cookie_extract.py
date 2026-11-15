# -*- coding: utf-8 -*-
"""Юнит-тесты автоизвлечения куки (scripts/extract_gemini_cookie.py).

Строят поддельную БД Cookies в формате Chromium и проверяют чтение
без настоящего браузера и без DPAPI (значения в открытом виде).
Запуск: python test/test_cookie_extract.py
"""
import os
import hashlib
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from scripts.extract_gemini_cookie import (
    _read_cookies_from_db, _decrypt_cookie_value, extract_cookie_header,
    _cookie_db_paths, candidate_user_dirs,
)
import scripts.extract_gemini_cookie as _egc_mod


def make_fake_db(rows):
    fd, path = tempfile.mkstemp(prefix="fake_cookies_", suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, "
        "encrypted_value BLOB, path TEXT DEFAULT '/')"
    )
    conn.executemany(
        "INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()
    return path


def test_basic_extraction():
    db = make_fake_db([
        (".google.com", "SAPISID", "s3cr3t", b""),
        (".google.com", "SID", "sid_val", b""),
        (".example.com", "OTHER", "x", b""),  # чужой домен — не берём
        (".google.com", "", "noname", b""),   # без имени — пропускаем
    ])
    try:
        header, pairs = _read_cookies_from_db(db, ("google.com",))
        assert "SAPISID=s3cr3t" in header, header
        assert "SID=sid_val" in header, header
        assert "OTHER" not in header, header
        assert len(pairs) == 2, pairs
        assert "SAPISID=" in header
    finally:
        os.unlink(db)
    print("ok: basic extraction")


def test_domain_filter():
    db = make_fake_db([
        ("gemini.google.com", "A", "1", b""),
        (".google.com", "B", "2", b""),
    ])
    try:
        header, _ = _read_cookies_from_db(db, ("gemini.google.com",))
        assert "A=1" in header and "B=2" not in header, header
        header2, _ = _read_cookies_from_db(db, ("google.com",))
        assert "A=1" in header2 and "B=2" in header2, header2
    finally:
        os.unlink(db)
    print("ok: domain filter")


def test_plaintext_passthrough():
    # незашифрованное значение в encrypted_value — возвращается как есть
    assert _decrypt_cookie_value(b"plain_value") == "plain_value"
    assert _decrypt_cookie_value(b"") == ""
    print("ok: plaintext passthrough")


def test_encrypted_skipped_gracefully():
    # зашифрованное значение без ключа AES — пара пропускается, а не роняет всё
    db = make_fake_db([
        (".google.com", "ENC", "", b"v10" + b"\x00" * 30),
        (".google.com", "OK", "fine", b""),
    ])
    try:
        header, pairs = _read_cookies_from_db(db, ("google.com",), aes_key=None)
        assert "OK=fine" in header, header
        assert len(pairs) == 1, pairs
    finally:
        os.unlink(db)
    print("ok: undecryptable skipped")


def _v10(host_key, value, key):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = b"n" * 12
    plain = hashlib.sha256(host_key.encode()).digest() + value.encode()
    return b"v10" + nonce + AESGCM(key).encrypt(nonce, plain, None)


def test_domain_binding_prefix_stripped():
    """Chrome 130+ добавляет SHA256(host) перед значением — он не должен попасть в заголовок."""
    key = b"k" * 32
    enc = _v10(".google.com", "SAPISID_VALUE_1234567890", key)
    assert _decrypt_cookie_value(enc, key, ".google.com") == "SAPISID_VALUE_1234567890"
    db = make_fake_db([
        (".google.com", "SAPISID", "", enc),
        (".google.com", "OK", "fine", b""),
    ])
    try:
        header, pairs = _read_cookies_from_db(db, ("google.com",), aes_key=key)
        assert "SAPISID=SAPISID_VALUE_1234567890" in header, header
        assert "OK=fine" in header, header
        assert len(pairs) == 2, pairs
    finally:
        os.unlink(db)
    print("ok: domain binding prefix stripped")


def test_appbound_v20_skipped():
    """v20 (App-Bound Encryption) нельзя расшифровать — значение не должно попадать в куки."""
    db = make_fake_db([
        (".google.com", "SAPISID", "", b"v20" + b"\x00" * 40),
        (".google.com", "OK", "fine", b""),
    ])
    try:
        stats = {}
        header, pairs = _read_cookies_from_db(db, ("google.com",), aes_key=b"k" * 32, stats=stats)
        assert "SAPISID" not in header, header
        assert "OK=fine" in header, header
        assert stats.get("appbound_skipped") == 1, stats
    finally:
        os.unlink(db)
    print("ok: app-bound v20 skipped")


def _make_profile_db(user_data, *rel_parts, cookies=()):
    p = os.path.join(user_data, *rel_parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    conn = sqlite3.connect(p)
    conn.execute("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)")
    conn.executemany("INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?,?,?,?)",
                     [(h, n, v, b"") for h, n, v in cookies])
    conn.commit(); conn.close()
    return p


def test_multi_browser_scan():
    """Сканирование всех браузеров: выбор профиля с SAPISID и макс. числом куки."""
    import shutil
    tmp = tempfile.mkdtemp(prefix="fake_browsers_")
    try:
        chrome = os.path.join(tmp, "Chrome", "User Data")
        edge = os.path.join(tmp, "Edge", "User Data")
        _make_profile_db(chrome, "Default", "Cookies", cookies=[
            (".google.com", "NID", "abc"), (".google.com", "1P_JAR", "xyz")])
        _make_profile_db(chrome, "Profile 1", "Cookies", cookies=[
            (".google.com", "SAPISID", "sapisid_1_0123456789abcdef"), (".google.com", "__Secure-1PSID", "p"),
            (".google.com", "NID", "n"), (".google.com", "AEC", "a")])
        _make_profile_db(edge, "Default", "Cookies", cookies=[
            (".google.com", "SAPISID", "edge_sapisid_0123456789abcdef")])
        _egc_mod.candidate_user_dirs = lambda: [(chrome, "Chrome"), (edge, "Edge")]
        try:
            header, info = extract_cookie_header()
        finally:
            del _egc_mod.candidate_user_dirs  # noqa, restore not needed in test proc
        assert info["browser"] == "Chrome", info
        assert "Profile 1" in info["profile"], info["profile"]
        assert info["has_sapisid"] is True
        assert "SAPISID=sapisid_1_0123456789abcdef" in header, header
        print("ok: multi-browser scan prefers SAPISID+count")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_cookie_db_paths_finds_all_profiles():
    import shutil
    tmp = tempfile.mkdtemp(prefix="fake_ud_")
    try:
        ud = os.path.join(tmp, "User Data")
        _make_profile_db(ud, "Default", "Cookies", cookies=[(".google.com", "NID", "x")])
        _make_profile_db(ud, "Profile 2", "Cookies", cookies=[(".google.com", "NID", "y")])
        paths = _cookie_db_paths(ud)
        assert len(paths) == 2, paths
        assert any("Profile 2" in c for c in paths), paths
        print("ok: all profiles found")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    test_basic_extraction()
    test_domain_filter()
    test_plaintext_passthrough()
    test_encrypted_skipped_gracefully()
    test_domain_binding_prefix_stripped()
    test_appbound_v20_skipped()
    test_multi_browser_scan()
    test_cookie_db_paths_finds_all_profiles()
    print("ALL COOKIE EXTRACT UNIT TESTS PASSED!")

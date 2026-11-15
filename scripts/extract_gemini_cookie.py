# -*- coding: utf-8 -*-
"""
Автоматическое извлечение Google-куки для Gemini Web Bridge.

Читает куки из ВЫДЕЛЕННОГО профиля браузера, который создаёт само приложение
(scripts/gemini_browser.py -> %LOCALAPPDATA%\\AntigravityAPI\\GeminiBrowser).
Пользователь один раз входит на gemini.google.com в этом окне (кнопка
«Открыть сайт Gemini»), дальше сессия подхватывается автоматически —
копипаст куки не нужен.

Windows: значения расшифровываются через DPAPI (старый формат) либо
AES-256-GCM с ключом из файла 'Local State' (Chrome/Edge 127+).
Chrome 130+ добавляет к значению 32-байтный SHA256(домен) — он снимается.
Куки v20 (App-Bound Encryption) прочитать без запуска браузера нельзя:
для них используйте выделенный профиль приложения («Открыть сайт Gemini»).
Нужен пакет `cryptography` (уже в requirements.txt).

Безопасность:
- Читаются ТОЛЬКО куки google.com из профиля, созданного этим приложением.
- Куки никуда не отправляются, кроме запросов самого веб-моста к gemini.google.com.
- Расшифровка DPAPI работает только под учёткой текущего пользователя Windows.

Использование:
    python scripts/extract_gemini_cookie.py            # напечатать Cookie-заголовок
    python scripts/extract_gemini_cookie.py --check    # диагностика (профиль, БД, SAPISID)
"""

import base64
import hashlib
import json
import os
import platform
import re
import shutil
import sqlite3
import sys
import tempfile
import time

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def get_profile_dir():
    """Каталог выделенного профиля (та же логика, что в gemini_browser.py)."""
    system = platform.system()
    if system == "Windows" or os.name == "nt":
        root = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(root, "AntigravityAPI", "GeminiBrowser")
    return os.path.join(os.path.expanduser("~"), ".local", "share", "AntigravityAPI", "GeminiBrowser")


def candidate_user_dirs():
    """Все каталоги User Data, где могут лежать куки Google.

    Возвращает [(user_data_dir, browser_name)], от специфичного к общему:
    сначала выделенный профиль приложения, затем обычные браузеры.
    """
    dirs = []
    if os.name == "nt" or platform.system() == "Windows":
        local = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        dirs.append((os.path.join(local, "AntigravityAPI", "GeminiBrowser"), "AntigravityAPI"))
        dirs.append((os.path.join(local, "Google", "Chrome", "User Data"), "Chrome"))
        dirs.append((os.path.join(local, "Microsoft", "Edge", "User Data"), "Edge"))
        dirs.append((os.path.join(local, "BraveSoftware", "Brave-Browser", "User Data"), "Brave"))
    else:
        home = os.path.expanduser("~")
        dirs.append((os.path.join(home, ".config", "google-chrome"), "Chrome"))
        dirs.append((os.path.join(home, ".config", "microsoft-edge"), "Edge"))
        dirs.append((os.path.join(home, ".local", "share", "AntigravityAPI", "GeminiBrowser"),
                     "AntigravityAPI"))
    return [(d, name) for d, name in dirs if os.path.isdir(d)]


def _cookie_db_paths(user_data_dir):
    """Пути к БД Cookies во всех профилях внутри user_data_dir.

    Chrome 131+ перенёс куки в <профиль>/Network/Cookies (раньше было
    <профиль>/Cookies) — проверяем оба варианта.
    """
    # Каталоги профилей: корень User Data, Default, Profile N
    profile_dirs = []
    try:
        names = sorted(os.listdir(user_data_dir))
    except OSError:
        names = []
    if os.path.isdir(os.path.join(user_data_dir, "Default")):
        profile_dirs.append(os.path.join(user_data_dir, "Default"))
    for n in names:
        if n.startswith("Profile ") and os.path.isdir(os.path.join(user_data_dir, n)):
            profile_dirs.append(os.path.join(user_data_dir, n))
    if not profile_dirs:
        # Нет подпрофилей (выделенный профиль приложения) — сам каталог
        profile_dirs.append(user_data_dir)
    paths = []
    for pdir in profile_dirs:
        for c in (os.path.join(pdir, "Network", "Cookies"),  # Chrome 131+
                  os.path.join(pdir, "Cookies")):            # старый layout
            if os.path.isfile(c) and c not in paths:
                paths.append(c)
    return paths


def _find_local_state(start_dir, max_up=3):
    """Local State ищем вверх от БД: у Chrome он в User Data, у выделенного профиля — рядом."""
    d = os.path.abspath(start_dir)
    for _ in range(max_up):
        cand = os.path.join(d, "Local State")
        if os.path.isfile(cand):
            return cand
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def _get_aes_key_from(local_state_path):
    """Ключ AES-256 из конкретного файла Local State (DPAPI-обёртка)."""
    if not local_state_path or not os.path.isfile(local_state_path):
        return None
    with open(local_state_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    enc_key_b64 = (data.get("os_crypt") or {}).get("encrypted_key")
    if not enc_key_b64:
        return None
    enc_key = base64.b64decode(enc_key_b64)
    if enc_key.startswith(b"DPAPI"):
        enc_key = enc_key[5:]
    return _dpapi_decrypt(enc_key)


def _dpapi_decrypt(blob):
    """Расшифровка DPAPI (только Windows, только данные текущего пользователя)."""
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD),
                    ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf_in = ctypes.create_string_buffer(blob)
    blob_in = DATA_BLOB(len(blob), ctypes.cast(buf_in, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    if not crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0,
                                     ctypes.byref(blob_out)):
        raise RuntimeError("DPAPI: не удалось расшифровать (CryptUnprotectData вернул ошибку)")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


class AppBoundCookieError(RuntimeError):
    """Chrome 127+ App-Bound Encryption (v20): без самого браузера не расшифровать."""


_SAPISID_RE = re.compile(r"^[A-Za-z0-9_\-./=]+$")
_COOKIE_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")


def _domain_matches(host, domains):
    host = str(host or "").lower().lstrip(".")
    return any(host == d or host.endswith("." + d) for d in domains)


def _strip_domain_binding(raw, host_key):
    """Chrome 130+ prefixes the plaintext with SHA256(cookie domain).

    Без снятия этих 32 байт в Cookie-заголовок попадает бинарный мусор,
    и Google отвечает 401/400 — приходилось вставлять куки вручную.
    """
    if not host_key or len(raw) <= 32:
        return raw
    for domain in {host_key, host_key.lstrip(".")}:
        if raw[:32] == hashlib.sha256(domain.encode("utf-8")).digest():
            return raw[32:]
    return raw


def _decode_plain(raw, host_key):
    return _strip_domain_binding(raw, host_key).decode("utf-8", "replace")


def _decrypt_cookie_value(encrypted_value, aes_key=None, host_key=""):
    """Расшифровка значения куки: v10/v11 (AES-GCM) или старый DPAPI-формат."""
    if not encrypted_value:
        return ""
    if encrypted_value.startswith(b"v20"):
        raise AppBoundCookieError(
            "App-Bound Encryption (v20): Chrome/Edge/Brave не отдают такие куки без запуска браузера"
        )
    if encrypted_value.startswith(b"v10") or encrypted_value.startswith(b"v11"):
        if aes_key is None:
            raise RuntimeError("Куки зашифрованы AES-GCM (Chrome 127+): нужен пакет 'cryptography' "
                               "и файл 'Local State' в профиле")
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        except ImportError:
            raise RuntimeError("Нужен пакет 'cryptography': pip install cryptography")
        nonce, ciphertext = encrypted_value[3:15], encrypted_value[15:]
        raw = AESGCM(aes_key).decrypt(nonce, ciphertext, None)
        return _decode_plain(raw, host_key)
    if encrypted_value.startswith(b"\x01\x00\x00\x00"):
        return _decode_plain(_dpapi_decrypt(encrypted_value), host_key)
    # незашифрованное (редко, но бывает)
    try:
        return encrypted_value.decode("utf-8", "replace")
    except Exception:
        return ""


def _copy_cookie_db(src):
    """Копия БД Cookies во временный файл (исходник может быть занят браузером)."""
    if not os.path.isfile(src):
        raise FileNotFoundError(f"Файл Cookies не найден: {src}")
    tmp = tempfile.NamedTemporaryFile(prefix="ag_cookies_", suffix=".db", delete=False)
    tmp.close()
    shutil.copy2(src, tmp.name)
    for suffix in ("-wal", "-shm"):
        if os.path.isfile(src + suffix):
            try:
                shutil.copy2(src + suffix, tmp.name + suffix)
            except OSError:
                pass
    return tmp.name


def _extract_from_db(db_path, domains, stats=None):
    """Извлечение куки из одной БД. Возвращает (header, pairs, has_sapisid)."""
    aes_key = None
    ls = _find_local_state(os.path.dirname(db_path))
    if ls:
        try:
            aes_key = _get_aes_key_from(ls)
        except Exception:
            aes_key = None  # попробуем старый DPAPI-формат / открытый текст
    db_stats = {}
    tmp = _copy_cookie_db(db_path)
    try:
        header, pairs = _read_cookies_from_db(tmp, domains, aes_key, stats=db_stats)
    finally:
        for c in (tmp, tmp + "-wal", tmp + "-shm"):
            try:
                os.unlink(c)
            except OSError:
                pass
    if stats is not None:
        for key, value in db_stats.items():
            stats[key] = stats.get(key, 0) + value
    return header, pairs, bool(_valid_sapisid(pairs))


def _valid_sapisid(pairs):
    for _, pair in pairs:
        if pair.startswith("SAPISID="):
            value = pair.split("=", 1)[1]
            if len(value) >= 20 and _SAPISID_RE.match(value):
                return value
    return ""


def firefox_profile_dbs():
    """Пути cookies.sqlite во всех профилях Firefox (plaintext, без DBSC)."""
    system = platform.system()
    if os.name == "nt" or system == "Windows":
        base = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"),
                            "Mozilla", "Firefox", "Profiles")
    elif system == "Darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support",
                            "Firefox", "Profiles")
    else:
        base = os.path.join(os.path.expanduser("~"), ".mozilla", "firefox")
    paths = []
    try:
        for name in sorted(os.listdir(base)):
            p = os.path.join(base, name, "cookies.sqlite")
            if os.path.isfile(p):
                paths.append(p)
    except OSError:
        pass
    return paths


def _host_applies(domain, host):
    d = str(domain or "").lower()
    h = str(host or "").lower()
    if not d:
        return False
    if d.startswith("."):
        base = d[1:]
        return h == base or h.endswith("." + base)
    return h == d


def _extract_from_firefox_db(db_path, domains=("google.com",), host="gemini.google.com"):
    """(header, pairs, sapisid) из cookies.sqlite Firefox (moz_cookies, plaintext)."""
    tmp = _copy_cookie_db(db_path)
    try:
        conn = sqlite3.connect(tmp)
        try:
            rows = conn.execute(
                "SELECT host, name, value, path, expiry FROM moz_cookies"
            ).fetchall()
        finally:
            conn.close()
    finally:
        for c in (tmp, tmp + "-wal", tmp + "-shm"):
            try:
                os.unlink(c)
            except OSError:
                pass
    now = time.time()
    selected = []
    for host_key, name, value, path, expiry in rows:
        name = str(name or "").strip()
        if not name or not _COOKIE_NAME_RE.match(name):
            continue
        host_str = str(host_key or "")
        if not _host_applies(host_str, host) or not _domain_matches(host_str.lstrip(".").lower(), domains):
            continue
        if isinstance(expiry, (int, float)) and expiry > 0 and expiry < now:
            continue
        if not isinstance(value, str) or not value:
            continue
        path_str = str(path or "/")
        rank = (len(path_str), 0 if host_str.startswith(".") else 1, len(host_str))
        selected.append((rank, host_str.lstrip("."), name, value))
    selected.sort(key=lambda item: (-item[0][0], -item[0][1], -item[0][2], item[2]))
    pairs = [(item[1], f"{item[2]}={item[3]}") for item in selected]
    header = "; ".join(pair for _, pair in pairs)
    return header, pairs, bool(_valid_sapisid(pairs))


def extract_firefox_cookie_header(profiles=None, domains=("google.com",)):
    """Куки Google из Firefox. Возвращает (header, info); значения не логируются."""
    db_paths = list(profiles) if profiles else firefox_profile_dbs()
    if not db_paths:
        raise FileNotFoundError(
            "Firefox не найден или в нём нет профиля. Установите Firefox с "
            "https://www.mozilla.org/firefox/ и войдите на gemini.google.com."
        )
    best = None
    for db in db_paths:
        try:
            header, pairs, sapisid = _extract_from_firefox_db(db, domains)
        except Exception:
            continue
        if not pairs:
            continue
        score = (1 if sapisid else 0, len(pairs))
        if best is None or score > best[0]:
            best = (score, header, pairs, sapisid, db)
    if best is None:
        raise RuntimeError("В Firefox не найдены куки google.com — войдите на gemini.google.com.")
    _, header, pairs, sapisid, db = best
    return header, {
        "count": len(pairs),
        "has_sapisid": bool(sapisid),
        "profile": db,
        "browser": "Firefox",
        "source": "firefox",
        "appbound_skipped": 0,
        "decrypt_failed": 0,
        "corrupt_skipped": 0,
    }


def extract_cookie_header(profile_dir=None, domains=("google.com",)):
    """
    Возвращает (cookie_header, info).
    Сканирует ВСЕ браузеры: выделенный профиль приложения, Chrome, Edge, Brave
    (все профили: Default, Profile 1, ...). Выбирает БД с SAPISID и макс. числом куки.
    info — dict: count, has_sapisid, profile, browser и счётчики пропущенных куки.
    """
    if profile_dir:
        targets = [(profile_dir, "custom")]
    else:
        targets = candidate_user_dirs()
    if not targets:
        raise FileNotFoundError(
            "Не найден ни один профиль браузера. Войдите в Google-аккаунт в Chrome/Edge "
            "или нажмите «Открыть сайт Gemini» в приложении."
        )

    tried = []
    best = None  # (score, header, info)
    totals = {}
    for user_dir, browser in targets:
        for db_path in _cookie_db_paths(user_dir):
            tried.append(f"{browser}: {db_path}")
            db_stats = {}
            try:
                header, pairs, has_sapisid = _extract_from_db(db_path, domains, db_stats)
            except Exception:
                continue
            for key, value in db_stats.items():
                totals[key] = totals.get(key, 0) + value
            if not pairs:
                continue
            # SAPISID важнее всего (признак входа), затем выделенный профиль, затем число куки
            score = (1 if has_sapisid else 0,
                     1 if browser == "AntigravityAPI" else 0,
                     len(pairs))
            info = {"count": len(pairs), "has_sapisid": has_sapisid,
                    "profile": db_path, "browser": browser,
                    "appbound_skipped": db_stats.get("appbound_skipped", 0),
                    "decrypt_failed": db_stats.get("decrypt_failed", 0),
                    "corrupt_skipped": db_stats.get("corrupt_skipped", 0)}
            if best is None or score > best[0]:
                best = (score, header, info)
    if best is None:
        extra = ""
        if totals.get("appbound_skipped"):
            extra = (
                f" Найдено {totals['appbound_skipped']} куки с App-Bound Encryption (v20): "
                "Chrome/Edge/Brave не отдают их без запуска браузера. Запустите scripts/cookies_cdp.py "
                "(выделенный профиль) и войдите в аккаунт, либо используйте Firefox."
            )
        raise RuntimeError(
            "Куки google.com не найдены ни в одном браузере. "
            "Проверено: " + ("; ".join(tried) if tried else "профили не найдены") + "."
            + extra
        )
    return best[1], best[2]


def _read_cookies_from_db(db_path, domains=("google.com",), aes_key=None, stats=None):
    """Чтение и расшифровка куки из файла БД (чистая функция, тестируемая везде)."""
    stats = stats if stats is not None else {}
    pairs = []
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = conn.cursor()
        like = " OR ".join(["host_key LIKE ?"] * len(domains))
        params = [f"%{d}" for d in domains]
        rows = cur.execute(
            f"SELECT host_key, name, value, encrypted_value FROM cookies WHERE {like}",
            params,
        ).fetchall()
    finally:
        conn.close()

    for host_key, name, value, encrypted_value in rows:
        if not name:
            continue
        val = value
        if not val and encrypted_value:
            try:
                val = _decrypt_cookie_value(encrypted_value, aes_key, host_key)
            except AppBoundCookieError:
                stats["appbound_skipped"] = stats.get("appbound_skipped", 0) + 1
                continue
            except Exception:
                stats["decrypt_failed"] = stats.get("decrypt_failed", 0) + 1
                continue
        if not val:
            continue
        # Бинарный префикс/битый UTF-8 не должен попасть в Cookie-заголовок.
        if "\ufffd" in val or "\x00" in val:
            stats["corrupt_skipped"] = stats.get("corrupt_skipped", 0) + 1
            continue
        # более специфичные хосты — раньше (как в браузере)
        pairs.append((len(host_key), f"{name}={val}"))
    pairs.sort(key=lambda x: -x[0])
    return "; ".join(p[1] for p in pairs), pairs


def main():
    check_only = "--check" in sys.argv
    try:
        if check_only:
            targets = candidate_user_dirs()
            if not targets:
                print("Не найден ни один каталог браузеров.")
                return
            for user_dir, browser in targets:
                print(f"[{browser}] {user_dir}")
                dbs = _cookie_db_paths(user_dir)
                if not dbs:
                    print("  БД Cookies: НЕ найдена")
                for db in dbs:
                    print(f"  БД Cookies: найдена ({os.path.relpath(db, user_dir)})")
                ls = _find_local_state(user_dir)
                print(f"  Local State: {'найден' if ls else 'НЕ найден'}")
            return
        header, info = extract_cookie_header()
        print(f"Браузер: {info.get('browser')}, профиль: {info.get('profile')}")
        print(f"Куки: {info['count']} шт., SAPISID: {'есть' if info['has_sapisid'] else 'НЕТ'}")
        if not info["has_sapisid"]:
            print("ВНИМАНИЕ: нет SAPISID — для моста нужен вход в аккаунт на gemini.google.com",
                  file=sys.stderr)
        print(header)
    except Exception as e:
        print(f"✗ {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

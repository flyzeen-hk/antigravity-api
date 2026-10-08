# -*- coding: utf-8 -*-
"""
Кроссплатформенный автопоиск и извлечение OAuth-токена Google Antigravity.

Поддерживает операционные системы:
- Windows:  %APPDATA%/Antigravity IDE/User/globalStorage/state.vscdb
- macOS:    ~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb
- Linux:    ~/.config/Antigravity IDE/User/globalStorage/state.vscdb

Хранилище IDE: SQLite база данных state.vscdb.
Ключ: 'antigravityUnifiedStateSync.oauthToken'
Вложенность: Protobuf Base64 -> SentinelKey -> Protobuf Base64 (access_token, token_type, refresh_token).

Секреты сохраняются исключительно локально в auth.json с правами 0600.
"""

import base64
import json
import os
import platform
import sqlite3
import sys
import time

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUTH_FILE = os.path.join(BASE_DIR, "auth.json")


def get_candidate_db_paths():
    """Возвращает список потенциальных путей к state.vscdb для текущей ОС."""
    paths = []
    system = platform.system()

    # Windows
    if system == "Windows" or os.name == "nt":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            paths.append(os.path.join(appdata, "Antigravity IDE", "User", "globalStorage", "state.vscdb"))
            paths.append(os.path.join(appdata, "antigravity", "User", "globalStorage", "state.vscdb"))
            paths.append(os.path.join(appdata, "Antigravity", "User", "globalStorage", "state.vscdb"))
        userprofile = os.environ.get("USERPROFILE", "")
        if userprofile:
            paths.append(os.path.join(userprofile, "AppData", "Roaming", "Antigravity IDE", "User", "globalStorage", "state.vscdb"))

    # macOS
    elif system == "Darwin":
        home = os.path.expanduser("~")
        paths.append(os.path.join(home, "Library", "Application Support", "Antigravity IDE", "User", "globalStorage", "state.vscdb"))
        paths.append(os.path.join(home, "Library", "Application Support", "antigravity", "User", "globalStorage", "state.vscdb"))
        paths.append(os.path.join(home, "Library", "Application Support", "Antigravity", "User", "globalStorage", "state.vscdb"))

    # Linux
    else:
        home = os.path.expanduser("~")
        paths.append(os.path.join(home, ".config", "Antigravity IDE", "User", "globalStorage", "state.vscdb"))
        paths.append(os.path.join(home, ".config", "antigravity", "User", "globalStorage", "state.vscdb"))
        paths.append(os.path.join(home, ".config", "Antigravity", "User", "globalStorage", "state.vscdb"))

    # Пользовательский путь через переменную окружения (на случай нестандартной директории)
    custom_path = os.environ.get("ANTIGRAVITY_STATE_DB")
    if custom_path:
        paths.insert(0, custom_path)

    return paths


def find_antigravity_db():
    """Ищет существующий файл state.vscdb среди кандидатов."""
    candidates = get_candidate_db_paths()
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def read_varint(b, i):
    r = 0
    sh = 0
    while True:
        if i >= len(b):
            raise ValueError("Unexpected EOF reading varint")
        x = b[i]
        i += 1
        r |= (x & 0x7F) << sh
        if not (x & 0x80):
            return r, i
        sh += 7


def fields(b):
    i = 0
    while i < len(b):
        tag, i = read_varint(b, i)
        f, wt = tag >> 3, tag & 7
        if wt == 0:
            val, i = read_varint(b, i)
            yield f, wt, val
        elif wt == 2:
            ln, i = read_varint(b, i)
            yield f, wt, b[i : i + ln]
            i += ln
        elif wt == 5:
            yield f, wt, b[i : i + 4]
            i += 4
        elif wt == 1:
            yield f, wt, b[i : i + 8]
            i += 8
        else:
            raise ValueError("bad wiretype %d" % wt)


def extract_token_from_db(db_path=None):
    """
    Извлекает access_token и refresh_token из файла state.vscdb.
    Возвращает dict с полями токена или вызывает RuntimeError с описанием.
    """
    if not db_path:
        db_path = find_antigravity_db()
        if not db_path:
            raise FileNotFoundError(
                "База данных Antigravity IDE (state.vscdb) не найдена. "
                "Убедитесь, что Antigravity IDE установлена и хотя бы один раз запущена."
            )

    try:
        # SQLite с флагом readonly / URI
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cursor = conn.cursor()
        row = cursor.execute(
            "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.oauthToken'"
        ).fetchone()
        conn.close()
    except Exception as e:
        raise RuntimeError(f"Ошибка чтения SQLite базы {db_path}: {e}")

    if not row or not row[0]:
        raise ValueError(
            "Токен не найден в базе данных. "
            "Откройте Antigravity IDE и войдите в свой Google аккаунт."
        )

    try:
        buf = base64.b64decode(row[0])
    except Exception as e:
        raise ValueError(f"Не удалось декодировать Base64 oauthToken: {e}")

    access = refresh = tok_type = None
    try:
        for _, wt, entry in fields(buf):
            if wt != 2:
                continue
            key = val = None
            for f2, w2, v2 in fields(entry):
                if f2 == 1:
                    key = v2.decode("utf-8", "replace")
                if f2 == 2:
                    for f3, w3, v3 in fields(v2):
                        if f3 == 1:
                            val = v3
            if key == "oauthTokenInfoSentinelKey" and val:
                tok = base64.b64decode(val)
                for f, w, x in fields(tok):
                    if w != 2:
                        continue
                    if f == 1:
                        access = x.decode("utf-8", "replace")
                    elif f == 2:
                        tok_type = x.decode("utf-8", "replace")
                    elif f == 3:
                        refresh = x.decode("utf-8", "replace")
    except Exception as e:
        raise ValueError(f"Ошибка разбора структуры Protobuf: {e}")

    if not refresh:
        raise ValueError("refresh_token не найден в профиле Antigravity. Пройдите повторный вход в IDE.")

    return {
        "type": "antigravity",
        "token_type": tok_type or "Bearer",
        "refresh_token": refresh,
        "access_token": access or "",
        "access_expires_at": 0,
        "project_id": "",
        "extracted_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "db_source": db_path,
    }


def save_auth(token_data, out_path=AUTH_FILE):
    """Сохраняет извлечённый токен в auth.json с безопасными правами доступа."""
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(token_data, fh, indent=2)
    try:
        os.chmod(out_path, 0o600)
    except OSError:
        pass
    return out_path


def auto_extract(force=False, out_path=AUTH_FILE):
    """
    Выполняет автоматический поиск и извлечение токена.
    Если файл auth.json уже существует и валиден, перезаписывает только при force=True.
    """
    if os.path.exists(out_path) and not force:
        try:
            with open(out_path, "r", encoding="utf-8") as f:
                d = json.load(f)
                if d.get("refresh_token"):
                    return {"ok": True, "path": out_path, "cached": True, "data": d}
        except Exception:
            pass

    token_data = extract_token_from_db()
    save_auth(token_data, out_path)
    return {"ok": True, "path": out_path, "cached": False, "data": token_data}


def main():
    print("Поиск Antigravity IDE в системе...")
    try:
        res = auto_extract(force=True)
        d = res["data"]
        print(f"✓ Успешно найдено и извлечено в: {res['path']}")
        print(f"  Источник: {d.get('db_source')}")
        print(f"  access_token:  {d.get('access_token')[:10]}... (len={len(d.get('access_token', ''))})")
        print(f"  refresh_token: {d.get('refresh_token')[:8]}... (len={len(d.get('refresh_token', ''))})")
        print("✓ Секреты сохранены в auth.json. Файл защищён и не должен передаваться третьим лицам.")
    except Exception as e:
        print(f"✗ Ошибка извлечения токена: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

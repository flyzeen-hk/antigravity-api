# -*- coding: utf-8 -*-
"""
Antigravity API — Desktop Control Panel & Dashboard.

A quiet, readable desktop workspace for server controls, upstream quotas,
account status and connection details. Optional local limits and Gemini Web
configuration remain in Settings; public server contracts are unchanged.
"""

import json
import http.client
import ipaddress
import os
import queue
import re
import socket
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone

import tkinter as tk
from tkinter import font as tkfont
from tkinter import filedialog
from tkinter import messagebox
from tkinter import ttk

import window_guard

try:
    from PIL import Image, ImageTk
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    from scripts.extract_token import auto_extract, find_antigravity_db
except ImportError:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
    from extract_token import auto_extract, find_antigravity_db

BASE = os.path.dirname(os.path.abspath(__file__))
APP_NAME = "Antigravity API"
LOG_FILE = os.path.join(os.environ.get("TEMP", BASE), "antigravity-api.log")
LOGO_PNG = os.path.join(BASE, "assets", "antigravity_logo_ui.png")
if not os.path.exists(LOGO_PNG):
    LOGO_PNG = os.path.join(BASE, "assets", "antigravity_logo.png")
ICO_PATH = os.path.join(BASE, "assets", "antigravity_api.ico")
if not os.path.exists(ICO_PATH):
    ICO_PATH = os.path.join(BASE, "antigravity_api.ico")
AUTH_FILE = os.path.join(BASE, "auth.json")
GEMINI_URL = "https://gemini.google.com/app"

# ==================== UI LANGUAGE ====================
# Kept in its own file: config.json holds live credentials and must stay untouched.
LANG_FILE = os.path.join(BASE, "ui_language.txt")


def read_ui_language():
    try:
        with open(LANG_FILE, encoding="utf-8") as f:
            return "ru" if f.read().strip().lower() == "ru" else "en"
    except Exception:
        return "en"


def set_ui_language(lang):
    global UI_LANG
    UI_LANG = "en" if lang == "en" else "ru"
    try:
        with open(LANG_FILE, "w", encoding="utf-8") as f:
            f.write(UI_LANG + "\n")
    except Exception:
        pass
    return UI_LANG


UI_LANG = read_ui_language()


def T(ru, en):
    """Return the string for the active UI language."""
    return en if UI_LANG == "en" else ru


# ==================== ANTIGRAVITY INSTALLATIONS ====================
# Paths live outside config.json: it holds live credentials.
INSTALLS_FILE = os.path.join(BASE, "install_paths.json")

INSTALL_SPECS = (
    ("app", "Antigravity", "Antigravity"),
    ("ide", "Antigravity IDE", "Antigravity IDE"),
    ("cli", "Antigravity CLI", "Antigravity CLI"),
    ("vscode", "Antigravity для VS Code", "Antigravity for VS Code"),
)


def _valid_install_path(key, path):
    if not path or not os.path.exists(path):
        return False
    if key == "cli":
        return os.path.isfile(path)
    if key == "vscode":
        return os.path.isdir(path) and os.path.isfile(os.path.join(path, "package.json"))
    if not os.path.isdir(path):
        return False
    try:
        return any(name.lower().endswith(".exe") and os.path.isfile(os.path.join(path, name))
                   for name in os.listdir(path))
    except OSError:
        return False


def _first_valid(key, paths):
    for p in paths:
        if _valid_install_path(key, p):
            return p
    return ""


def _detect_vscode_extension():
    home = os.path.expanduser("~")
    roots = [
        os.path.join(home, ".vscode", "extensions"),
        os.path.join(home, ".vscode-insiders", "extensions"),
    ]
    for root in roots:
        try:
            for name in sorted(os.listdir(root)):
                candidate = os.path.join(root, name)
                if ("antigravity" in name.lower()
                        and os.path.isfile(os.path.join(candidate, "package.json"))):
                    return candidate
        except OSError:
            continue
    return ""


def detect_install_paths():
    local = os.environ.get("LOCALAPPDATA", "")
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    cli = shutil.which("antigravity") or shutil.which("antigravity-cli") or ""
    return {
        "app": _first_valid("app", [
            os.path.join(local, "Programs", "Antigravity"),
            os.path.join(local, "Programs", "antigravity"),
            os.path.join(program_files, "Antigravity"),
        ]),
        "ide": _first_valid("ide", [
            os.path.join(local, "Programs", "Antigravity IDE"),
            os.path.join(program_files, "Antigravity IDE"),
        ]),
        "cli": cli if _valid_install_path("cli", cli) else "",
        "vscode": _detect_vscode_extension(),
    }


def read_install_overrides():
    try:
        with open(INSTALLS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_install_overrides(data):
    try:
        with open(INSTALLS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ==================== DESKTOP PALETTE ====================
BG = "#F3F4F5"
PANEL = "#FFFFFF"
PANEL_SUBTLE = "#F5F6F7"
PANEL_HOVER = "#E9EDF0"
BORDER = "#D9DEE3"
BORDER_LIGHT = "#697D8D"

TEXT_PRIMARY = "#202A33"
TEXT_MUTED = "#4C5965"
TEXT_DIM = "#596773"

# One restrained accent; color communicates actions or status, not decoration.
ACCENT = "#365F7B"
ACCENT_HOVER = "#294C64"
ACCENT_SUBTLE = "#EAF0F4"
ACCENT_CYAN = ACCENT

SUCCESS = "#276645"
SUCCESS_BG = "#EDF5EF"
SUCCESS_BORDER = "#A7C7B2"

WARNING = "#875800"
WARNING_BG = "#FFF5DF"
WARNING_BORDER = "#D6BB7B"

DANGER = "#A03333"
DANGER_BG = "#FAEEEE"
DANGER_BORDER = "#D8ACAC"

MUTED_BAR = "#DEE3E7"

LIGHT_PALETTE = {
    "BG": "#F3F4F5", "PANEL": "#FFFFFF", "PANEL_SUBTLE": "#F5F6F7",
    "PANEL_HOVER": "#E9EDF0", "BORDER": "#D9DEE3", "BORDER_LIGHT": "#697D8D",
    "TEXT_PRIMARY": "#202A33", "TEXT_MUTED": "#4C5965", "TEXT_DIM": "#596773",
    "ACCENT": "#365F7B", "ACCENT_HOVER": "#294C64", "ACCENT_SUBTLE": "#EAF0F4",
    "SUCCESS": "#276645", "SUCCESS_BG": "#EDF5EF", "SUCCESS_BORDER": "#A7C7B2",
    "WARNING": "#875800", "WARNING_BG": "#FFF5DF", "WARNING_BORDER": "#D6BB7B",
    "DANGER": "#A03333", "DANGER_BG": "#FAEEEE", "DANGER_BORDER": "#D8ACAC",
    "MUTED_BAR": "#DEE3E7",
}
DARK_PALETTE = {
    "BG": "#171A1E", "PANEL": "#20252B", "PANEL_SUBTLE": "#282E35",
    "PANEL_HOVER": "#353D46", "BORDER": "#3B444E", "BORDER_LIGHT": "#9AA9B7",
    "TEXT_PRIMARY": "#E8EDF2", "TEXT_MUTED": "#C0CAD3", "TEXT_DIM": "#9AA7B2",
    "ACCENT": "#6EA6CC", "ACCENT_HOVER": "#568DB4", "ACCENT_SUBTLE": "#293B49",
    "SUCCESS": "#75C995", "SUCCESS_BG": "#253B2E", "SUCCESS_BORDER": "#426B50",
    "WARNING": "#E8BD68", "WARNING_BG": "#403720", "WARNING_BORDER": "#75633A",
    "DANGER": "#EF8B8B", "DANGER_BG": "#402929", "DANGER_BORDER": "#754444",
    "MUTED_BAR": "#414A54",
}


def apply_palette(theme):
    palette = DARK_PALETTE if theme == "dark" else LIGHT_PALETTE
    globals().update(palette)


def set_theme_config(cfg, theme):
    """Persist a normalized theme choice without dropping unrelated settings."""
    cfg["theme"] = "dark" if theme == "dark" else "light"
    return cfg


def action_button(parent, text, command, primary=False, compact=False):
    """Native keyboard-accessible action, with a visible focus indicator."""
    return tk.Button(
        parent, text=text, command=command,
        bg=ACCENT if primary else PANEL,
        fg="#FFFFFF" if primary else TEXT_PRIMARY,
        activebackground=ACCENT_HOVER if primary else PANEL_HOVER,
        activeforeground="#FFFFFF" if primary else TEXT_PRIMARY,
        disabledforeground=TEXT_DIM, relief="flat", bd=0,
        highlightthickness=1, highlightbackground=ACCENT if primary else BORDER,
        highlightcolor=BORDER_LIGHT, takefocus=True, cursor="hand2",
        font=("Segoe UI", 9, "bold" if primary else "normal"),
        padx=10 if compact else 14, pady=4 if compact else 7,
    )


def wrap_to_width(label, inset=0):
    """Keep long diagnostics within their allocated column on resize."""
    label.configure(justify="left", anchor="w")
    label.bind("<Configure>", lambda e: label.configure(wraplength=max(120, e.width - inset)))


def bind_scroll_wheel(owner, canvas):
    """Scroll only the canvas under the pointer, so tabs never scroll each other."""
    def on_wheel(event):
        # Let text inputs and the model list retain their own scrolling.
        if isinstance(event.widget, (tk.Text, tk.Listbox, tk.Entry)):
            return
        try:
            if not canvas.winfo_ismapped():
                return
            px, py = owner.winfo_pointerxy()
            x0, y0 = canvas.winfo_rootx(), canvas.winfo_rooty()
            if not (x0 <= px < x0 + canvas.winfo_width() and y0 <= py < y0 + canvas.winfo_height()):
                return
        except tk.TclError:
            return
        if canvas.bbox("all") and canvas.bbox("all")[3] > canvas.winfo_height():
            direction = -1 if getattr(event, "num", None) == 4 or event.delta > 0 else 1
            canvas.yview_scroll(direction * 3, "units")
            return "break"

    owner.bind("<MouseWheel>", on_wheel, add="+")
    owner.bind("<Button-4>", on_wheel, add="+")
    owner.bind("<Button-5>", on_wheel, add="+")


def configure_notebook_style(note="main"):
    """Dark/light tab strip for ttk.Notebook; re-run after a theme switch."""
    style = ttk.Style()
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    style.configure(f"{note}.TNotebook", background=BG, borderwidth=0, tabmargins=(0, 4, 0, 0))
    style.configure(f"{note}.TNotebook.Tab", background=PANEL_SUBTLE, foreground=TEXT_MUTED,
                    padding=(16, 6), font=("Segoe UI", 9, "bold"))
    style.map(f"{note}.TNotebook.Tab",
              background=[("selected", PANEL), ("active", PANEL_HOVER)],
              foreground=[("selected", ACCENT), ("active", TEXT_PRIMARY)])


def make_notebook_tabs(parent, titles, note="main"):
    configure_notebook_style(note)
    nb = ttk.Notebook(parent, style=f"{note}.TNotebook")
    pages = []
    for title in titles:
        page = tk.Frame(nb, bg=BG)
        nb.add(page, text=title)
        pages.append(page)
    return nb, pages


def split_models(models):
    """Partition /v1/models entries by provider (falls back to the web/ prefix)."""
    cloud, web = [], []
    for m in models or []:
        if not isinstance(m, dict) or not isinstance(m.get("id"), str):
            continue
        provider = m.get("provider")
        is_web = provider == "web" or (provider is None and m["id"].startswith("web/"))
        (web if is_web else cloud).append(m)
    return cloud, web


def format_model_row(model):
    mid = str(model.get("id", ""))
    display = model.get("display_name") or model.get("displayName") or ""
    caps = model.get("capabilities") if isinstance(model.get("capabilities"), dict) else {}
    tags = []
    if caps.get("tools") == "native":
        tags.append("[native tools]")
    elif caps.get("tools") == "emulated":
        tags.append("[VERY unreliable]")
    if caps.get("thinking"):
        tags.append("[thinking]")
    suffix = "  " + " ".join(tags) if tags else ""
    return f"{mid:<36}  —  {display}{suffix}"


CONFIG_FILE = os.path.join(BASE, "config.json")
BACKUP_DIR = os.path.join(BASE, "backups")
CONFIG_BACKUPS_KEEP = 10


def read_config():
    """{} when config.json is absent; None when it exists but cannot be parsed.

    None must never be saved back: an empty dict written over a damaged file
    would drop the API key and the Gemini cookie.
    """
    try:
        with open(CONFIG_FILE, encoding="utf-8-sig") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def config_section(cfg, key):
    value = (cfg or {}).get(key)
    return value if isinstance(value, dict) else {}


def config_port(cfg, default=8317):
    try:
        port = int((cfg or {}).get("port") or default)
    except (TypeError, ValueError):
        return default
    return port if 1 <= port <= 65535 else default


def backup_config():
    """Same scheme as lib/safe_files.js: backups/config.json.<stamp>.bak, newest N kept."""
    try:
        with open(CONFIG_FILE, "rb") as f:
            data = f.read()
    except OSError:
        return None
    os.makedirs(BACKUP_DIR, exist_ok=True)
    prefix = os.path.basename(CONFIG_FILE) + "."
    existing = sorted((n for n in os.listdir(BACKUP_DIR)
                       if n.startswith(prefix) and n.endswith(".bak")), reverse=True)
    if existing:
        try:
            with open(os.path.join(BACKUP_DIR, existing[0]), "rb") as f:
                if f.read() == data:
                    return os.path.join(BACKUP_DIR, existing[0])
        except OSError:
            pass
    now = datetime.now()
    base = f"{prefix}{now:%Y%m%d-%H%M%S}-{now.microsecond // 1000:03d}"
    dest = os.path.join(BACKUP_DIR, base + ".bak")
    i = 1
    while os.path.exists(dest):
        dest = os.path.join(BACKUP_DIR, f"{base}_{i:03d}.bak")
        i += 1
    with open(dest, "wb") as f:
        f.write(data)
    for old in existing[max(0, CONFIG_BACKUPS_KEEP - 1):]:
        try:
            os.remove(os.path.join(BACKUP_DIR, old))
        except OSError:
            pass
    return dest


def save_config(cfg):
    if not isinstance(cfg, dict):
        return False
    try:
        backup_config()
    except Exception:
        pass
    tmp = os.path.join(BASE, f".config.json.{os.getpid()}.tmp")
    try:
        text = json.dumps(cfg, indent=2, ensure_ascii=False)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        # The server may be reading the file at this moment (Windows locks it briefly).
        for attempt in range(6):
            try:
                os.replace(tmp, CONFIG_FILE)
                return True
            except PermissionError:
                time.sleep(0.015 * (attempt + 1))
        # Still locked (antivirus, editor): a direct write beats losing the change.
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            f.write(text)
        return True
    except Exception:
        return False
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def read_api_key():
    try:
        with open(os.path.join(BASE, "apikey.txt"), encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


CFG = read_config() or {}
PORT = config_port(CFG)
BASE_URL = f"http://127.0.0.1:{PORT}/v1"
API_KEY = read_api_key()

CONFIG_DAMAGED_MSG = (
    "config.json повреждён или недоступен — не перезаписываю его, чтобы не потерять API-ключ и cookie. "
    "При запуске сервер попробует восстановить его из папки backups/; либо исправьте файл вручную.",
    "config.json is damaged or unreadable — not overwriting it, so the API key and cookie are kept. "
    "On start the server tries to restore it from backups/; or fix the file manually.",
)


def http_get(path, timeout=2.0, with_key=False):
    headers = {}
    if with_key and API_KEY:
        headers["Authorization"] = "Bearer " + API_KEY
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def http_post(path, data, timeout=3.0, with_key=False):
    headers = {"Content-Type": "application/json"}
    if with_key and API_KEY:
        headers["Authorization"] = "Bearer " + API_KEY
    payload = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def find_node():
    node = shutil.which("node")
    if node:
        return node
    for p in (r"C:\Program Files\nodejs\node.exe", os.path.expandvars(r"%LOCALAPPDATA%\Programs\nodejs\node.exe")):
        if os.path.exists(p):
            return p
    return None


def _windows_oem_codepage():
    """Текущая кодовая страница консоли (866 на русской Windows) для OEM-вывода netstat/taskkill."""
    try:
        import ctypes
        cp = ctypes.windll.kernel32.GetConsoleOutputCP()
        return "cp%d" % cp if cp else "cp866"
    except Exception:
        return "cp866"


def _decode_console(data):
    """netstat печатает в OEM-кодировке; text=True отдаёт mojibake и ломает разбор адресов."""
    if isinstance(data, bytes):
        for enc in (_windows_oem_codepage() if sys.platform == "win32" else None, "utf-8", "cp1251"):
            if not enc:
                continue
            try:
                return data.decode(enc)
            except (UnicodeDecodeError, LookupError):
                continue
        return data.decode("utf-8", "replace")
    return data


def pid_on_port(port=None):
    port = PORT if port is None else port
    if sys.platform == "win32":
        try:
            res = subprocess.run(["netstat", "-ano"], capture_output=True, timeout=10)
            out = _decode_console(res.stdout)
            for line in out.splitlines():
                cols = line.split()
                # Формат: Протокол  Локальный адрес  Внешний адрес  Состояние  PID
                if len(cols) < 4 or "LISTENING" not in line.upper():
                    continue
                local = cols[1]
                if local.rsplit(":", 1)[-1] != str(port):
                    continue
                if cols[-1].isdigit():
                    return int(cols[-1])
        except Exception:
            pass
    else:
        try:
            out = subprocess.run(["lsof", f"-ti:{port}"], capture_output=True, text=True, timeout=5).stdout.strip()
            if out:
                first = out.split()[0]
                if first.isdigit():
                    return int(first)
        except Exception:
            pass
    return None


def process_command_line(pid):
    """Командная строка процесса — нужна, чтобы не убить чужой сервер на нашем порту."""
    try:
        if sys.platform == "win32":
            res = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "(Get-CimInstance Win32_Process -Filter 'ProcessId=%d').CommandLine" % int(pid)],
                capture_output=True, timeout=10,
            )
            return _decode_console(res.stdout).strip()
        with open("/proc/%d/cmdline" % int(pid), "rb") as fh:
            return fh.read().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
    except Exception:
        return ""


def is_our_server(pid):
    """Наш ли процесс занимает порт: сверяем командную строку с путём проекта."""
    if not pid:
        return False
    cmd = process_command_line(pid).replace("\\", "/").lower()
    if not cmd or "server.js" not in cmd:
        return False
    base = os.path.abspath(BASE).replace("\\", "/").lower()
    return base in cmd


def is_running():
    try:
        http_get("/_health", timeout=1.2)
        return True
    except Exception:
        return False


def format_reset_time(iso_str):
    if not iso_str:
        return ""
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        diff = dt - now
        total_seconds = int(diff.total_seconds())
        if total_seconds <= 0:
            return T("Обновляется сейчас", "Refreshing now")
        days = total_seconds // 86400
        hours = (total_seconds % 86400) // 3600
        mins = (total_seconds % 3600) // 60
        if days > 0:
            return T(f"Сброс через {days}д {hours}ч", f"Resets in {days}d {hours}h")
        elif hours > 0:
            return T(f"Сброс через {hours}ч {mins}м", f"Resets in {hours}h {mins}m")
        else:
            return T(f"Сброс через {mins}м", f"Resets in {mins}m")
    except Exception:
        return str(iso_str)


# ==================== DIAGNOSTIC CHAT ====================


def diagnostic_safe_text(value):
    """Defense in depth: never render configured credentials or credential headers."""
    text = str(value)
    secrets = [API_KEY, read_api_key()]

    def collect(data):
        if isinstance(data, dict):
            for key, item in data.items():
                if re.search(r"key|token|cookie|password|secret", key, re.I) and isinstance(item, str):
                    secrets.append(item)
                    if "cookie" in key.lower():
                        secrets.extend(part.split("=", 1)[-1].strip() for part in item.split(";"))
                elif isinstance(item, (dict, list)):
                    collect(item)
        elif isinstance(data, list):
            for item in data:
                collect(item)

    collect(read_config() or {})
    for secret in sorted({s for s in secrets if isinstance(s, str) and len(s) >= 4}, key=len, reverse=True):
        text = text.replace(secret, T("[скрыто]", "[hidden]"))
    text = re.sub(r"(?im)\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*",
                  T("[секретный заголовок скрыт]", "[secret header hidden]"), text)
    text = re.sub(r"(?i)\bBearer\s+\S+|\b(?:sk-|AIza|ya29\.)[A-Za-z0-9_.-]+", T("[скрыто]", "[hidden]"), text)
    text = re.sub(r"(?i)\b[\w-]*(?:token|secret|password|api[_-]?key|sapisid)[\w-]*[\"']?\s*[:=]\s*[\"']?[^\s;,\"'}]+",
                  T("[секрет скрыт]", "[secret hidden]"), text)
    return text


def diagnostic_request(path, payload=None):
    """Retain structured HTTP failures, but never expose raw response bodies."""
    def failure(code, message, stage="response", details=None):
        return {"ok": False, "error": {"code": code, "message": message,
                                     "stage": stage, "details": details}}
    try:
        if payload is None:
            return http_get(path, timeout=30, with_key=True)
        return http_post(path, payload, timeout=180, with_key=True)
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read().decode("utf-8"))
            if isinstance(data, dict) and data.get("ok") is False and isinstance(data.get("error"), dict):
                return data
        except (ValueError, UnicodeError, OSError):
            pass
        explanations = {
            401: T("Сервер отклонил авторизацию. Проверьте локальный API-ключ и перезапустите приложение после его изменения.",
                   "The server rejected authorization. Check the local API key and restart the app after changing it."),
            403: T("Доступ запрещён. Проверьте настройки доступа сервера и авторизацию аккаунта.",
                   "Access denied. Check the server access settings and account authorization."),
            404: T("Маршрут диагностики не найден. Перезапустите API-сервер с обновлённой версией приложения.",
                   "Diagnostic route not found. Restart the API server with an updated app version."),
            429: T("Превышен лимит запросов. Подождите и проверьте квоты аккаунта и локальные ограничения.",
                   "Rate limit exceeded. Wait and check account quotas and local limits."),
        }
        return failure("http_error", explanations.get(exc.code,
                       T("Сервер вернул ошибку без диагностического JSON. Проверьте доступность API-сервера и его версию.",
                         "The server returned an error without diagnostic JSON. Check that the API server is available and up to date.")),
                       "auth" if exc.code in (401, 403) else "response", {"httpStatus": exc.code})
    except (TimeoutError, socket.timeout):
        return failure("client_timeout",
                       T("Время ожидания истекло. Проверьте соединение и состояние API/веб-моста. "
                         "Сервер мог продолжить обработку; автоматического повтора нет.",
                         "Timed out. Check the connection and the API/web bridge state. "
                         "The server may still be processing; there is no automatic retry."),
                       "upstream")
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            return failure("client_timeout",
                           T("Сервер не ответил вовремя. Проверьте соединение; запрос автоматически не повторяется.",
                             "The server did not respond in time. Check the connection; the request is not retried automatically."),
                           "upstream")
        return failure("server_unavailable",
                       T(f"Не удалось подключиться к локальному серверу на порту {PORT}. Нажмите Start API Server и повторите проверку.",
                         f"Could not connect to the local server on port {PORT}. Press Start API Server and retry."),
                       "routing")
    except (ValueError, UnicodeError):
        return failure("invalid_json",
                       T("Сервер вернул некорректный JSON. Проверьте, что на порту приложения работает актуальный API-сервер.",
                         "The server returned invalid JSON. Make sure the current API server is running on the app port."))
    except (ConnectionError, http.client.HTTPException) as exc:
        # RemoteDisconnected / ConnectionResetError / BadStatusLine не наследуются
        # от URLError и раньше вылетали наружу, оставляя диалог без ответа.
        return failure("server_disconnected",
                       T(f"Сервер прервал соединение ({type(exc).__name__}). Проверьте, что API-сервер работает, и повторите проверку.",
                         f"The server dropped the connection ({type(exc).__name__}). Make sure the API server is running and retry."),
                       "routing")


class DiagnosticChatDialog(tk.Toplevel):
    """Independent one-message probes; history is display-only, never sent upstream.

    Tk has no CSS. The requested .diagnostic-* names are exposed as bindtags
    (and Text tags for messages), preserving native controls and the app palette.
    """

    def __init__(self, parent):
        super().__init__(parent, name="diagnostic-chat", class_="DiagnosticChat")
        self.bindtags(self.bindtags() + (".diagnostic-chat",))
        self.title(T("Диагностический чат · API / Web Bridge", "Diagnostic Chat · API / Web Bridge"))
        self.configure(bg=BG)
        self.geometry(f"760x{min(720, max(480, self.winfo_screenheight() - 90))}")
        self.minsize(560, 440)
        self.transient(parent)
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._busy = False
        self._loading = False
        self._wait_started = 0
        self._wait_tick = 0
        self._wait_after = None
        self.model = tk.StringVar()
        self.bridge = tk.StringVar(value="auto")  # маршрут задаёт модель; поле bridge в API остаётся
        tk.Label(self, text=T("Диагностический чат", "Diagnostic Chat"), bg=BG, fg=TEXT_PRIMARY,
                 font=("Segoe UI", 14, "bold"), anchor="w").pack(fill="x", padx=18, pady=(16, 6))
        hint = tk.Label(self, text=T("Каждая отправка — отдельная проверка без истории. Путь (API или веб-мост) задаёт выбранная модель. Не отправляйте ключи, токены или cookies.",
                                     "Each send is an independent probe with no history. The chosen model decides the route (API or web bridge). Never send keys, tokens or cookies."),
                        bg=BG, fg=TEXT_MUTED, font=("Segoe UI", 9))
        hint.pack(fill="x", padx=18, pady=(0, 10))
        wrap_to_width(hint)
        # Веб-модели отвечают через браузерный протокол Google: мышление модели
        # занимает десятки секунд, и это не задержка локального сервера.
        web_note = tk.Label(self, text=T("Модели через веб-мост думают долго: 10–30 с на короткий вопрос, "
                                         "на сложных задачах — дольше (у максимального мышления дольше всего). "
                                         "Это время генерации Gemini, а не зависание. Дождитесь ответа.",
                                         "Web-bridge models think slowly: 10–30 s for a short question and longer "
                                         "for complex ones (maximum-thinking is the slowest). This is Gemini's "
                                         "generation time, not a freeze. Please wait for the answer."),
                            bg=WARNING_BG, fg=WARNING, font=("Segoe UI", 9), justify="left",
                            anchor="w", wraplength=680, padx=10, pady=7,
                            highlightthickness=1, highlightbackground=WARNING_BORDER)
        web_note.pack(fill="x", padx=18, pady=(0, 10))
        wrap_to_width(web_note, inset=20)
        controls = tk.Frame(self, bg=BG)
        controls.pack(fill="x", padx=18, pady=(0, 10))
        controls.columnconfigure(1, weight=1)
        tk.Label(controls, text=T("Модель", "Model"), bg=BG, fg=TEXT_PRIMARY).grid(row=0, column=0, sticky="w", padx=(0, 8))
        self.model_menu = tk.OptionMenu(controls, self.model, "")
        self.model_menu.configure(bg=PANEL, fg=TEXT_PRIMARY, highlightthickness=1, highlightbackground=BORDER)
        self.model_menu.grid(row=0, column=1, sticky="ew")
        self.refresh_button = action_button(controls, T("Обновить модели", "Refresh models"), self.load_models, compact=True)
        self.refresh_button.grid(row=0, column=2, padx=(8, 0))
        footer = tk.Frame(self, bg=BG)
        footer.pack(side="bottom", fill="x", padx=18, pady=(8, 16))
        wait_row = tk.Frame(footer, bg=BG)
        wait_row.pack(fill="x", pady=(0, 6))
        self.wait_label = tk.Label(wait_row, text="", bg=BG, fg=ACCENT, font=("Segoe UI", 9, "bold"))
        self.wait_label.pack(side="left")
        # Анимация ожидания: бегущие точки + прошедшие секунды, чтобы долгий
        # ответ веб-модели не выглядел как зависшее окно.
        self.wait_dots = tk.Label(wait_row, text="", bg=BG, fg=ACCENT, font=("Segoe UI", 10, "bold"), width=6, anchor="w")
        self.wait_dots.pack(side="left", padx=(6, 0))
        self.wait_progress = tk.Canvas(wait_row, height=6, bg=BG, highlightthickness=0, bd=0)
        self.wait_progress.pack(side="left", fill="x", expand=True, padx=(10, 0))
        self.status = tk.Label(footer, text="", bg=BG, fg=TEXT_MUTED, font=("Segoe UI", 9))
        self.status.pack(fill="x", pady=(0, 6))
        wrap_to_width(self.status)
        self.input = tk.Text(footer, name="diagnostic-input", height=3, wrap="word", bg=PANEL,
                             fg=TEXT_PRIMARY, insertbackground=ACCENT, font=("Segoe UI", 10),
                             relief="flat", highlightthickness=1, highlightbackground=BORDER)
        self.input.bindtags(self.input.bindtags() + (".diagnostic-input",))
        self.input.pack(fill="x")
        self.input.bind("<Control-Return>", self.send)
        self.send_button = action_button(footer, T("Отправить · Ctrl+Enter", "Send · Ctrl+Enter"), self.send, primary=True)
        self.send_button.bindtags(self.send_button.bindtags() + (".diagnostic-send",))
        self.send_button.pack(anchor="e", pady=(8, 0))
        history = tk.Frame(self, bg=BG)
        history.pack(fill="both", expand=True, padx=18)
        self.messages = tk.Text(history, name="diagnostic-message", wrap="word", state="disabled",
                                bg=PANEL, fg=TEXT_PRIMARY, font=("Segoe UI", 10), relief="flat",
                                padx=12, pady=12, highlightthickness=1, highlightbackground=BORDER)
        self.messages.bindtags(self.messages.bindtags() + (".diagnostic-message", ".diagnostic-error"))
        self.messages.tag_configure(".diagnostic-message", spacing1=8, spacing3=8)
        self.messages.tag_configure(".diagnostic-error", foreground=DANGER)
        self.messages.tag_configure("heading", font=("Segoe UI", 10, "bold"))
        scrollbar = tk.Scrollbar(history, command=self.messages.yview)
        self.messages.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        self.messages.pack(side="left", fill="both", expand=True)
        self.load_models()
        self.input.focus_set()

    def _wait_step(self):
        """Тик анимации ожидания: точки, секунды и полоса прогресса."""
        if not self._busy or not self.winfo_exists():
            return
        self._wait_tick += 1
        elapsed = max(0.0, time.monotonic() - self._wait_started)
        self.wait_dots.configure(text="." * (1 + self._wait_tick % 3))
        self.wait_label.configure(text=T(f"Ждём ответ модели · {elapsed:0.0f} с",
                                         f"Waiting for the model · {elapsed:0.0f} s"))
        # Полоса не обещает конкретного времени: за ~40 с доходит до 80% и дальше ползёт.
        ratio = min(0.8, elapsed / 50.0)
        width = max(1, self.wait_progress.winfo_width())
        for item in self.wait_progress.find_all():
            self.wait_progress.delete(item)
        self.wait_progress.create_rectangle(0, 2, width * ratio, 5, fill=ACCENT, outline="")
        # После минуты текст ответа может идти ещё долго: меняем подсказку.
        if elapsed >= 60 and not getattr(self, "_wait_long_shown", False):
            self._wait_long_shown = True
            self.status.configure(
                text=T("Веб-модели могут думать дольше минуты — сервер продолжает работу, ответ появится здесь.",
                       "Web models can think for more than a minute — the server is still working; the answer will appear here."),
                fg=TEXT_MUTED)
        self._wait_after = self.after(250, self._wait_step)

    def _start_waiting(self):
        self._wait_started = time.monotonic()
        self._wait_tick = 0
        self._wait_long_shown = False
        self.wait_progress.update_idletasks()
        if self._wait_after:
            self.after_cancel(self._wait_after)
        self._wait_step()

    def _stop_waiting(self):
        if self._wait_after:
            try:
                self.after_cancel(self._wait_after)
            except Exception:
                pass
            self._wait_after = None
        try:
            self.wait_label.configure(text="")
            self.wait_dots.configure(text="")
            for item in self.wait_progress.find_all():
                self.wait_progress.delete(item)
        except Exception:
            pass

    def _cancel_wait_on_close(self):
        self._busy = False
        self._stop_waiting()

    def _on_close(self):
        """Закрытие окна останавливает анимацию: иначе after-тики пишут в мёртвые виджеты."""
        self._cancel_wait_on_close()
        try:
            self.destroy()
        except Exception:
            pass

    def append(self, role, text, error=False):
        self.messages.configure(state="normal")
        self.messages.insert("end", role + "\n", ("heading",))
        tags = (".diagnostic-message", ".diagnostic-error") if error else (".diagnostic-message",)
        self.messages.insert("end", diagnostic_safe_text(text) + "\n\n", tags)
        self.messages.configure(state="disabled")
        self.messages.see("end")

    def show_error(self, error):
        stages_ru = {"validation": "проверка ввода", "auth": "авторизация", "routing": "маршрутизация",
                     "upstream": "запрос к провайдеру", "response": "обработка ответа"}
        stages_en = {"validation": "input validation", "auth": "authorization", "routing": "routing",
                     "upstream": "provider request", "response": "response processing"}
        stages = stages_en if UI_LANG == "en" else stages_ru
        fallback_stage = T("обработка ответа", "response processing")
        message = error.get("message")
        if not isinstance(message, str) or not message.strip():
            message = T("Сервер не сообщил причину ошибки. Проверьте его версию и параметры подключения.",
                        "The server did not report a reason. Check its version and connection settings.")
        stage = error.get("stage", "response")
        if not isinstance(stage, str):
            stage = "response"
        code = error.get("code")
        if not isinstance(code, str):
            code = "unknown"
        text = T(f"{message}\nЭтап: {stages.get(stage, fallback_stage)} · Код: {code}",
                 f"{message}\nStage: {stages.get(stage, fallback_stage)} · Code: {code}")
        details = error.get("details")
        # Do not dump arbitrary upstream/configuration objects into the chat.
        if isinstance(details, dict):
            safe = {k: v for k, v in details.items()
                    if k in ("httpStatus", "upstreamStatus", "bridge", "model", "retryAfterMs")
                    and isinstance(v, (str, int, float, bool))}
            if safe:
                text += T("\nПодробности: ", "\nDetails: ") + json.dumps(safe, ensure_ascii=False)
        self.append(T("Ошибка проверки", "Check failed"), text, error=True)
        self.status.configure(text=T("Проверка не завершена. Причина указана в чате.",
                                     "The check did not complete. The reason is shown in the chat."), fg=DANGER)

    def load_models(self):
        if self._loading or self._busy:
            return
        self._loading = True
        self.refresh_button.configure(state="disabled")
        self.send_button.configure(state="disabled")
        self.status.configure(text=T("Загружаем модели из /v1/models…", "Loading models from /v1/models…"), fg=TEXT_MUTED)
        self.master._call_async(lambda: diagnostic_request("/v1/models"), self.models_loaded)

    def models_loaded(self, result):
        if not self.winfo_exists():
            return
        self._loading = False
        self.refresh_button.configure(state="normal")
        self.send_button.configure(state="normal")
        data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(data, list):
            error = result.get("error") if isinstance(result, dict) else None
            self.show_error(error if isinstance(error, dict) else {
                "message": T("Не удалось загрузить каталог моделей. Проверьте сервер и авторизацию, затем нажмите «Обновить модели».",
                             "Failed to load the model catalog. Check the server and authorization, then press “Refresh models”."),
                "code": "model_catalog_unavailable", "stage": "routing"})
            return
        ids = list(dict.fromkeys(m["id"] for m in data if isinstance(m, dict) and isinstance(m.get("id"), str) and m["id"]))
        menu = self.model_menu["menu"]
        menu.delete(0, "end")
        for model in ids:
            menu.add_command(label=diagnostic_safe_text(model), command=tk._setit(self.model, model))
        if self.model.get() not in ids:
            self.model.set(ids[0] if ids else "")
        self.model_menu.configure(state="normal" if ids else "disabled")
        self.status.configure(
            text=T(f"Моделей: {len(ids)}. Введите сообщение для проверки.",
                   f"Models: {len(ids)}. Type a message to run the check.")
            if ids else
            T("Каталог пуст. Проверьте подключение аккаунта и настройки веб-моста.",
              "The catalog is empty. Check the account connection and web-bridge settings."),
            fg=TEXT_MUTED if ids else WARNING)

    def send(self, event=None):
        if self._busy or self._loading:
            return "break"
        message = self.input.get("1.0", "end").strip()
        model = self.model.get()
        if not message or not model:
            self.show_error({"code": "invalid_input", "stage": "validation",
                             "message": T("Введите непустое сообщение и выберите модель из каталога. Если моделей нет, нажмите «Обновить модели».",
                                          "Enter a non-empty message and pick a model from the catalog. If there are no models, press “Refresh models”.")})
            return "break"
        payload = {"model": model, "message": message, "bridge": self.bridge.get()}
        self.append(T("Вы", "You"), message)
        self.input.delete("1.0", "end")
        self._busy = True
        for widget in (self.send_button, self.refresh_button, self.model_menu):
            widget.configure(state="disabled")
        self.status.configure(text=T("Проверяем выбранный маршрут… Ожидание до 180 с; автоматического повтора нет.",
                                     "Checking the selected route… Up to 180 s; no automatic retry."), fg=TEXT_MUTED)
        self._start_waiting()
        self.master._call_async(lambda: diagnostic_request("/api/diagnostics/chat", payload), self.completed)
        return "break"

    def completed(self, result):
        if not self.winfo_exists():
            return
        self._busy = False
        self._stop_waiting()
        for widget in (self.send_button, self.refresh_button, self.model_menu):
            widget.configure(state="normal")
        if isinstance(result, dict) and result.get("ok") is True and isinstance(result.get("response"), str) and result["response"].strip():
            self.append(T("Ответ модели", "Model response"), result["response"])
            diag = result.get("diagnostics")
            if not isinstance(diag, dict):
                diag = {}
            actual = diag.get("bridge") if diag.get("bridge") in ("api", "web") else T("не указан", "not specified")
            duration = diag.get("durationMs")
            elapsed = T(f" · {duration:.0f} мс", f" · {duration:.0f} ms") if isinstance(duration, (int, float)) else ""
            self.status.configure(
                text=diagnostic_safe_text(T(f"Модель: {diag.get('model', self.model.get())} · Маршрут: {actual}{elapsed}",
                                            f"Model: {diag.get('model', self.model.get())} · Route: {actual}{elapsed}")),
                fg=SUCCESS)
        else:
            error = result.get("error") if isinstance(result, dict) else None
            self.show_error(error if isinstance(error, dict) else {
                "code": "invalid_response", "stage": "response",
                "message": T("Не получен корректный текст ответа. Проверьте состояние API/веб-моста и версию сервера.",
                             "No valid response text received. Check the API/web bridge state and server version.")})


# ==================== SETTINGS DIALOG (OPTIONAL LIMITS & GUARD) ====================

class SettingsDialog(tk.Toplevel):
    """In-app configuration dialog for optional rate limits and Safe Mode guard."""

    def __init__(self, parent, on_saved=None, last_result=None):
        super().__init__(parent)
        self.title(T("Настройки и лимиты", "Settings & Optional Guard Limits"))
        self.configure(bg=BG)
        try:
            max_h = max(560, self.winfo_screenheight() - 90)
        except Exception:
            max_h = 700
        self.geometry(f"660x{min(820, max_h)}")
        self.minsize(600, min(560, max_h))
        self.transient(parent)
        self.grab_set()
        self.on_saved = on_saved
        self.last_result = last_result or {}

        if os.path.exists(ICO_PATH):
            try:
                self.iconbitmap(ICO_PATH)
            except Exception:
                pass

        self._cfg = read_config() or {}
        self._safe = config_section(self._cfg, "safeMode")
        self._web = config_section(self._cfg, "geminiWeb")
        self._agent = config_section(self._cfg, "agent")
        self._build_ui()

    def _build_ui(self):
        # Header
        head = tk.Frame(self, bg=BG)
        head.pack(fill="x", padx=20, pady=(18, 10))

        tk.Label(head, text=T("Настройки и лимиты", "Settings & Limits"), bg=BG, fg=TEXT_PRIMARY,
                 font=("Segoe UI", 14, "bold")).pack(side="left")

        sub = tk.Label(self, text=T("Параметры подключения и необязательные локальные лимиты. Изменения сохраняются в config.json.",
                                    "Connection options and optional local rate limits. Changes are saved to config.json."),
                       bg=BG, fg=TEXT_MUTED, font=("Segoe UI", 9), justify="left")
        sub.pack(fill="x", padx=20, pady=(0, 12))
        wrap_to_width(sub)

        # Reserve the footer first so Save/Cancel remain visible at any height.
        foot = tk.Frame(self, bg=BG)
        foot.pack(side="bottom", fill="x", padx=20, pady=(8, 16))
        self.status_lbl = tk.Label(foot, text="", bg=BG, fg=SUCCESS, font=("Segoe UI", 9))
        self.status_lbl.pack(fill="x", pady=(0, 8))
        wrap_to_width(self.status_lbl)
        buttons = tk.Frame(foot, bg=BG)
        buttons.pack(fill="x")
        self.btn_save = action_button(buttons, T("Сохранить и применить", "Save & Apply"), self._save, primary=True)
        self.btn_save.pack(side="right")
        action_button(buttons, T("Отмена", "Cancel"), self.destroy).pack(side="right", padx=(0, 8))
        self.bind("<Escape>", lambda e: self.destroy())

        # Provider-separated settings: cloud quota guard, web bridge, agent, network, usage.
        self.tabs, (cloud_tab, web_tab, agent_tab, net_tab, usage_tab) = make_notebook_tabs(
            self, [T("Cloud Code", "Cloud"), "Gemini Web", T("Агент", "Agent"),
                   T("Сеть", "Network"), T("Расход", "Usage")], note="settings")
        self.tabs.pack(fill="both", expand=True, padx=(20, 10), pady=(0, 4))
        form_root = self._tab_scrollable(cloud_tab)
        web_root = self._tab_scrollable(web_tab)
        agent_root = self._tab_scrollable(agent_tab)
        net_root = self._tab_scrollable(net_tab)
        usage_root = self._tab_scrollable(usage_tab)

        # 1. Safe Mode Guard Toggle Card
        guard_card = tk.Frame(form_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        guard_card.pack(fill="x", pady=(0, 12))

        cb_frame = tk.Frame(guard_card, bg=PANEL)
        cb_frame.pack(fill="x", padx=14, pady=12)

        self.var_enabled = tk.BooleanVar(value=self._safe.get("enabled", False))
        cb = tk.Checkbutton(cb_frame, text=T("Включить локальный лимит и защиту Safe Mode (необязательно)",
                                             "Enable Local Rate Limit & Safe Mode Guard (Optional)"),
                            variable=self.var_enabled, bg=PANEL, fg=TEXT_PRIMARY,
                            selectcolor=PANEL_SUBTLE, activebackground=PANEL,
                            activeforeground=TEXT_PRIMARY, highlightthickness=0,
                            font=("Segoe UI", 9, "bold"))
        cb.pack(anchor="w")

        hint = tk.Label(cb_frame, text=T("Когда выключено (рекомендуется), запросы идут напрямую в Google без искусственных локальных 429 и суточных отсечек токенов. Включайте, только если нужно искусственно ограничить расход через локальный прокси.",
                                         "When disabled (recommended), requests are handled directly by Google's backend without artificial local 429 lockouts or daily token cutoffs. Enable this only if you want your local proxy to artificially cap usage."),
                        bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), wraplength=480, justify="left")
        hint.pack(anchor="w", pady=(4, 0))

        # 2. Limit Parameters Card
        lim_card = tk.Frame(form_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        lim_card.pack(fill="x", pady=(0, 12))

        l_head = tk.Frame(lim_card, bg=PANEL)
        l_head.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(l_head, text=T("ПАРАМЕТРЫ ЗАЩИТЫ (ДЕЙСТВУЮТ ПРИ ВКЛЮЧЁННОЙ ЗАЩИТЕ)",
                                "GUARD PARAMETERS (ACTIVE WHEN GUARD IS ENABLED)"),
                 bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 8, "bold")).pack(side="left")

        sep = tk.Frame(lim_card, bg=BORDER, height=1)
        sep.pack(fill="x", padx=14, pady=(0, 10))

        self.entries = {}
        fields = [
            ("maxRequestsPerMinute", T("Макс. запросов в минуту (RPM)", "Max Requests / Minute (RPM)"),
             str(self._safe.get("maxRequestsPerMinute", 60)), T("Ограничивает частоту запросов", "Limits burst request frequency")),
            ("maxRequestsPerHour", T("Макс. запросов в час", "Max Requests / Hour"),
             str(self._safe.get("maxRequestsPerHour", 600)), T("Ограничивает почасовой объём генерации", "Caps hourly generation volume")),
            ("maxRequestsPerDay", T("Макс. запросов в день", "Max Requests / Day"),
             str(self._safe.get("maxRequestsPerDay", 3000)), T("Суточный потолок запросов (сброс в 00:00 UTC)", "Daily request ceiling (resets at 00:00 UTC)")),
            ("maxTokensPerDay", T("Макс. токенов в день", "Max Tokens / Day"),
             str(self._safe.get("maxTokensPerDay", 50000000)), T("Суточный потолок токенов", "Daily token volume ceiling")),
            ("minIntervalMs", T("Мин. интервал между запросами (мс)", "Min Interval Between Requests (ms)"),
             str(self._safe.get("minIntervalMs", 200)), T("Минимальная пауза между запросами против всплесков", "Minimum pause between requests to prevent bot spikes")),
            ("maxConcurrent", T("Макс. параллельных запросов", "Max Concurrent Requests"),
             str(self._safe.get("maxConcurrent", 4)), T("Лимит одновременных запросов", "Parallel request concurrency limit")),
        ]

        form_fields = tk.Frame(lim_card, bg=PANEL)
        form_fields.pack(fill="x", padx=14, pady=(0, 12))

        for key, label, val, desc in fields:
            row = tk.Frame(form_fields, bg=PANEL)
            row.pack(fill="x", pady=4)

            lbl_box = tk.Frame(row, bg=PANEL)
            lbl_box.pack(side="left", fill="x", expand=True)

            tk.Label(lbl_box, text=label, bg=PANEL, fg=TEXT_PRIMARY,
                     font=("Segoe UI", 9, "bold")).pack(anchor="w")
            tk.Label(lbl_box, text=desc, bg=PANEL, fg=TEXT_DIM,
                     font=("Segoe UI", 8)).pack(anchor="w")

            var = tk.StringVar(value=val)
            e = tk.Entry(row, textvariable=var, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                         relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                         width=12, justify="right", highlightbackground=BORDER, highlightthickness=1)
            e.pack(side="right", ipady=3)
            self.entries[key] = var

        # 2.5 Gemini 4 Unlock (Web Bridge) Card
        unlock_card = tk.Frame(web_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        unlock_card.pack(fill="x", pady=(0, 12))

        u_head = tk.Frame(unlock_card, bg=PANEL)
        u_head.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(u_head, text=T("GEMINI 4 UNLOCK (ВЕБ-МОСТ)", "GEMINI 4 UNLOCK (WEB BRIDGE)"), bg=PANEL, fg=ACCENT_CYAN,
                 font=("Segoe UI", 8, "bold")).pack(side="left")
        tk.Label(u_head, text=T("шлюз gemini.google.com", "gemini.google.com gateway"), bg=PANEL, fg=TEXT_DIM,
                 font=("Segoe UI", 8)).pack(side="left", padx=(8, 0))

        usep = tk.Frame(unlock_card, bg=BORDER, height=1)
        usep.pack(fill="x", padx=14, pady=(0, 10))

        u_body = tk.Frame(unlock_card, bg=PANEL)
        u_body.pack(fill="x", padx=14, pady=(0, 10))

        self.var_web_enabled = tk.BooleanVar(value=bool(self._web.get("enabled", True)))
        tk.Checkbutton(u_body, text=T("Включить Gemini 4 через Gemini Web (модели: gemini-4-argon, gemini-4, -pro, -thinking)",
                                      "Enable Gemini 4 via Gemini Web (models: gemini-4-argon, gemini-4, -pro, -thinking)"),
                       variable=self.var_web_enabled, bg=PANEL, fg=TEXT_PRIMARY,
                       selectcolor=PANEL_SUBTLE, activebackground=PANEL,
                       activeforeground=TEXT_PRIMARY, highlightthickness=0, wraplength=480, justify="left",
                       font=("Segoe UI", 9, "bold")).pack(anchor="w", fill="x")

        tk.Label(u_body, text=T("Google-cookie (сырой заголовок или путь к cookie.txt). Нужен для Gemini 4 Pro — "
                                "скопируйте из авторизованной сессии gemini.google.com (должен содержать SAPISID).",
                                "Google cookie (raw header or path to cookie.txt). Required for Gemini 4 Pro — "
                                "copied from an authenticated gemini.google.com session (must contain SAPISID)."),
                 bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), wraplength=480, justify="left").pack(anchor="w", pady=(4, 2))

        self.web_cookie_text = tk.Text(u_body, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY, relief="flat",
                                       height=4, font=("Consolas", 8), insertbackground=ACCENT,
                                       wrap="char", highlightbackground=BORDER, highlightthickness=1)
        self.web_cookie_text.pack(fill="x", pady=(0, 6))
        saved_cookie = str(self._web.get("cookie", "") or self._web.get("cookie_file", "") or "")
        self.web_cookie_text.insert("1.0", saved_cookie)

        btn_row = tk.Frame(u_body, bg=PANEL)
        btn_row.pack(fill="x", pady=(0, 4))
        self.btn_signin = action_button(btn_row, T("Войти в браузер", "Sign in to browser"),
                                        self.open_gemini_signin, compact=True)
        self.btn_signin.pack(side="left")
        action_button(btn_row, T("Вставить из буфера", "Paste from clipboard"), self.paste_cookie_from_clipboard,
                      compact=True).pack(side="left", padx=(8, 0))
        tk.Label(u_body, text=T("«Войти в браузер» открывает gemini.google.com в браузере по умолчанию. "
                                "Войдите в аккаунт, скопируйте заголовок Cookie (F12 → Network) и вставьте его "
                                "кнопкой «Вставить из буфера».",
                                "“Sign in to browser” opens gemini.google.com in your default browser. "
                                "Sign in, copy the Cookie header (F12 → Network) and paste it with "
                                "“Paste from clipboard”."),
                 bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), wraplength=480,
                 justify="left").pack(anchor="w", pady=(0, 2))

        row_web = tk.Frame(u_body, bg=PANEL)
        row_web.pack(fill="x", pady=(0, 4))

        tk.Label(row_web, text=T("Прокси только для веб-моста (необязательно)", "Web-only proxy (optional)"),
                 bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9)).pack(side="left")
        self.var_web_proxy = tk.StringVar(value=str(self._web.get("proxy", "") or ""))
        tk.Entry(row_web, textvariable=self.var_web_proxy, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                 width=24, highlightbackground=BORDER, highlightthickness=1).pack(side="right")
        tk.Label(u_body, text=T("Пусто = использовать глобальный прокси из раздела «Сеть».",
                                "Empty = use the global proxy from the network section below."),
                 bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8)).pack(anchor="w", pady=(0, 4))

        row_label = tk.Frame(u_body, bg=PANEL)
        row_label.pack(fill="x", pady=(0, 4))
        tk.Label(row_label, text=T("Подпись аккаунта (например, «личный Pro»)", "Account label (e.g. “personal Pro”)"),
                 bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 9)).pack(side="left")
        self.var_web_label = tk.StringVar(value=str(self._web.get("accountLabel", "") or ""))
        tk.Entry(row_label, textvariable=self.var_web_label, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Segoe UI", 9),
                 width=24, highlightbackground=BORDER, highlightthickness=1).pack(side="right")

        row_au = tk.Frame(u_body, bg=PANEL)
        row_au.pack(fill="x", pady=(0, 4))

        tk.Label(row_au, text=T("Индекс аккаунта Google /u/ (0 = основной)", "Google account /u/ index (0 = main)"),
                 bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 9)).pack(side="left")
        self.var_web_authuser = tk.StringVar(value=str(self._web.get("authUser", "") if self._web.get("authUser") is not None else ""))
        tk.Entry(row_au, textvariable=self.var_web_authuser, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                 width=8, justify="right", highlightbackground=BORDER, highlightthickness=1).pack(side="right")

        self.var_web_temp = tk.BooleanVar(value=bool(self._web.get("temporaryChats", False)))
        tk.Checkbutton(u_body, text=T("Временные чаты (не сохранять в историю Gemini)", "Temporary chats (don't save to Gemini history)"),
                       variable=self.var_web_temp, bg=PANEL, fg=TEXT_PRIMARY,
                       selectcolor=PANEL_SUBTLE, activebackground=PANEL,
                       activeforeground=TEXT_PRIMARY, highlightthickness=0, wraplength=480, justify="left",
                       font=("Segoe UI", 9)).pack(anchor="w", fill="x", pady=(0, 4))

        tk.Label(u_body, text=T("Версия BL (необязательно; по умолчанию обновляется автоматически):",
                                "Optional BL version (auto-updated by default):"),
                 bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8)).pack(anchor="w", pady=(4, 2))
        self.var_web_bl = tk.StringVar(value=str(self._web.get("bl", "") or ""))
        tk.Entry(u_body, textvariable=self.var_web_bl, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 8),
                 highlightbackground=BORDER, highlightthickness=1).pack(fill="x")

        # 2.6 Agent & Planner (opt-in) Card
        planner_cfg = self._agent.get("planner") or {}

        agent_card = tk.Frame(agent_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        agent_card.pack(fill="x", pady=(0, 12))

        a_head = tk.Frame(agent_card, bg=PANEL)
        a_head.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(a_head, text=T("СЕРВЕРНЫЙ АГЕНТСКИЙ ЦИКЛ (ОПЦИЯ)", "SERVER-SIDE AGENT LOOP (OPT-IN)"),
                 bg=PANEL, fg=ACCENT_CYAN,
                 font=("Segoe UI", 8, "bold")).pack(side="left")
        tk.Label(a_head, text=T("cloud/* нативные tools · web/* текстовый протокол", "cloud/* native tools · web/* text protocol"),
                 bg=PANEL, fg=TEXT_DIM,
                 font=("Segoe UI", 8)).pack(side="left", padx=(8, 0))

        a_sep = tk.Frame(agent_card, bg=BORDER, height=1)
        a_sep.pack(fill="x", padx=14, pady=(0, 10))

        a_body = tk.Frame(agent_card, bg=PANEL)
        a_body.pack(fill="x", padx=14, pady=(0, 12))

        self.var_agent_enabled = tk.BooleanVar(value=self._agent.get("enabled", True) is not False)
        tk.Checkbutton(a_body, text=T("Разрешить серверный агентский цикл (cloud/<id>-agent, body.agent=true, tools=\"builtin\")",
                                      "Allow the server-side agent loop (cloud/<id>-agent, body.agent=true, tools=\"builtin\")"),
                       variable=self.var_agent_enabled, bg=PANEL, fg=TEXT_PRIMARY,
                       selectcolor=PANEL_SUBTLE, activebackground=PANEL,
                       activeforeground=TEXT_PRIMARY, highlightthickness=0, wraplength=480, justify="left",
                       font=("Segoe UI", 9, "bold")).pack(anchor="w", fill="x")
        tk.Label(a_body, text=T("Это разрешение, а не автозапуск: агент не работает сам по себе и срабатывает только по явному "
                                "запросу cloud/<model>-agent или agent:true (Cline/Roo/Continue и т.п.). Планировщик — это "
                                "инструмент внутри агента: вызывается только им и тратит квоту Gemini Web.",
                                "This is permission, not auto-start: the agent never runs by itself and only activates on an "
                                "explicit cloud/<model>-agent or agent:true request (Cline/Roo/Continue etc.). The planner is a "
                                "tool inside the agent: it is called only by the agent and uses Gemini Web quota."),
                 bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 8),
                 wraplength=480, justify="left").pack(anchor="w", fill="x", pady=(2, 0))

        self.var_allow_web_agent = tk.BooleanVar(value=self._agent.get("allowWebAgent") is True)
        tk.Checkbutton(a_body, text=T("Разрешить агентский режим Gemini Web (web/<alias>-agent)",
                                      "Allow Gemini Web agent mode (web/<alias>-agent)"),
                       variable=self.var_allow_web_agent, bg=PANEL, fg=TEXT_PRIMARY,
                       selectcolor=PANEL_SUBTLE, activebackground=PANEL,
                       activeforeground=TEXT_PRIMARY, highlightthickness=0, wraplength=480, justify="left",
                       font=("Segoe UI", 9)).pack(anchor="w", fill="x", pady=(6, 0))
        tk.Label(a_body, text=T("ОЧЕНЬ ненадёжно: Gemini Web ограничивает длину ответа, инструменты эмулируются текстовым протоколом. "
                                "Длинные файлы и проекты обрезаются — только короткие задачи.",
                                "VERY unreliable: Gemini Web caps response length and tools are emulated as a text protocol. "
                                "Long files and projects get truncated — short tasks only."),
                 bg=PANEL, fg=DANGER, font=("Segoe UI", 8, "bold"),
                 wraplength=480, justify="left").pack(anchor="w", fill="x", pady=(2, 0))

        # 2.65 Planner (hybrid) Card
        plan_card = tk.Frame(agent_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        plan_card.pack(fill="x", pady=(0, 12))

        p_head = tk.Frame(plan_card, bg=PANEL)
        p_head.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(p_head, text=T("ПЛАНИРОВЩИК (ГИБРИД)", "PLANNER (HYBRID)"), bg=PANEL, fg=ACCENT_CYAN,
                 font=("Segoe UI", 8, "bold")).pack(side="left")
        tk.Label(p_head, text=T("облачная модель исполняет · Gemini Web консультирует",
                                "cloud model executes · Gemini Web advises"),
                 bg=PANEL, fg=TEXT_DIM,
                 font=("Segoe UI", 8)).pack(side="left", padx=(8, 0))

        p_sep = tk.Frame(plan_card, bg=BORDER, height=1)
        p_sep.pack(fill="x", padx=14, pady=(0, 10))

        p_body = tk.Frame(plan_card, bg=PANEL)
        p_body.pack(fill="x", padx=14, pady=(0, 12))

        self.var_planner_enabled = tk.BooleanVar(value=planner_cfg.get("enabled", True) is not False)
        tk.Checkbutton(p_body, text=T("Разрешить облачному агенту советоваться с планировщиком (инструмент ask_planner)",
                                      "Let cloud agent loops consult the planner (ask_planner tool)"),
                       variable=self.var_planner_enabled, bg=PANEL, fg=TEXT_PRIMARY,
                       selectcolor=PANEL_SUBTLE, activebackground=PANEL,
                       activeforeground=TEXT_PRIMARY, highlightthickness=0, wraplength=480, justify="left",
                       font=("Segoe UI", 9, "bold")).pack(anchor="w", fill="x")
        tk.Label(p_body, text=T("Вызовы планировщика используют сессию Gemini Web, а не квоту Cloud Code. "
                                "Модель должна быть из пространства имён web/<alias>.",
                                "Planner calls use the Gemini Web session, not Cloud Code quota. "
                                "The model must be a web/<alias> id."),
                 bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), wraplength=480,
                 justify="left").pack(anchor="w", pady=(2, 6))

        row_pm = tk.Frame(p_body, bg=PANEL)
        row_pm.pack(fill="x", pady=(0, 4))
        tk.Label(row_pm, text=T("Модель планировщика", "Planner model"), bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 9)).pack(side="left")
        self.var_planner_model = tk.StringVar(value=str(planner_cfg.get("model") or "web/gemini-4-argon-thinking"))
        tk.Entry(row_pm, textvariable=self.var_planner_model, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                 width=30, highlightbackground=BORDER, highlightthickness=1).pack(side="right")

        row_pc = tk.Frame(p_body, bg=PANEL)
        row_pc.pack(fill="x", pady=(0, 4))
        tk.Label(row_pc, text=T("Макс. вызовов планировщика на запрос", "Max planner calls per request"), bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 9)).pack(side="left")
        self.var_planner_calls = tk.StringVar(value=str(planner_cfg.get("maxCalls", 2)))
        tk.Entry(row_pc, textvariable=self.var_planner_calls, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                 width=8, justify="right", highlightbackground=BORDER, highlightthickness=1).pack(side="right")

        row_pt = tk.Frame(p_body, bg=PANEL)
        row_pt.pack(fill="x", pady=(0, 4))
        tk.Label(row_pt, text=T("Таймаут планировщика (мс)", "Planner timeout (ms)"), bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 9)).pack(side="left")
        self.var_planner_timeout = tk.StringVar(value=str(planner_cfg.get("timeoutMs", 60000)))
        tk.Entry(row_pt, textvariable=self.var_planner_timeout, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                 width=8, justify="right", highlightbackground=BORDER, highlightthickness=1).pack(side="right")

        # 2.68 Agent Sandbox Card
        sandbox_card = tk.Frame(agent_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        sandbox_card.pack(fill="x", pady=(0, 12))

        sb_head = tk.Frame(sandbox_card, bg=PANEL)
        sb_head.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(sb_head, text=T("ПЕСОЧНИЦА АГЕНТА", "AGENT SANDBOX"), bg=PANEL, fg=ACCENT_CYAN,
                 font=("Segoe UI", 8, "bold")).pack(side="left")

        sb_sep = tk.Frame(sandbox_card, bg=BORDER, height=1)
        sb_sep.pack(fill="x", padx=14, pady=(0, 10))

        sb_body = tk.Frame(sandbox_card, bg=PANEL)
        sb_body.pack(fill="x", padx=14, pady=(0, 12))

        row_ws = tk.Frame(sb_body, bg=PANEL)
        row_ws.pack(fill="x", pady=(0, 4))
        tk.Label(row_ws, text=T("Корень workspace (пусто = по умолчанию)", "Workspace root (empty = default)"),
                 bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 9)).pack(side="left")
        self.var_agent_workspace = tk.StringVar(value=str(self._agent.get("workspaceRoot") or ""))
        tk.Entry(row_ws, textvariable=self.var_agent_workspace, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 8),
                 width=30, highlightbackground=BORDER, highlightthickness=1).pack(side="right")

        row_it = tk.Frame(sb_body, bg=PANEL)
        row_it.pack(fill="x", pady=(0, 6))
        tk.Label(row_it, text=T("Макс. итераций инструментов (1–24)", "Max tool iterations (1–24)"),
                 bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 9)).pack(side="left")
        self.var_agent_max_iter = tk.StringVar(value=str(self._agent.get("maxIterations", 8)))
        tk.Entry(row_it, textvariable=self.var_agent_max_iter, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                 width=8, justify="right", highlightbackground=BORDER, highlightthickness=1).pack(side="right")

        flags = " · ".join(f"{name}: {'ON' if self._agent.get(name) else 'OFF'}"
                           for name in ("allowDelete", "allowShell", "allowAbsolutePaths"))
        tk.Label(sb_body, text=T(f"Флаги песочницы ({flags}) здесь только для чтения — правьте config.json и перезапускайте сервер.",
                                 f"Sandbox flags ({flags}) are read-only here — edit config.json and restart the server."),
                 bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), wraplength=480,
                 justify="left").pack(anchor="w")

        # 2.7 Network Transport (proxy / DNS) Card
        self._build_network_card(net_root)

        # 3. Local Consumption History Card (Optional Stats)
        loc = self.last_result.get("local", {})
        stat_card = tk.Frame(usage_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        stat_card.pack(fill="x", pady=(0, 12))

        s_head = tk.Frame(stat_card, bg=PANEL)
        s_head.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(s_head, text=T("ЛОКАЛЬНАЯ СТАТИСТИКА (СПРАВОЧНО)", "LOCAL USAGE METRICS (INFORMATIONAL)"),
                 bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 8, "bold")).pack(side="left")

        sep2 = tk.Frame(stat_card, bg=BORDER, height=1)
        sep2.pack(fill="x", padx=14, pady=(0, 10))

        s_body = tk.Frame(stat_card, bg=PANEL)
        s_body.pack(fill="x", padx=14, pady=(0, 12))

        req_today = loc.get("requestsToday", 0)
        tok_today = loc.get("tokensToday", 0)
        week_req = (loc.get("week") or {}).get("requests", 0)
        week_tok = (loc.get("week") or {}).get("tokens", 0)

        row_stat = tk.Frame(s_body, bg=PANEL)
        row_stat.pack(fill="x")

        tk.Label(row_stat, text=T(f"Сегодня: {req_today} запросов, {tok_today:,} токенов",
                                  f"Today: {req_today} requests, {tok_today:,} tokens"),
                 bg=PANEL, fg=TEXT_PRIMARY, font=("Segoe UI", 9)).pack(side="left")
        tk.Label(row_stat, text=T(f"7 дней: {week_req} запросов, {week_tok:,} токенов",
                                  f"7 Days: {week_req} requests, {week_tok:,} tokens"),
                 bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9)).pack(side="right")

    def _tab_scrollable(self, parent):
        canvas = tk.Canvas(parent, bg=BG, highlightthickness=0)
        vsb = tk.Scrollbar(parent, orient="vertical", command=canvas.yview, bg=PANEL, troughcolor=BG,
                           relief="flat", activebackground=ACCENT, width=12)
        canvas.configure(yscrollcommand=vsb.set)
        inner = tk.Frame(canvas, bg=BG)
        win = canvas.create_window((0, 0), window=inner, anchor="nw")

        def _on_inner_config(e):
            canvas.configure(scrollregion=canvas.bbox("all"))

        def _on_canvas_config(e):
            canvas.itemconfigure(win, width=e.width)

        inner.bind("<Configure>", _on_inner_config)
        canvas.bind("<Configure>", _on_canvas_config)
        bind_scroll_wheel(self, canvas)
        vsb.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        return inner

    def _restyle_notebooks(self):
        configure_notebook_style("settings")

    def _build_network_card(self, parent):
        net = self._cfg.get("network") or {}
        dns_list = net.get("dnsServers") or self._cfg.get("dnsServers") or []

        card = tk.Frame(parent, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        card.pack(fill="x", pady=(0, 12))

        head = tk.Frame(card, bg=PANEL)
        head.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(head, text=T("СЕТЕВОЙ ТРАНСПОРТ (ПРОКСИ И DNS)", "NETWORK TRANSPORT (PROXY & DNS)"), bg=PANEL, fg=ACCENT_CYAN,
                 font=("Segoe UI", 8, "bold")).pack(side="left")
        tk.Label(head, text="Cloud Code · OAuth · web bridge", bg=PANEL, fg=TEXT_DIM,
                 font=("Segoe UI", 8)).pack(side="left", padx=(8, 0))

        sep = tk.Frame(card, bg=BORDER, height=1)
        sep.pack(fill="x", padx=14, pady=(0, 10))

        body = tk.Frame(card, bg=PANEL)
        body.pack(fill="x", padx=14, pady=(0, 12))

        hint = tk.Label(body, text=T("Глобальный прокси для всех исходящих запросов: HTTP/HTTPS CONNECT или SOCKS5. "
                                     "Оставьте пустым для прямого подключения. Прокси веб-моста ниже переопределяет его для gemini.google.com.",
                                     "Global proxy for all upstream requests: HTTP/HTTPS CONNECT or SOCKS5. "
                                     "Leave empty for a direct connection. The web-bridge proxy below overrides this one for gemini.google.com."),
                        bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), wraplength=480, justify="left")
        hint.pack(anchor="w")
        wrap_to_width(hint)

        row_proxy = tk.Frame(body, bg=PANEL)
        row_proxy.pack(fill="x", pady=(6, 8))
        tk.Label(row_proxy, text=T("Глобальный прокси", "Global proxy"), bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9)).pack(anchor="w")
        proxy_line = tk.Frame(row_proxy, bg=PANEL)
        proxy_line.pack(fill="x", pady=(2, 0))
        action_button(proxy_line, T("Найти прокси", "Find proxy"), self.detect_proxy, compact=True).pack(side="right")
        self.var_net_proxy = tk.StringVar(value=str(net.get("proxy", "") or ""))
        tk.Entry(proxy_line, textvariable=self.var_net_proxy, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                 highlightbackground=BORDER, highlightthickness=1).pack(side="left", fill="x", expand=True, padx=(0, 8))

        tk.Label(body, text=T("DNS-over-HTTPS URL (пусто = системный DNS)", "DNS-over-HTTPS URL (empty = system DNS)"),
                 bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 9)).pack(anchor="w")
        self.var_net_doh = tk.StringVar(value=str(net.get("dohUrl", "") or ""))
        tk.Entry(body, textvariable=self.var_net_doh, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                 highlightbackground=BORDER, highlightthickness=1).pack(fill="x", pady=(2, 6))
        tk.Label(body, text="e.g. https://cloudflare-dns.com/dns-query · https://dns.google/dns-query",
                 bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8)).pack(anchor="w", pady=(0, 6))

        tk.Label(body, text=T("Свои DNS-серверы (через запятую; игнорируются, если задан DoH)",
                              "Custom DNS servers (comma-separated; ignored when DoH is set)"),
                 bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9)).pack(anchor="w")
        self.var_net_dns = tk.StringVar(value=", ".join(str(x) for x in dns_list))
        tk.Entry(body, textvariable=self.var_net_dns, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                 highlightbackground=BORDER, highlightthickness=1).pack(fill="x", pady=(2, 6))

        self.var_net_env = tk.BooleanVar(value=bool(net.get("useEnvProxy", True)))
        tk.Checkbutton(body, text=T("Использовать прокси из переменных среды (HTTPS_PROXY / ALL_PROXY)",
                                    "Use system environment proxy (HTTPS_PROXY / ALL_PROXY)"),
                       variable=self.var_net_env, bg=PANEL, fg=TEXT_PRIMARY,
                       selectcolor=PANEL_SUBTLE, activebackground=PANEL,
                       activeforeground=TEXT_PRIMARY, highlightthickness=0,
                       font=("Segoe UI", 9)).pack(anchor="w", pady=(0, 6))

        test_row = tk.Frame(body, bg=PANEL)
        test_row.pack(fill="x", pady=(2, 0))
        self.btn_net_test = action_button(test_row, T("Проверить соединение", "Test connection"), self.test_network, compact=True)
        self.btn_net_test.pack(side="left")
        self.net_status_lbl = tk.Label(test_row, text=T("Проверка использует сохранённые настройки.",
                                                        "The test uses saved settings."),
                                        bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), justify="left")
        self.net_status_lbl.pack(side="left", fill="x", expand=True, padx=(8, 0))
        wrap_to_width(self.net_status_lbl)

    def _network_values(self):
        proxy = self.var_net_proxy.get().strip()
        doh = self.var_net_doh.get().strip()
        dns_raw = self.var_net_dns.get().strip()
        if proxy and not re.match(r"^(https?|socks5h?)://", proxy, re.I):
            if not re.match(r"^[^\s/]+:\d{1,5}$", proxy):
                return None, T("Прокси: укажите URL вида http://host:port или socks5://host:port.",
                               "Proxy: use a URL like http://host:port or socks5://host:port.")
        if doh and not re.match(r"^https?://[^/\s]+", doh, re.I):
            return None, T("DoH: укажите URL вида https://cloudflare-dns.com/dns-query.",
                           "DoH: use a URL like https://cloudflare-dns.com/dns-query.")

        servers = []
        for chunk in re.split(r"[,;\s]+", dns_raw):
            chunk = chunk.strip()
            if not chunk:
                continue
            try:
                ipaddress.ip_address(chunk)
            except ValueError:
                return None, T(f"Некорректный DNS-сервер: {chunk}", f"Invalid DNS server: {chunk}")
            servers.append(chunk)
        return {
            "proxy": proxy,
            "dohUrl": doh,
            "dnsServers": servers,
            "useEnvProxy": bool(self.var_net_env.get()),
        }, None

    @staticmethod
    def _mask_proxy(url):
        return re.sub(r"(://)[^/@\s]+@", r"\1***@", str(url))

    def detect_proxy(self):
        self.net_status_lbl.configure(text=T("Ищу локальные прокси…", "Searching for local proxies…"), fg=TEXT_MUTED)
        try:
            from scripts.proxy_detect import detect_proxies
        except Exception as exc:
            self.net_status_lbl.configure(text=T(f"Модуль поиска недоступен: {exc}", f"Search module unavailable: {exc}"), fg=DANGER)
            return
        self.master._call_async(detect_proxies, self._apply_detected_proxies)

    def _apply_detected_proxies(self, result):
        if not self.winfo_exists():
            return
        if isinstance(result, Exception):
            self.net_status_lbl.configure(text=T(f"Поиск не удался: {result}", f"Search failed: {result}"), fg=DANGER)
            return
        if not result:
            self.net_status_lbl.configure(
                text=T("Прокси не найден. Укажите адрес вручную (например, http://127.0.0.1:7890).",
                       "No proxy found. Enter the address manually (e.g. http://127.0.0.1:7890)."),
                fg=WARNING)
            return
        self.var_net_proxy.set(result[0]["url"])
        labels = "; ".join(
            f"{self._mask_proxy(item['url'])} ({item['source']})" for item in result[:3])
        self.net_status_lbl.configure(
            text=T(f"Найден прокси: {labels}. Нажмите «Сохранить и применить».",
                   f"Proxy found: {labels}. Press Save & Apply."), fg=SUCCESS)

    def test_network(self):
        if not is_running():
            self.net_status_lbl.configure(text=T("Сервер не запущен — запустите его и повторите.",
                                                 "The server is not running — start it and retry."), fg=WARNING)
            return
        self.btn_net_test.configure(state="disabled")
        self.net_status_lbl.configure(text=T("Проверяю Cloud Code, OAuth и Gemini Web…",
                                             "Checking Cloud Code, OAuth and Gemini Web…"), fg=TEXT_MUTED)
        self.master._call_async(lambda: http_get("/_network/test", timeout=20, with_key=True),
                                self._apply_network_test)

    def _apply_network_test(self, result):
        if not self.winfo_exists():
            return
        self.btn_net_test.configure(state="normal")
        if isinstance(result, Exception):
            self.net_status_lbl.configure(text=T(f"Проверка не удалась: {result}", f"Test failed: {result}"), fg=DANGER)
            return
        routes = result.get("routes") or []
        parts = [f"{r.get('label') or r.get('name')}: {'OK' if r.get('ok') else 'ERR'}" for r in routes]
        dns_bad = [d.get("host") for d in (result.get("dns") or []) if not d.get("ok")]
        proxy = result.get("proxy")
        ok = bool(result.get("ok"))
        text = T("Сеть доступна. ", "Network is reachable. ") if ok else T("Есть проблемы. ", "Problems found. ")
        text += " · ".join(parts)
        if proxy:
            text += T(f" · прокси: {'OK' if proxy.get('ok') else 'ERR'}",
                      f" · proxy: {'OK' if proxy.get('ok') else 'ERR'}")
        if dns_bad:
            text += T(" · DNS не отвечает: ", " · DNS not responding: ") + ", ".join(dns_bad)
        self.net_status_lbl.configure(text=text, fg=SUCCESS if ok else WARNING)

    def _save(self):
        new_safe = {"enabled": self.var_enabled.get()}
        # Те же границы, что в lib/config/schema.js: иначе maxConcurrent=0
        # навсегда вешает все запросы в очереди guard, а отрицательный интервал
        # превращается в случайный 429.
        limits = {
            "maxRequestsPerMinute": (1, 10_000_000), "maxRequestsPerHour": (1, 10_000_000),
            "maxRequestsPerDay": (1, 10_000_000), "maxRequestsPerWeek": (1, 10_000_000),
            "minIntervalMs": (0, 10_000_000), "jitterMs": (0, 10_000_000),
            "maxConcurrent": (1, 1024), "maxTokensPerDay": (0, 10 ** 12),
            "maxTokensPerWeek": (0, 10 ** 12), "cooldownAfter429Ms": (0, 10 ** 12),
            "maxCooldownMs": (0, 10 ** 12),
        }
        for k, var in self.entries.items():
            val = var.get().strip().replace(" ", "").replace("_", "")
            try:
                num = int(val)
            except ValueError:
                self.status_lbl.configure(text=T(f"Некорректное число для {k}", f"Invalid number for {k}"), fg=DANGER)
                return
            low, high = limits.get(k, (0, 10 ** 12))
            if not low <= num <= high:
                self.status_lbl.configure(
                    text=T(f"{k}: допустимо от {low} до {high}", f"{k}: allowed range is {low}..{high}"), fg=DANGER)
                return
            new_safe[k] = num

        # Gemini 4 Unlock (Web Bridge)
        cookie_val = self.web_cookie_text.get("1.0", "end").strip()
        proxy_val = self.var_web_proxy.get().strip()
        bl_val = self.var_web_bl.get().strip()
        au_raw = self.var_web_authuser.get().strip().replace(" ", "")
        au_val = None
        if au_raw != "":
            try:
                au_val = int(au_raw)
            except ValueError:
                self.status_lbl.configure(
                    text=T("Некорректный индекс аккаунта (нужно число, например 0, 1, 2)",
                           "Invalid account index (must be a number, e.g. 0, 1, 2)"), fg=DANGER)
                return
        new_web = {"enabled": self.var_web_enabled.get(), "proxy": proxy_val,
                   "authUser": au_val, "temporaryChats": self.var_web_temp.get(),
                   "accountLabel": self.var_web_label.get().strip()}
        if bl_val:
            new_web["bl"] = bl_val
        if cookie_val:
            lowered = cookie_val.lower()
            if lowered.endswith(".txt") and "\\" not in cookie_val and "/" not in cookie_val:
                new_web["cookie_file"] = cookie_val
                new_web["cookie"] = ""
            else:
                new_web["cookie"] = cookie_val
                new_web["cookie_file"] = ""

        new_network, net_error = self._network_values()
        if net_error:
            self.status_lbl.configure(text=net_error, fg=DANGER)
            return

        # Agent & Planner (autoAgent is legacy and intentionally dropped)
        planner_model = self.var_planner_model.get().strip()
        if not re.match(r"^web/[A-Za-z0-9._-]+$", planner_model):
            self.status_lbl.configure(
                text=T("Планировщик: модель должна быть в пространстве имён web/<alias> "
                       "(например, web/gemini-4-argon-thinking).",
                       "Planner: the model must use the web/<alias> namespace "
                       "(e.g. web/gemini-4-argon-thinking)."), fg=DANGER)
            return
        try:
            planner_calls = int(self.var_planner_calls.get().strip())
            planner_timeout = int(self.var_planner_timeout.get().strip())
            max_iterations = int(self.var_agent_max_iter.get().strip())
        except ValueError:
            self.status_lbl.configure(
                text=T("Агент: maxCalls, timeoutMs и maxIterations должны быть целыми числами.",
                       "Agent: maxCalls, timeoutMs and maxIterations must be integers."), fg=DANGER)
            return
        if planner_calls < 1 or planner_timeout < 1000 or not (1 <= max_iterations <= 24):
            self.status_lbl.configure(
                text=T("Агент: maxCalls ≥ 1, timeoutMs ≥ 1000, maxIterations 1–24.",
                       "Agent: maxCalls ≥ 1, timeoutMs ≥ 1000, maxIterations 1–24."), fg=DANGER)
            return
        new_agent = {
            "enabled": bool(self.var_agent_enabled.get()),
            "allowWebAgent": bool(self.var_allow_web_agent.get()),
            "workspaceRoot": self.var_agent_workspace.get().strip(),
            "maxIterations": max_iterations,
            "planner": {
                "enabled": bool(self.var_planner_enabled.get()),
                "model": planner_model,
                "maxCalls": planner_calls,
                "timeoutMs": planner_timeout,
            },
        }

        # 1. Update config.json
        cfg = read_config()
        if cfg is None:
            self.status_lbl.configure(text=T(*CONFIG_DAMAGED_MSG), fg=DANGER)
            return
        cfg["safeMode"] = {**config_section(cfg, "safeMode"), **new_safe}
        cfg["geminiWeb"] = {**config_section(cfg, "geminiWeb"), **new_web}
        cfg["network"] = {**config_section(cfg, "network"), **new_network}
        cfg["dnsServers"] = new_network["dnsServers"]
        existing_agent = config_section(cfg, "agent")
        merged_agent = {**existing_agent, **new_agent,
                        "planner": {**config_section(existing_agent, "planner"), **new_agent["planner"]}}
        merged_agent.pop("autoAgent", None)
        cfg["agent"] = merged_agent
        if not save_config(cfg):
            self.status_lbl.configure(text=T("Не удалось записать config.json", "Failed to write config.json"), fg=DANGER)
            return

        # Network waits must not block the form or hide the save result.
        payload = {"safeMode": new_safe, "geminiWeb": new_web,
                   "network": new_network, "dnsServers": new_network["dnsServers"],
                   "agent": new_agent}
        self.btn_save.configure(state="disabled")
        self.status_lbl.configure(text=T("Сохранено. Применяем к работающему серверу…",
                                         "Saved. Applying to the running server…"), fg=TEXT_MUTED)

        def apply_live():
            if not is_running():
                return False
            return bool(http_post("/_config", payload, timeout=3.0, with_key=True).get("ok"))

        def applied(result):
            if self.winfo_exists():
                self.btn_save.configure(state="normal")
                if result is True:
                    self.status_lbl.configure(text=T("Сохранено и применено к серверу.",
                                                     "Saved and applied to the server."), fg=SUCCESS)
                else:
                    self.status_lbl.configure(
                        text=T("Сохранено в config.json. Изменения вступят в силу после перезапуска сервера.",
                               "Saved to config.json. Changes will apply after the server restarts."),
                        fg=WARNING if isinstance(result, Exception) else TEXT_MUTED)
            if self.on_saved:
                self.on_saved()

        self.master._call_async(apply_live, applied)

    def paste_cookie_from_clipboard(self):
        """Insert cookies from the clipboard (manual DevTools copy)."""
        try:
            text = self.clipboard_get()
        except Exception as exc:
            self.status_lbl.configure(text=T(f"Буфер пуст или недоступен: {exc}", f"Clipboard is empty or unavailable: {exc}"), fg=DANGER)
            return
        text = text.strip()
        if not text:
            self.status_lbl.configure(text=T("Буфер обмена пуст.", "Clipboard is empty."), fg=DANGER)
            return
        self.web_cookie_text.delete("1.0", "end")
        self.web_cookie_text.insert("1.0", text)
        n = len(text)
        sap = T("SAPISID есть", "SAPISID present") if "SAPISID=" in text else \
            T("SAPISID НЕ найден — проверьте, что скопировали заголовок Cookie целиком",
              "SAPISID NOT found — make sure the whole Cookie header was copied")
        self.status_lbl.configure(
            text=T(f"Вставлено из буфера ({n} символов, {sap}). Нажмите «Сохранить и применить».",
                   f"Pasted from clipboard ({n} chars, {sap}). Press Save & Apply."),
            fg=SUCCESS if "SAPISID=" in text else DANGER)

    def open_gemini_signin(self):
        try:
            if not webbrowser.open(GEMINI_URL):
                raise RuntimeError(T("браузер по умолчанию не найден", "default browser not found"))
        except Exception as exc:
            self.status_lbl.configure(text=T(f"Не удалось открыть браузер: {exc}",
                                             f"Failed to open the browser: {exc}"), fg=DANGER)
            return
        self.status_lbl.configure(
            text=T("Открыл Gemini в браузере по умолчанию. Войдите в аккаунт, затем скопируйте Cookie вручную (F12 → Network) и вставьте выше.",
                   "Opened Gemini in the default browser. Sign in, then copy the Cookie header manually (F12 → Network) and paste it above."),
            fg=TEXT_MUTED)

# ==================== MAIN DASHBOARD APPLICATION ====================

class App(tk.Tk):
    def __init__(self, hidden=False):
        self.theme = "dark" if CFG.get("theme") == "dark" else "light"
        apply_palette(self.theme)
        global ACCENT_CYAN
        ACCENT_CYAN = ACCENT
        super().__init__()
        self.title("Antigravity API")
        self.configure(bg=BG)
        try:
            main_w = min(1200, max(860, self.winfo_screenwidth() - 80))
            main_h = min(900, max(600, self.winfo_screenheight() - 100))
        except Exception:
            main_w, main_h = 1000, 700
        self.geometry(f"{main_w}x{main_h}")
        self.minsize(780, 560)
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.proc = None
        self._models_loaded = False
        self._last_running = None
        self._logo_image = None
        self._last_limits_result = {}
        self._async_queue = queue.Queue()
        self._card_badges = {}
        self._limits_inflight = False
        self._limits_loaded = False
        self._models_inflight = False
        self._status_inflight = False
        self._settings_dialog = None
        self._diagnostic_dialog = None

        if os.path.exists(ICO_PATH):
            try:
                self.iconbitmap(ICO_PATH)
            except Exception:
                pass

        # Check and auto-extract token on first run if missing
        self._check_first_run_auth()

        self._build()
        self.after(300, self._drain_async)
        self._poll_status()
        self.after(2500, self._loop)

        if hidden:
            # Автозапуск: панель не должна висеть на панели задач, но должна
            # оставаться в трее-области — withdraw() убирает её и оттуда, и
            # тогда к настройкам не вернуться без перезапуска.
            self.iconify()

    def _check_first_run_auth(self):
        global API_KEY
        if not os.path.exists(AUTH_FILE):
            try:
                auto_extract(force=False, out_path=AUTH_FILE)
            except Exception:
                pass
        if not API_KEY:
            API_KEY = read_api_key()

    def toggle_theme(self):
        old = DARK_PALETTE if self.theme == "dark" else LIGHT_PALETTE
        self.theme = "light" if self.theme == "dark" else "dark"
        new = DARK_PALETTE if self.theme == "dark" else LIGHT_PALETTE
        apply_palette(self.theme)
        global ACCENT_CYAN
        ACCENT_CYAN = ACCENT
        cfg = read_config()
        if cfg is not None:
            save_config(set_theme_config(cfg, self.theme))
        self._recolor_tree(self, old, new)
        self._restyle_notebooks()
        if self._settings_dialog is not None and self._settings_dialog.winfo_exists():
            self._recolor_tree(self._settings_dialog, old, new)
            self._settings_dialog._restyle_notebooks()
        self.btn_theme.configure(text=T("Светлая тема", "Light theme") if self.theme == "dark"
                                 else T("Тёмная тема", "Dark theme"))
        for bar in (self.gem_weekly_bar, self.gem_5h_bar,
                    self.claude_weekly_bar, self.claude_5h_bar):
            self._set_quota_bar(bar, *bar["state"])

    def switch_language(self, lang):
        lang = "en" if lang == "en" else "ru"
        if lang == UI_LANG:
            return
        set_ui_language(lang)
        for attr in ("_settings_dialog", "_diagnostic_dialog"):
            dialog = getattr(self, attr, None)
            if dialog is not None:
                try:
                    if dialog.winfo_exists():
                        dialog.destroy()
                except Exception:
                    pass
                setattr(self, attr, None)
        # bind_scroll_wheel adds handlers on this window; drop them before rebuilding.
        for sequence in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
            self.unbind(sequence)
        for child in self.winfo_children():
            child.destroy()
        self._card_badges = {}
        self._models_loaded = False
        self._limits_loaded = False
        self._build()
        self._restyle_notebooks()
        self.refresh_all()

    # ---------------- Antigravity installations ----------------

    def _install_row(self, parent, key, name, path):
        row = tk.Frame(parent, bg=PANEL)
        row.pack(fill="x", padx=14, pady=(0, 6))
        dot = tk.Label(row, text="○", bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 11, "bold"))
        dot.pack(side="left", padx=(0, 8))
        tk.Label(row, text=name, bg=PANEL, fg=TEXT_PRIMARY, font=("Segoe UI", 9, "bold"),
                 width=22, anchor="w").pack(side="left")
        path_lbl = tk.Label(row, text="", bg=PANEL, fg=TEXT_MUTED, font=("Consolas", 8), anchor="w")
        path_lbl.pack(side="left", fill="x", expand=True, padx=(6, 6))
        tk.Button(row, text="✎", command=lambda k=key: self._edit_install_path(k),
                  bg=PANEL, fg=TEXT_MUTED, activebackground=PANEL_SUBTLE, activeforeground=ACCENT,
                  relief="flat", bd=0, cursor="hand2", font=("Segoe UI", 10),
                  padx=4, pady=0).pack(side="right")
        self._install_rows[key] = {"dot": dot, "path": path_lbl}
        self._refresh_install_row(key, path)

    def _refresh_install_row(self, key, path):
        row = self._install_rows.get(key)
        if not row:
            return
        valid = _valid_install_path(key, path)
        row["dot"].configure(text="✓" if valid else "○", fg=SUCCESS if valid else TEXT_DIM)
        if valid:
            text, color = path, TEXT_MUTED
        elif path:
            text, color = T(f"некорректный путь: {path}", f"invalid path: {path}"), TEXT_DIM
        else:
            text, color = T("не найдено — укажите путь", "not found — set a path"), TEXT_DIM
        row["path"].configure(text=text, fg=color)

    def _edit_install_path(self, key):
        overrides = read_install_overrides()
        current = overrides.get(key) or detect_install_paths().get(key) or ""
        if key == "cli":
            chosen = filedialog.askopenfilename(
                title=T("Выберите Antigravity CLI", "Select Antigravity CLI"),
                initialdir=os.path.dirname(current) if current else os.environ.get("LOCALAPPDATA", ""),
                filetypes=[("Executable", "*.exe *.cmd *.bat"), ("All files", "*.*")])
        else:
            chosen = filedialog.askdirectory(
                title=T("Укажите папку Antigravity", "Select the Antigravity folder"),
                initialdir=current if os.path.isdir(current) else os.environ.get("LOCALAPPDATA", ""))
        if not chosen:
            return
        overrides[key] = chosen
        save_install_overrides(overrides)
        self._refresh_install_row(key, chosen)

    def _recolor_tree(self, widget, old, new):
        color_map = {value.lower(): new[key] for key, value in old.items()}
        for option in ("bg", "background", "fg", "foreground", "activebackground",
                       "activeforeground", "selectcolor", "insertbackground",
                       "readonlybackground", "highlightbackground", "highlightcolor", "troughcolor"):
            try:
                value = widget.cget(option)
                if isinstance(value, str) and value.lower() in color_map:
                    widget.configure(**{option: color_map[value.lower()]})
            except (tk.TclError, TypeError):
                pass
        if isinstance(widget, tk.Canvas):
            try:
                for item in widget.find_all():
                    for option in ("fill", "outline"):
                        value = widget.itemcget(item, option)
                        if value and value.lower() in color_map:
                            widget.itemconfigure(item, **{option: color_map[value.lower()]})
            except tk.TclError:
                pass
        for child in widget.winfo_children():
            self._recolor_tree(child, old, new)

    # ---------------- Scrollable Workspace ----------------

    def _scrollable(self, parent):
        canvas = tk.Canvas(parent, bg=BG, highlightthickness=0)
        vsb = tk.Scrollbar(parent, orient="vertical", command=canvas.yview, bg=PANEL, troughcolor=BG,
                           relief="flat", activebackground=ACCENT, width=10)
        canvas.configure(yscrollcommand=vsb.set)
        inner = tk.Frame(canvas, bg=BG)
        win = canvas.create_window((0, 0), window=inner, anchor="nw")

        def _on_inner_config(e):
            canvas.configure(scrollregion=canvas.bbox("all"))

        def _on_canvas_config(e):
            canvas.itemconfigure(win, width=e.width)

        inner.bind("<Configure>", _on_inner_config)
        canvas.bind("<Configure>", _on_canvas_config)

        bind_scroll_wheel(self, canvas)
        canvas.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        return inner

    # ---------------- Styled Card ----------------

    def _card(self, parent, title=None, badge=None, right_widget_fn=None, accent=None, key=None, **pack):
        f = tk.Frame(parent, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        f.pack(**pack)

        body = tk.Frame(f, bg=PANEL)
        body.pack(side="left", fill="both", expand=True)

        if title or right_widget_fn:
            head = tk.Frame(body, bg=PANEL)
            head.pack(fill="x", padx=14, pady=(10, 6))

            if right_widget_fn:
                right_widget_fn(head)

            title_row = tk.Frame(head, bg=PANEL)
            title_row.pack(side="left", fill="x", expand=True)

            if title:
                title_lbl = tk.Label(title_row, text=title, bg=PANEL, fg=TEXT_PRIMARY,
                                     font=("Segoe UI", 10, "bold"))
                title_lbl.pack(fill="x")
                wrap_to_width(title_lbl)

            if badge:
                b_lbl = tk.Label(title_row, text=badge, bg=PANEL, fg=TEXT_MUTED,
                                 font=("Segoe UI", 9), anchor="w")
                b_lbl.pack(fill="x", pady=(2, 0))
                wrap_to_width(b_lbl)
                self._card_badges[key or title] = b_lbl

            sep = tk.Frame(body, bg=BORDER, height=1)
            sep.pack(fill="x", padx=14, pady=(2, 8))

        return body

    def _model_listbox(self, parent, height=7):
        frame = tk.Frame(parent, bg=PANEL)
        frame.pack(fill="x", padx=14, pady=(0, 6))
        lb = tk.Listbox(frame, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY, relief="flat",
                        selectbackground=ACCENT, selectforeground="#FFFFFF",
                        font=("Consolas", 9), activestyle="none", height=height,
                        highlightbackground=BORDER, highlightthickness=1)
        sb = tk.Scrollbar(frame, command=lb.yview, bg=PANEL_SUBTLE,
                          troughcolor=PANEL_SUBTLE, relief="flat", width=10)
        lb.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        lb.pack(side="left", fill="both", expand=True)
        lb.bind("<Control-c>", lambda e: self.copy_model())
        return lb

    def _active_model_list(self):
        try:
            idx = self.main_tabs.index(self.main_tabs.select())
        except Exception:
            idx = 0
        return self.web_model_list if idx == 1 else self.cloud_model_list

    def _restyle_notebooks(self):
        configure_notebook_style("main")

    # ---------------- Build GUI ----------------

    def _build(self):
        # Keep server controls visible while scrolling through models/settings.
        toolbar = tk.Frame(self, bg=BG)
        toolbar.pack(side="top", fill="x")

        # 1. Compact application header
        head_card = tk.Frame(toolbar, bg=BG)
        head_card.pack(fill="x", padx=18, pady=(16, 12))

        title_box = tk.Frame(head_card, bg=BG)
        title_box.pack(side="left", fill="y")

        title_text_box = tk.Frame(title_box, bg=BG)
        title_text_box.pack(side="left", anchor="w")

        title_row = tk.Frame(title_text_box, bg=BG)
        title_row.pack(anchor="w")

        tk.Label(title_row, text="Antigravity API", bg=BG, fg=TEXT_PRIMARY,
                 font=("Segoe UI", 16, "bold")).pack(side="left")
        tk.Label(title_text_box, text=T("Локальный шлюз · OpenAI, Gemini и Claude", "Local gateway · OpenAI, Gemini & Claude"),
                 bg=BG, fg=TEXT_MUTED, font=("Segoe UI", 9)).pack(anchor="w", pady=(3, 0))

        # Language switch: the whole interface follows this choice and it persists.
        lang_box = tk.Frame(head_card, bg=BG)
        lang_box.pack(side="right", padx=(0, 10), pady=2)
        for code, label in (("ru", "RU"), ("en", "EN")):
            active = UI_LANG == code
            b = tk.Button(lang_box, text=label, command=lambda c=code: self.switch_language(c),
                          bg=ACCENT if active else PANEL_SUBTLE,
                          fg="#FFFFFF" if active else TEXT_MUTED,
                          activebackground=ACCENT_HOVER, activeforeground="#FFFFFF",
                          relief="flat", bd=0, highlightthickness=1,
                          highlightbackground=ACCENT if active else BORDER,
                          highlightcolor=BORDER_LIGHT, takefocus=True, cursor="hand2",
                          font=("Segoe UI", 8, "bold"), padx=9, pady=3)
            b.pack(side="left", padx=(4, 0))

        # Status Pill Badge
        self.status_pill = tk.Frame(head_card, bg=PANEL_SUBTLE, highlightbackground=BORDER, highlightthickness=1)
        self.status_pill.pack(side="right", pady=2)

        self.status_dot = tk.Canvas(self.status_pill, width=10, height=10, bg=PANEL_SUBTLE, highlightthickness=0)
        self.status_dot.pack(side="left", padx=(8, 4), pady=5)
        self.status_text = tk.Label(self.status_pill, text=T("ПРОВЕРКА", "CHECKING"), bg=PANEL_SUBTLE, fg=TEXT_MUTED,
                                    font=("Segoe UI", 9, "bold"), padx=4)
        self.status_text.pack(side="left", padx=(0, 8))

        # 2. Action Controls Bar
        actions_bar = tk.Frame(toolbar, bg=BG)
        actions_bar.pack(fill="x", padx=18, pady=(0, 8))

        self.btn_toggle = self._primary_button(actions_bar, T("Запустить API-сервер", "Start API Server"), self.toggle_server)
        self.btn_toggle.pack(side="left")
        self.btn_refresh = self._secondary_button(actions_bar, T("Обновить", "Refresh"), self.refresh_all)
        self.btn_refresh.pack(side="left", padx=(8, 0))
        self.btn_settings = self._secondary_button(actions_bar, T("Настройки и лимиты", "Settings & Limits"), self.open_settings)
        self.btn_settings.pack(side="left", padx=(8, 0))
        self.btn_theme = self._secondary_button(actions_bar, T("Светлая тема", "Light theme") if self.theme == "dark"
                                               else T("Тёмная тема", "Dark theme"),
                                               self.toggle_theme)
        self.btn_theme.pack(side="right")

        tools_bar = tk.Frame(toolbar, bg=BG)
        tools_bar.pack(fill="x", padx=18, pady=(0, 12))
        self.btn_auto_token = self._secondary_button(tools_bar, T("Привязать токен IDE", "Re-link IDE Token"), self.auto_detect_token_gui)
        self.btn_auto_token.pack(side="left")
        self.btn_web = self._secondary_button(tools_bar, T("Статус-страница", "Status page"), lambda: webbrowser.open(f"http://127.0.0.1:{PORT}/"))
        self.btn_web.pack(side="left", padx=(8, 0))
        self.btn_diagnostic = self._secondary_button(tools_bar, T("Диагностический чат", "Diagnostic Chat"), self.open_diagnostic_chat)
        self.btn_diagnostic.pack(side="left", padx=(8, 0))

        workspace = tk.Frame(self, bg=BG)
        self.main_tabs, (cloud_page, web_page, conn_page) = make_notebook_tabs(
            workspace, ["Cloud Code", "Gemini Web", T("Подключение", "Connection")], note="main")
        root = self._scrollable(cloud_page)
        web_root = self._scrollable(web_page)
        conn_root = self._scrollable(conn_page)

        # 3. Card: REAL UPSTREAM MODEL QUOTAS (in Percent %)
        def _quota_head(h):
            self._icon_button(h, T("Обновить квоты", "Refresh Quotas"), lambda: self.refresh_limits(force=True)).pack(side="right")

        q_card = self._card(root, title=T("Квоты моделей на сервере", "Upstream Model Quotas"),
                            badge=T("Квоты Google Cloud Code", "Google Cloud Code Quotas"),
                            right_widget_fn=_quota_head, fill="x", padx=18, pady=(0, 12))

        q_desc = tk.Label(q_card, text=T("Остаток доступной квоты по данным Google Cloud Code. Веб-мост использует отдельный пул.",
                                         "Remaining quota reported by Google Cloud Code. The web bridge uses a separate pool."),
                          bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9), anchor="w")
        q_desc.pack(fill="x", padx=14, pady=(0, 8))
        wrap_to_width(q_desc)

        # Two Family Groups: Gemini Models & Claude/GPT Models
        q_grid = tk.Frame(q_card, bg=PANEL)
        q_grid.pack(fill="x", padx=14, pady=(0, 10))

        # Box 1: Gemini Models
        gem_box = tk.Frame(q_grid, bg=PANEL_SUBTLE, highlightbackground=BORDER, highlightthickness=1)
        gem_box.pack(fill="x", pady=(0, 8))

        g_head = tk.Frame(gem_box, bg=PANEL_SUBTLE)
        g_head.pack(fill="x", padx=12, pady=(8, 6))

        tk.Label(g_head, text="Gemini", bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 font=("Segoe UI", 10, "bold")).pack(side="left")
        tk.Label(g_head, text="Gemini Flash, Pro, 3.x", bg=PANEL_SUBTLE, fg=TEXT_DIM,
                 font=("Segoe UI", 8)).pack(side="left", padx=(8, 0))

        g_bars = tk.Frame(gem_box, bg=PANEL_SUBTLE)
        g_bars.pack(fill="x", padx=12, pady=(0, 10))

        self.gem_weekly_bar = self._quota_bar(g_bars, 0, T("Недельный лимит", "Weekly Limit"))
        self.gem_5h_bar = self._quota_bar(g_bars, 1, T("Лимит 5 часов", "5-Hour Limit"))

        # Box 2: Claude & GPT Models
        claude_box = tk.Frame(q_grid, bg=PANEL_SUBTLE, highlightbackground=BORDER, highlightthickness=1)
        claude_box.pack(fill="x", pady=(0, 4))

        c_head = tk.Frame(claude_box, bg=PANEL_SUBTLE)
        c_head.pack(fill="x", padx=12, pady=(8, 6))

        tk.Label(c_head, text="Claude & GPT", bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                 font=("Segoe UI", 10, "bold")).pack(side="left")
        tk.Label(c_head, text="Claude Opus, Claude Sonnet, GPT-OSS", bg=PANEL_SUBTLE, fg=TEXT_DIM,
                 font=("Segoe UI", 8)).pack(side="left", padx=(8, 0))

        c_bars = tk.Frame(claude_box, bg=PANEL_SUBTLE)
        c_bars.pack(fill="x", padx=12, pady=(0, 10))

        self.claude_weekly_bar = self._quota_bar(c_bars, 0, T("Недельный лимит", "Weekly Limit"))
        self.claude_5h_bar = self._quota_bar(c_bars, 1, T("Лимит 5 часов", "5-Hour Limit"))

        # 4. Card: Account Profile & Google Tier
        acc_card = self._card(root, title=T("Профиль аккаунта и тариф Google", "Account Profile & Google Tier"),
                             fill="x", padx=18, pady=(0, 12))

        self.account_bar = tk.Frame(acc_card, bg=PANEL_SUBTLE, padx=12, pady=8)
        self.account_bar.pack(fill="x", padx=14, pady=(0, 12))

        self.account_icon = tk.Label(self.account_bar, text="●", bg=PANEL_SUBTLE, fg=ACCENT, font=("Segoe UI", 8))
        self.account_icon.pack(side="left", padx=(0, 6))

        self.account_label = tk.Label(self.account_bar,
                                      text=T("Загружаем тариф и проект Google…", "Loading Google account tier and project…"),
                                      bg=PANEL_SUBTLE, fg=TEXT_MUTED, font=("Segoe UI", 9), anchor="w")
        self.account_label.pack(side="left", fill="x", expand=True)
        wrap_to_width(self.account_label)

        # 4.5 Card: Gemini 4 Unlock (Web Bridge)
        unlock_card = self._card(web_root, title=T("Gemini 4 через веб-мост", "Gemini 4 Unlock (Web Bridge)"),
                                 badge="Gemini Web",
                                 accent=ACCENT_CYAN, fill="x", padx=14, pady=(0, 12))

        self.unlock_bar = tk.Frame(unlock_card, bg=PANEL_SUBTLE, padx=12, pady=8)
        self.unlock_bar.pack(fill="x", padx=14, pady=(0, 12))

        self.unlock_icon = tk.Label(self.unlock_bar, text="●", bg=PANEL_SUBTLE, fg=TEXT_DIM, font=("Segoe UI", 8))
        self.unlock_icon.pack(side="left", padx=(0, 6))

        self.unlock_label = tk.Label(self.unlock_bar,
                                     text=T("Gemini 4 через веб-мост (режим Argon). Проверяем локальный сервер…",
                                            "Gemini 4 via web bridge (Argon mode). Checking the local server…"),
                                     bg=PANEL_SUBTLE, fg=WARNING, font=("Segoe UI", 9), anchor="w",
                                     wraplength=460, justify="left")
        self.unlock_label.pack(side="left", fill="x", expand=True)
        wrap_to_width(self.unlock_label)

        u_btn_row = tk.Frame(unlock_card, bg=PANEL)
        u_btn_row.pack(fill="x", padx=14, pady=(0, 8))
        self._secondary_button(u_btn_row, T("Войти в Gemini", "Sign in to Gemini"), self.connect_gemini).pack(side="left")
        self._secondary_button(u_btn_row, T("Обновить статус API", "Refresh API Status"), self.refresh_all).pack(side="left", padx=(8, 0))

        unlock_hint = tk.Label(unlock_card,
                               text=T("Использует вашу сессию gemini.google.com. Настройка подключения — в «Настройки и лимиты» → Gemini 4 Unlock. "
                                      "Доступность Gemini 4 зависит от аккаунта Google; выбор версии эвристический и не гарантирует модель.",
                                      "Uses your gemini.google.com session. Configure the connection in Settings & Limits → Gemini 4 Unlock. "
                                      "Gemini 4 availability depends on the Google account; version selection is heuristic and not guaranteed."),
                               bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9), justify="left", anchor="w")
        unlock_hint.pack(fill="x", padx=14, pady=(0, 12))
        wrap_to_width(unlock_hint)

        # 4.6 Card: Gemini Web Models
        def _web_model_btn(h):
            self._icon_button(h, T("Копировать ID модели", "Copy Model ID"), self.copy_model).pack(side="right")

        web_models_card = self._card(web_root, title=T("Веб-модели Gemini", "Gemini Web Models"), badge="gemini.google.com",
                                     right_widget_fn=_web_model_btn, key="web", fill="x", padx=14, pady=(0, 12))

        self.web_model_list = self._model_listbox(web_models_card)

        self.web_models_tip_text = T("web/* — чистый чат через gemini.google.com. Агентский режим "
                                     "(web/<alias>-agent) ОЧЕНЬ ненадёжен: лимит длины ответа и текстовая "
                                     "эмуляция инструментов. Включается в «Настройки» → «Агент».",
                                     "web/* — plain chat through gemini.google.com. Agent mode "
                                     "(web/<alias>-agent) is VERY unreliable: response-length cap and text-protocol "
                                     "tool emulation. Enable it in Settings → Agent.")
        web_tip = tk.Label(web_models_card, text=T("Загрузка каталога веб-моделей…", "Loading web model catalog…"),
                           bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9), anchor="w")
        web_tip.pack(fill="x", padx=14, pady=(0, 10))
        wrap_to_width(web_tip)
        self.web_models_tip = web_tip

        # 5. Card: Cloud Code Models
        def _cloud_model_btn(h):
            self._icon_button(h, T("Копировать ID модели", "Copy Model ID"), self.copy_model).pack(side="right")

        models_card = self._card(root, title=T("Облачные модели", "Cloud Models"),
                                 badge=T("Cloud Code · нативные tools", "Cloud Code · native tools"),
                                 right_widget_fn=_cloud_model_btn, key="cloud", fill="x", padx=18, pady=(0, 12))

        self.cloud_model_list = self._model_listbox(models_card)

        self.models_tip_text = T("cloud/* — нативные tools Cloud Code. Выберите модель и нажмите «Копировать ID модели».",
                                 "cloud/* — native Cloud Code tools. Select a model and press Copy Model ID.")
        self.models_tip_empty = T("Сервер остановлен — запустите его, чтобы загрузить каталог моделей.",
                                  "Server is stopped — start it to load the model catalog.")
        tip_lbl = tk.Label(models_card, text=T("Проверяем каталог моделей…", "Checking the model catalog…"),
                           bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9), anchor="w")
        tip_lbl.pack(fill="x", padx=14, pady=(0, 10))
        wrap_to_width(tip_lbl)
        self.cloud_models_tip = tip_lbl

        # 5b. Card: detected Antigravity installations (path override, like AGUnlocker)
        installs_card = self._card(root, title=T("Найденные установки Antigravity", "Detected Antigravity installations"),
                                   fill="x", padx=18, pady=(0, 12))
        installs_desc = tk.Label(installs_card,
                                 text=T("Пути к клиентам Antigravity. ✓ — найден и корректен, ○ — не найден. "
                                        "Карандаш задаёт нестандартный путь; настройка хранится отдельно от config.json.",
                                        "Paths to Antigravity clients. ✓ — found and valid, ○ — not found. "
                                        "The pencil sets a custom path; stored separately from config.json."),
                                 bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9), anchor="w")
        installs_desc.pack(fill="x", padx=14, pady=(0, 8))
        wrap_to_width(installs_desc)
        detected = detect_install_paths()
        overrides = read_install_overrides()
        self._install_rows = {}
        for key, ru_name, en_name in INSTALL_SPECS:
            self._install_row(installs_card, key, T(ru_name, en_name), overrides.get(key) or detected.get(key) or "")
        tk.Frame(installs_card, bg=PANEL, height=4).pack(fill="x")

        # 6. Connection tab: credentials, quick example, startup footer
        conn = self._card(conn_root, title=T("Данные подключения", "Connection Credentials"), fill="x", padx=18, pady=(0, 12))

        # Base URL
        row1 = tk.Frame(conn, bg=PANEL)
        row1.pack(fill="x", padx=14, pady=(0, 8))

        tk.Label(row1, text="Base URL", bg=PANEL, fg=TEXT_MUTED, width=12, anchor="w",
                 font=("Segoe UI", 9)).pack(side="left")

        self.url_var = tk.StringVar(value=BASE_URL)
        url_entry = tk.Entry(row1, textvariable=self.url_var, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                             relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                             highlightbackground=BORDER, highlightthickness=1)
        url_entry.pack(side="left", fill="x", expand=True, ipady=5, padx=(0, 6))
        url_entry.configure(state="readonly", readonlybackground=PANEL_SUBTLE)
        self._copy_button(row1, self.url_var)

        # Port (Base URL is derived from it)
        row1b = tk.Frame(conn, bg=PANEL)
        row1b.pack(fill="x", padx=14, pady=(0, 10))
        tk.Label(row1b, text=T("Порт сервера", "Server port"), bg=PANEL, fg=TEXT_MUTED, width=12, anchor="w",
                 font=("Segoe UI", 9)).pack(side="left")
        self.port_var = tk.StringVar(value=str(PORT))
        port_entry = tk.Entry(row1b, textvariable=self.port_var, width=8, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                              relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                              highlightbackground=BORDER, highlightthickness=1)
        port_entry.pack(side="left", ipady=5)
        action_button(row1b, T("Сохранить и перезапустить", "Save & restart"), self.apply_port,
                      compact=True).pack(side="left", padx=(8, 0))
        tk.Label(row1b, text=T("Base URL меняется вместе с портом", "Base URL follows the port"),
                 bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8)).pack(side="left", padx=(8, 0))

        # API Key
        row2 = tk.Frame(conn, bg=PANEL)
        row2.pack(fill="x", padx=14, pady=(0, 12))

        tk.Label(row2, text="API Key", bg=PANEL, fg=TEXT_MUTED, width=12, anchor="w",
                 font=("Segoe UI", 9)).pack(side="left")

        self.key_var = tk.StringVar(value=API_KEY or T("(не создан — запустите сервер)", "(not generated — start server)"))
        self.key_entry = tk.Entry(row2, textvariable=self.key_var, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                                  relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                                  show="•", highlightbackground=BORDER, highlightthickness=1)
        self.key_entry.pack(side="left", fill="x", expand=True, ipady=5, padx=(0, 6))
        self._copy_button(row2, self.key_var)

        self.btn_show = self._icon_button(row2, T("Показать", "Show"), self.toggle_key)
        self.btn_show.pack(side="left", padx=(4, 0))

        # 7. Card: Quick Example (cURL)
        def _ex_btn(h):
            self._icon_button(h, T("Копировать cURL", "Copy cURL"), self.copy_example).pack(side="right")

        ex_card = self._card(conn_root, title=T("Быстрый пример (cURL)", "Quick Example (cURL)"), right_widget_fn=_ex_btn,
                             fill="x", padx=18, pady=(0, 12))

        self.example_text = tk.Text(ex_card, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY, relief="flat",
                                    height=6, font=("Consolas", 8), insertbackground=ACCENT,
                                    wrap="word", highlightbackground=BORDER, highlightthickness=1)
        self.example_text.pack(fill="x", padx=14, pady=(0, 12))
        self.example_text.insert("1.0", self._example())
        self.example_text.configure(state="disabled")

        # 8. Footer (Windows Startup Autolaunch)
        foot = tk.Frame(conn_root, bg=BG)
        foot.pack(fill="x", padx=18, pady=(0, 14))

        self.startup_var = tk.BooleanVar(value=os.path.exists(self._startup_lnk_path()))
        cb = tk.Checkbutton(foot, text=T("Запускать Antigravity API свёрнутым при старте Windows",
                                         "Start Antigravity API minimized on Windows startup"),
                            variable=self.startup_var, command=self.toggle_startup,
                            bg=BG, fg=TEXT_MUTED, selectcolor=PANEL_SUBTLE,
                            activebackground=BG, activeforeground=TEXT_PRIMARY,
                            highlightthickness=0, font=("Segoe UI", 9))
        cb.pack(side="left")

        workspace.pack(fill="both", expand=True)
        self.main_tabs.pack(fill="both", expand=True, padx=18, pady=(0, 12))

    # ---------------- Buttons & UI Helpers ----------------

    def _primary_button(self, parent, text, cmd):
        return action_button(parent, text, cmd, primary=True)

    def _secondary_button(self, parent, text, cmd):
        return action_button(parent, text, cmd)

    def _icon_button(self, parent, text, cmd):
        return action_button(parent, text, cmd, compact=True)

    def _copy_button(self, parent, var):
        def _do_copy():
            self.copy_var(var)
            b.configure(text=T("Скопировано", "Copied"), fg=SUCCESS)
            self.after(1200, lambda: b.configure(text=T("Копировать", "Copy"), fg=TEXT_PRIMARY) if b.winfo_exists() else None)

        b = action_button(parent, T("Копировать", "Copy"), _do_copy, compact=True)
        b.pack(side="left")
        return b

    # ---------------- Quota Bars in Percent (%) ----------------

    def _quota_bar(self, grid, col, title):
        cell = tk.Frame(grid, bg=PANEL_SUBTLE)
        cell.grid(row=0, column=col, sticky="nwe", padx=(0, 16 if col == 0 else 0), pady=4)
        grid.columnconfigure(col, weight=1, uniform="quota")

        hdr = tk.Frame(cell, bg=PANEL_SUBTLE)
        hdr.pack(fill="x", pady=(0, 6))
        tk.Label(hdr, text=title, bg=PANEL_SUBTLE, fg=TEXT_MUTED,
                 font=("Segoe UI", 9)).pack(side="left")
        val_lbl = tk.Label(hdr, text="—", bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                           font=("Consolas", 10, "bold"))
        val_lbl.pack(side="right")

        canvas = tk.Canvas(cell, bg=PANEL_SUBTLE, highlightthickness=0, height=8, width=100)
        canvas.pack(fill="x")
        sub_lbl = tk.Label(cell, text=T("Ожидаем данные…", "Waiting for data…"), bg=PANEL_SUBTLE,
                           fg=TEXT_MUTED, font=("Segoe UI", 9), anchor="w")
        sub_lbl.pack(fill="x", pady=(6, 0))
        wrap_to_width(sub_lbl)
        bar = {"canvas": canvas, "value": val_lbl, "sub": sub_lbl,
               "state": (None, T("Ожидаем данные…", "Waiting for data…"), False)}
        canvas.bind("<Configure>", lambda e: self._set_quota_bar(bar, *bar["state"]))
        return bar

    def _set_quota_bar(self, bar, percent, reset_text, disabled=False):
        bar["state"] = (percent, reset_text, disabled)
        c = bar["canvas"]
        c.delete("all")
        w = max(1, c.winfo_width())
        c.create_rectangle(0, 0, w, 8, fill=MUTED_BAR, outline="")

        if disabled:
            bar["value"].configure(text=T("Отключено", "Disabled"), fg=TEXT_MUTED)
            bar["sub"].configure(text=reset_text or T("Квота недоступна", "Quota unavailable"), fg=TEXT_MUTED)
            return

        try:
            pct = float(percent) if percent is not None else None
            if pct is not None and not (0 <= pct <= 100):
                pct = None
        except (ValueError, TypeError):
            pct = None
        if pct is None:
            bar["value"].configure(text="—", fg=TEXT_MUTED)
            bar["sub"].configure(text=reset_text or T("Нет данных о квоте", "No quota data"), fg=TEXT_MUTED)
            return

        color = ACCENT if pct >= 50 else WARNING if pct >= 20 else DANGER
        if pct > 0:
            c.create_rectangle(0, 0, max(1, int(w * pct / 100)), 8, fill=color, outline="")
        bar["value"].configure(text=f"{pct:.1f}%", fg=TEXT_PRIMARY)
        bar["sub"].configure(text=reset_text or T("Доступно", "Available"), fg=TEXT_MUTED if pct > 0 else DANGER)

    # ---------------- Actions & Event Handlers ----------------

    def open_diagnostic_chat(self):
        if self._diagnostic_dialog is not None and self._diagnostic_dialog.winfo_exists():
            self._diagnostic_dialog.lift()
            self._diagnostic_dialog.focus_set()
            return
        self._diagnostic_dialog = DiagnosticChatDialog(self)

    def open_settings(self):
        if self._settings_dialog is not None and self._settings_dialog.winfo_exists():
            self._settings_dialog.lift()
            self._settings_dialog.focus_set()
            return
        self._settings_dialog = SettingsDialog(self, on_saved=self.refresh_all,
                                               last_result=self._last_limits_result)

    def connect_gemini(self):
        try:
            if not webbrowser.open(GEMINI_URL):
                raise RuntimeError(T("браузер по умолчанию не найден", "default browser not found"))
            self.unlock_label.configure(
                text=T("Gemini открыт в браузере по умолчанию. Войдите в аккаунт, затем скопируйте Cookie вручную (F12 → Network) и вставьте в «Настройки и лимиты» → Gemini 4 Unlock.",
                       "Gemini opened in the default browser. Sign in, then copy the Cookie header manually (F12 → Network) and paste it in Settings & Limits → Gemini 4 Unlock."),
                fg=TEXT_MUTED)
        except Exception as exc:
            messagebox.showerror(T("Браузер Gemini", "Gemini browser"), str(exc))

    def auto_detect_token_gui(self):
        def _worker():
            try:
                res = auto_extract(force=True, out_path=AUTH_FILE)
                return ("OK", res)
            except Exception as e:
                return ("ERR", str(e))

        def _callback(result):
            status, payload = result
            if status == "OK":
                self.account_label.configure(
                    text=T("✓ OAuth-токен успешно перепривязан из Antigravity IDE!",
                           "✓ OAuth token successfully re-linked from Antigravity IDE!"), fg=SUCCESS)
                self.after(2000, self.refresh_limits)
            else:
                self.account_label.configure(text=T(f"✗ Ошибка: {payload[:70]}", f"✗ Error: {payload[:70]}"), fg=DANGER)

        self.account_label.configure(
            text=T("Ищем базу состояния Antigravity IDE…", "Scanning system for Antigravity IDE state database…"),
            fg=WARNING)
        self._call_async(_worker, _callback)

    def copy_var(self, var):
        self.clipboard_clear()
        self.clipboard_append(var.get())

    def toggle_key(self):
        hidden = self.key_entry.cget("show") == "•"
        self.key_entry.configure(show="" if hidden else "•")
        self.btn_show.configure(text=T("Скрыть", "Hide") if hidden else T("Показать", "Show"))

    def copy_model(self):
        lst = self._active_model_list()
        sel = lst.curselection()
        if not sel:
            return
        self.clipboard_clear()
        self.clipboard_append(lst.get(sel[0]).split("  —  ")[0].strip())

    def _example(self):
        key = API_KEY or "<api_key_from_apikey.txt>"
        model = "cloud/gemini-3-flash"
        try:
            if self.cloud_model_list.size() > 0:
                model = self.cloud_model_list.get(0).split("  —  ")[0].strip()
            elif self.web_model_list.size() > 0:
                model = self.web_model_list.get(0).split("  —  ")[0].strip()
        except Exception:
            pass
        return (
            f'Base URL: {BASE_URL}\n'
            f'API-Key:  {key}\n'
            f'Model:    {model}\n\n'
            f'curl {BASE_URL}/chat/completions \\\n'
            f'  -H "Authorization: Bearer {key}" -H "Content-Type: application/json" \\\n'
            f'  -d "{{\\"model\\":\\"{model}\\",\\"messages\\":[{{\\"role\\":\\"user\\",\\"content\\":\\"Hello from Antigravity!\\"}}]}}"'
        )

    def _refresh_example(self):
        self.example_text.configure(state="normal")
        self.example_text.delete("1.0", "end")
        self.example_text.insert("1.0", self._example())
        self.example_text.configure(state="disabled")

    def copy_example(self):
        self.clipboard_clear()
        self.clipboard_append(self.example_text.get("1.0", "end").strip())

    @staticmethod
    def _port_free(port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return True
            except OSError:
                return False

    def apply_port(self):
        global PORT, BASE_URL
        raw = self.port_var.get().strip()
        try:
            port = int(raw)
        except ValueError:
            self.status_text.configure(text=T("Порт должен быть числом", "Port must be a number"), fg=DANGER)
            return
        if not 1 <= port <= 65535:
            self.status_text.configure(text=T("Порт должен быть 1–65535", "Port must be 1–65535"), fg=DANGER)
            return
        cfg = read_config()
        if cfg is None:
            self.status_text.configure(text=T(*CONFIG_DAMAGED_MSG), fg=DANGER)
            return
        current = config_port(cfg, PORT)
        if port != current and not self._port_free(port):
            messagebox.showerror(
                T("Порт занят", "Port in use"),
                T(f"Порт {port} уже занят другой программой. Выберите свободный порт.",
                  f"Port {port} is already used by another program. Choose a free port."))
            return
        if port != current:
            cfg["port"] = port
            if not save_config(cfg):
                self.status_text.configure(text=T("Не удалось записать config.json", "Failed to write config.json"), fg=DANGER)
                return
        was_running = is_running()
        if was_running:
            self.stop_server()
        PORT = port
        BASE_URL = f"http://127.0.0.1:{port}/v1"
        self.url_var.set(BASE_URL)
        self.port_var.set(str(port))
        try:
            self._refresh_example()
        except Exception:
            pass
        if was_running:
            self.status_text.configure(text=T(f"Порт {port}: перезапуск сервера…", f"Port {port}: restarting server…"), fg=WARNING)
            # Слепо стартовать через 700 мс нельзя: старый процесс может ещё
            # держать порт, а новый — упасть с EADDRINUSE и остаться зомби.
            self._await_restart(port, current, 0, 0)
        else:
            self.status_text.configure(text=T(f"Порт {port} сохранён. Запустите сервер.", f"Port {port} saved. Start the server."), fg=SUCCESS)

    def _await_restart(self, new_port, old_port, phase, attempts):
        # phase 0 — ждём, пока порт освободится; phase 1 — ждём /_health.
        if phase == 0:
            if not self._port_free(new_port) and attempts < 30:
                self.after(200, lambda: self._await_restart(new_port, old_port, 0, attempts + 1))
                return
            self.start_server()
            self.after(300, lambda: self._await_restart(new_port, old_port, 1, 0))
            return
        if is_running():
            self._poll_status()
            return
        if attempts < 60:
            self.after(250, lambda: self._await_restart(new_port, old_port, 1, attempts + 1))
            return
        self._rollback_port(old_port, new_port)

    def _rollback_port(self, old_port, new_port):
        global PORT, BASE_URL
        cfg = read_config()
        if cfg is not None:
            cfg["port"] = old_port
            save_config(cfg)
        PORT = old_port
        BASE_URL = f"http://127.0.0.1:{old_port}/v1"
        self.port_var.set(str(old_port))
        self.url_var.set(BASE_URL)
        try:
            self._refresh_example()
        except Exception:
            pass
        self.status_text.configure(
            text=T(f"Сервер не поднялся на порту {new_port}. Порт возвращён на {old_port}.",
                   f"Server did not start on port {new_port}. Port reverted to {old_port}."), fg=DANGER)

    def toggle_server(self):
        if is_running():
            self.stop_server()
        else:
            self.start_server()
        self.after(400, self._poll_status)

    def start_server(self):
        node = find_node()
        if not node:
            self.status_text.configure(text=T("NODE.JS НЕ НАЙДЕН", "NODE.JS NOT FOUND"), fg=DANGER)
            messagebox.showerror(T("Требуется Node.js", "Node.js Required"),
                                 T("Node.js 18+ не найден в PATH.\nУстановите Node.js с https://nodejs.org/",
                                   "Node.js 18+ was not found in PATH.\nPlease install Node.js from https://nodejs.org/"))
            return

        if not os.path.exists(AUTH_FILE):
            try:
                auto_extract(force=False, out_path=AUTH_FILE)
            except Exception as e:
                self.status_text.configure(text=T("НЕТ ТОКЕНА", "TOKEN MISSING"), fg=DANGER)
                self.account_label.configure(
                    text=T(f"Войдите в Antigravity IDE: {str(e)[:60]}", f"Please sign in to Antigravity IDE: {str(e)[:60]}"),
                    fg=DANGER)
                return

        if self.proc and self.proc.poll() is None:
            self.status_text.configure(text=T("Запускается…", "Starting…"), fg=WARNING)
            return
        try:
            with open(LOG_FILE, "ab") as log:
                popen_kwargs = {"cwd": BASE, "stdout": log, "stderr": subprocess.STDOUT}
                if sys.platform == "win32":
                    popen_kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
                self.proc = subprocess.Popen([node, "server.js"], **popen_kwargs)
        except OSError as exc:
            self.account_label.configure(text=T(f"Не удалось запустить сервер: {exc}",
                                                f"Failed to start the server: {exc}"), fg=DANGER)
            self.status_text.configure(text=T("Ошибка запуска", "Start failed"), fg=DANGER)
            return
        self.status_text.configure(text=T("Запускается…", "Starting…"), fg=WARNING)

    def stop_server(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except Exception:
                self.proc.kill()
            self.proc = None
        else:
            pid = pid_on_port()
            # Порт может занимать чужой процесс (другой проект, другой gateway):
            # его нельзя убивать. Останавливаем только свой server.js.
            if pid and is_our_server(pid):
                try:
                    if sys.platform == "win32":
                        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
                    else:
                        import signal
                        os.kill(pid, signal.SIGTERM)
                except Exception:
                    pass
            elif pid:
                self.status_text.configure(
                    text=T("ПОРТ ЗАНЯТ ЧУЖИМ ПРОЦЕССОМ", "PORT BUSY (FOREIGN PROCESS)"), fg=DANGER)
                return
        self.status_text.configure(text=T("ОСТАНОВЛЕН", "STOPPED"), fg=DANGER)

    # ---------------- Windows Startup ----------------

    def _startup_lnk_path(self):
        return os.path.join(
            os.environ.get("APPDATA", ""),
            "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Antigravity API (hidden).lnk",
        )

    def toggle_startup(self):
        lnk = self._startup_lnk_path()
        if self.startup_var.get():
            pythonw = os.path.join(sys.base_prefix, "pythonw.exe")
            if not os.path.exists(pythonw):
                pythonw = sys.executable
            ps = (
                "$ws = New-Object -ComObject WScript.Shell; "
                f"$s = $ws.CreateShortcut('{lnk}'); "
                f"$s.TargetPath = '{pythonw}'; "
                f"$s.Arguments = '\"{os.path.join(BASE, 'app.py')}\" --hidden'; "
                f"$s.WorkingDirectory = '{BASE}'; "
                f"$s.IconLocation = '{ICO_PATH},0'; "
                "$s.Save()"
            )
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)
        else:
            try:
                os.remove(lnk)
            except FileNotFoundError:
                pass
        self.startup_var.set(os.path.exists(lnk))

    # ---------------- Async Polling ----------------

    def _call_async(self, fn, cb):
        # Потокобезопасно: воркер кладёт результат в очередь,
        # главный поток забирает её по таймеру (tkinter не терпит
        # вызовов виджетов и даже .after() из чужих потоков).
        def worker():
            try:
                result = fn()
            except Exception as e:
                result = e
            self._async_queue.put((cb, result))
        threading.Thread(target=worker, daemon=True).start()

    def _drain_async(self):
        try:
            while True:
                cb, result = self._async_queue.get_nowait()
                try:
                    cb(result)
                except Exception:
                    pass
        except queue.Empty:
            pass
        try:
            self.after(300, self._drain_async)
        except Exception:
            pass

    def _poll_status(self):
        if not self._status_inflight:
            self._status_inflight = True
            self._call_async(is_running, self._apply_status)
        self.refresh_limits()

    def _apply_status(self, running):
        global API_KEY
        self._status_inflight = False
        running = running is True
        self._last_running = running
        self.status_dot.delete("all")
        if running:
            self.status_dot.create_oval(1, 1, 9, 9, fill=SUCCESS, outline="")
            self.status_text.configure(text=T("Работает", "Running"), fg=SUCCESS, bg=SUCCESS_BG)
            self.status_pill.configure(bg=SUCCESS_BG, highlightbackground=SUCCESS_BORDER)
            self.status_dot.configure(bg=SUCCESS_BG)
            self.btn_toggle.configure(text=T("Остановить API-сервер", "Stop API Server"), bg=ACCENT,
                                      activebackground=ACCENT_HOVER)
        else:
            self.status_dot.create_oval(1, 1, 9, 9, fill=TEXT_DIM, outline="")
            self.status_text.configure(text=T("Остановлен", "Stopped"), fg=TEXT_MUTED, bg=PANEL_SUBTLE)
            self.status_pill.configure(bg=PANEL_SUBTLE, highlightbackground=BORDER)
            self.status_dot.configure(bg=PANEL_SUBTLE)
            self.btn_toggle.configure(text=T("Запустить API-сервер", "Start API Server"), bg=ACCENT)

        # The server owns the key and rewrites apikey.txt when it changes;
        # the placeholder starts with "(" in both languages.
        new_key = read_api_key()
        if new_key and (new_key != API_KEY or self.key_var.get().startswith("(")):
            API_KEY = new_key
            self.key_var.set(new_key)
            try:
                self._refresh_example()
            except Exception:
                pass

        if running and not self._models_loaded:
            self.refresh_models()
        if not running:
            self._models_loaded = False
            self.unlock_label.configure(text=T("API-сервер остановлен: нажмите «Запустить API-сервер».",
                                               "API server is stopped: press Start API Server."), fg=TEXT_MUTED)
            self.unlock_icon.configure(fg=TEXT_DIM)
            self.account_label.configure(text=T("Запустите сервер для проверки аккаунта.",
                                                "Start the server to check the account."), fg=TEXT_MUTED)
            self.account_icon.configure(fg=TEXT_DIM)
            self.cloud_model_list.delete(0, "end")
            self.web_model_list.delete(0, "end")
            for key in ("cloud", "web"):
                badge = self._card_badges.get(key)
                if badge is not None:
                    badge.configure(text=T("Не загружен", "Not loaded"))
            self.cloud_models_tip.configure(text=self.models_tip_empty, fg=TEXT_MUTED)
            self.web_models_tip.configure(text=self.models_tip_empty, fg=TEXT_MUTED)
            for bar in (self.gem_weekly_bar, self.gem_5h_bar,
                        self.claude_weekly_bar, self.claude_5h_bar):
                self._set_quota_bar(bar, None, T("Сервер остановлен", "Server stopped"))
            self._limits_loaded = False

    def refresh_all(self):
        self._models_loaded = False
        self._poll_status()

    def refresh_limits(self, force=False):
        # /_limits дёргает Google: холодный вызов может занять 10-15с,
        # поэтому таймаут 25с и защита от наложения опросов каждые 2.5с.
        # «Загрузка…» показываем только при первой загрузке или ручном обновлении —
        # иначе бары мерцают каждые 2.5с.
        if self._limits_inflight or (self._last_running is False and not force):
            return
        self._limits_inflight = True
        if force or not getattr(self, "_limits_loaded", False):
            for _bar in (self.gem_weekly_bar, self.gem_5h_bar,
                         self.claude_weekly_bar, self.claude_5h_bar):
                self._set_quota_bar(_bar, None, T("Загрузка…", "Loading…"))

        def _done(result):
            self._limits_inflight = False
            self._apply_limits(result)

        self._call_async(lambda: http_get("/_limits", timeout=25, with_key=True), _done)

    def _apply_limits(self, result):
        bars = (self.gem_weekly_bar, self.gem_5h_bar,
                self.claude_weekly_bar, self.claude_5h_bar)
        if self._last_running is False:
            return
        if isinstance(result, Exception) or not isinstance(result, dict):
            for bar in bars:
                self._set_quota_bar(bar, None, T("Не удалось загрузить квоты. Нажмите «Обновить квоты».",
                                                 "Failed to load quotas. Press Refresh Quotas."))
            self._limits_loaded = True
            self.account_label.configure(text=T("Статус аккаунта недоступен. Проверьте сервер и подключение.",
                                                "Account status unavailable. Check the server and connection."), fg=WARNING)
            self.account_icon.configure(fg=WARNING)
            self.unlock_label.configure(
                text=T("Не удалось получить статус API. Проверьте запуск сервера и нажмите «Обновить статус API».",
                       "Failed to fetch API status. Check that the server is running and press “Refresh API Status”."),
                fg=WARNING)
            self.unlock_icon.configure(fg=WARNING)
            return

        self._last_limits_result = result
        # Reset each window before applying new data, including partial/empty replies.
        for bar in bars:
            self._set_quota_bar(bar, None, T("Google не сообщает данные для этого окна",
                                             "Google reports no data for this window"))
        self._limits_loaded = True

        # 1. Real Server Quotas in Percent (%)
        server_quotas = result.get("serverQuotas") or {}
        groups = server_quotas.get("groups") or []

        group_names = []
        gem_matched = claude_matched = False
        for g in groups:
            key = ((g.get("name") or "") + " " + (g.get("displayName") or "")).lower()
            group_names.append(g.get("displayName") or g.get("name") or "?")
            buckets = g.get("buckets") or []
            is_gemini = "gemini" in key
            is_claude = ("claude" in key or "gpt" in key
                         or "anthropic" in key or "openai" in key)

            for b in buckets:
                w = b.get("window") or ""
                rem_pct = b.get("remainingPercent")
                disabled = b.get("disabled", False)
                res_time = format_reset_time(b.get("resetTime"))
                desc = b.get("description") or ""
                time_label = res_time if res_time else desc

                if is_gemini:
                    if w == "weekly":
                        self._set_quota_bar(self.gem_weekly_bar, rem_pct, time_label, disabled)
                        gem_matched = True
                    elif w == "5h":
                        self._set_quota_bar(self.gem_5h_bar, rem_pct, time_label, disabled)
                        gem_matched = True
                elif is_claude:
                    if w == "weekly":
                        self._set_quota_bar(self.claude_weekly_bar, rem_pct, time_label, disabled)
                        claude_matched = True
                    elif w == "5h":
                        self._set_quota_bar(self.claude_5h_bar, rem_pct, time_label, disabled)
                        claude_matched = True

        # Лимиты Gemini из каталога моделей (fetchAvailableModels → quotaInfo).
        # Группы retrieveUserQuotaSummary группу Gemini отдают не всегда.
        # ВАЖНО: quotaInfo.resetTime совпадает с 5-часовым окном (3p-5h), а не
        # с недельным (3p-weekly), поэтому кладём его в бар «5 часов».
        fams = result.get("quotaFamilies") or {}
        gem_fam = fams.get("gemini") or {}
        if not gem_matched and isinstance(gem_fam.get("percent"), (int, float)):
            res_time = format_reset_time(gem_fam.get("resetTime"))
            n = gem_fam.get("modelCount") or 0
            models_ru = f"{n} моделей"
            models_en = f"{n} models"
            sub = (res_time + " · " + T(models_ru, models_en) if res_time
                   else T(f"{models_ru} в каталоге", f"{models_en} in the catalog"))
            self._set_quota_bar(self.gem_5h_bar, gem_fam["percent"], sub)
            self._set_quota_bar(self.gem_weekly_bar, None,
                                T("Google не отдаёт недельную квоту Gemini — только 5-часовую",
                                  "Google exposes no weekly Gemini quota — only the 5-hour one"))
            gem_matched = True
        # Диагностика: если секция не получила данных — показываем, какие группы реально пришли
        if groups and not gem_matched:
            hint = T("Нет группы Gemini среди: ", "No Gemini group among: ") + ", ".join(group_names[:6])
            self._set_quota_bar(self.gem_weekly_bar, None, hint)
            self._set_quota_bar(self.gem_5h_bar, None, hint)
        if groups and not claude_matched:
            hint = T("Нет группы Claude/GPT среди: ", "No Claude/GPT group among: ") + ", ".join(group_names[:6])
            self._set_quota_bar(self.claude_weekly_bar, None, hint)
            self._set_quota_bar(self.claude_5h_bar, None, hint)
        if groups and (gem_matched or claude_matched):
            self._limits_loaded = True

        # 1b. Quota fetch failed — показываем причину, а не вечное "Waiting…"
        if err_text := (server_quotas.get("error") or ""):
            if not groups:
                for _bar in (self.gem_weekly_bar, self.gem_5h_bar,
                             self.claude_weekly_bar, self.claude_5h_bar):
                    self._set_quota_bar(_bar, None, T(f"Ошибка: {str(err_text)[:90]}", f"Error: {str(err_text)[:90]}"))

        # 2. Account Profile & Tier
        acc = result.get("account") or {}
        if acc.get("error"):
            self.account_label.configure(
                text=T(f"Статус аккаунта: офлайн ({str(acc['error'])[:60]})",
                       f"Account status: Offline ({str(acc['error'])[:60]})"), fg=TEXT_MUTED)
            self.account_icon.configure(fg=TEXT_DIM)
        else:
            tier = acc.get("tier") or "Antigravity"
            proj = acc.get("project") or "default"
            reg = acc.get("region") or "global"
            self.account_label.configure(
                text=T(f"Тариф: {tier}  ·  Проект: {proj}  ·  Регион: {reg}",
                       f"Tier: {tier}  ·  Project: {proj}  ·  Region: {reg}"), fg=TEXT_PRIMARY)
            self.account_icon.configure(fg=SUCCESS)

        # 3. Gemini 4 Unlock (Web Bridge)
        gw = result.get("geminiWeb") or {}
        if not gw:
            self.unlock_label.configure(
                text=T("Сервер не сообщает статус Gemini Web. Перезапустите сервер кнопками Stop / Start API Server.",
                       "The server does not report Gemini Web status. Restart it with Stop / Start API Server."),
                fg=WARNING)
            return
        if gw.get("enabled"):
            count = len(gw.get("models", []))
            label = (gw.get("accountLabel") or "").strip()
            acc = T(f"Аккаунт: {label}. " if label else "Аккаунт: без подписи (задайте в «Настройки и лимиты» → Gemini 4 Unlock). ",
                    f"Account: {label}. " if label else "Account: unlabeled (set it in Settings & Limits → Gemini 4 Unlock). ")
            cookie_ok = T("Куки: загружены." if gw.get("cookieSet") else "Куки: НЕ заданы — генерация не пойдёт.",
                          "Cookies: loaded." if gw.get("cookieSet") else "Cookies: NOT set — generation will fail.")
            color = SUCCESS if gw.get("cookieSet") else WARNING
            self.unlock_label.configure(
                text=acc + cookie_ok + T(f" Доступно {count} веб-моделей Gemini 4. "
                                         "Числовых лимитов веб-интерфейс Google не отдаёт — это отдельный пул от квот Antigravity выше.",
                                         f" {count} Gemini 4 web models available. "
                                         "Google’s web UI exposes no numeric limits — this is a separate pool from the Antigravity quotas above."),
                fg=color,
            )
            self.unlock_icon.configure(fg=color)
        else:
            self.unlock_label.configure(
                text=T("Отключено — включите в «Настройки и лимиты» → Gemini 4 Unlock",
                       "Disabled — enable in Settings & Limits → Gemini 4 Unlock"), fg=TEXT_MUTED)
            self.unlock_icon.configure(fg=TEXT_DIM)

    def refresh_models(self):
        if self._models_inflight:
            return
        self._models_inflight = True
        self.cloud_models_tip.configure(text=T("Загружаем каталог моделей…", "Loading the model catalog…"), fg=TEXT_MUTED)
        self.web_models_tip.configure(text=T("Загружаем каталог моделей…", "Loading the model catalog…"), fg=TEXT_MUTED)
        self._call_async(lambda: http_get("/v1/models", timeout=15, with_key=True), self._apply_models)

    def _apply_models(self, result):
        self._models_inflight = False
        if self._last_running is False:
            return
        if isinstance(result, Exception) or not isinstance(result, dict) or not isinstance(result.get("data"), list):
            self._models_loaded = False
            self.cloud_models_tip.configure(
                text=T("Каталог не загрузился. Проверьте сервер, API-ключ и подключение, затем нажмите «Обновить».",
                       "The catalog failed to load. Check the server, API key and connection, then press Refresh."),
                fg=WARNING)
            self.web_models_tip.configure(
                text=T("Каталог не загрузился. Проверьте сервер, API-ключ и подключение, затем нажмите «Обновить».",
                       "The catalog failed to load. Check the server, API key and connection, then press Refresh."),
                fg=WARNING)
            for key in ("cloud", "web"):
                badge = self._card_badges.get(key)
                if badge is not None:
                    badge.configure(text=T("Недоступен", "Unavailable"))
            return
        models = [m for m in result["data"] if isinstance(m, dict) and isinstance(m.get("id"), str)]
        cloud_models, web_models = split_models(models)
        self.cloud_model_list.delete(0, "end")
        self.web_model_list.delete(0, "end")
        for m in cloud_models:
            self.cloud_model_list.insert("end", format_model_row(m))
        for m in web_models:
            self.web_model_list.insert("end", format_model_row(m))
        self._models_loaded = True
        for key, items in (("cloud", cloud_models), ("web", web_models)):
            badge = self._card_badges.get(key)
            if badge is not None:
                badge.configure(text=T(f"{len(items)} моделей", f"{len(items)} models"))
        merr = (self._last_limits_result or {}).get("modelsError") if isinstance(self._last_limits_result, dict) else None
        if merr and not cloud_models:
            self.cloud_models_tip.configure(
                text=T(f"Каталог API недоступен ({str(merr)[:120]}). Проверьте подключение к Google.",
                       f"API catalog unavailable ({str(merr)[:120]}). Check the connection to Google."),
                fg=WARNING)
        elif not models:
            self.cloud_models_tip.configure(
                text=T("Сервер вернул пустой каталог. Проверьте аккаунт и нажмите «Обновить».",
                       "The server returned an empty catalog. Check the account and press Refresh."), fg=TEXT_MUTED)
        else:
            self.cloud_models_tip.configure(text=self.models_tip_text, fg=TEXT_MUTED)
        if web_models:
            self.web_models_tip.configure(text=self.web_models_tip_text, fg=TEXT_MUTED)
        elif not models:
            self.web_models_tip.configure(
                text=T("Сервер вернул пустой каталог. Проверьте аккаунт и нажмите «Обновить».",
                       "The server returned an empty catalog. Check the account and press Refresh."), fg=TEXT_MUTED)
        else:
            self.web_models_tip.configure(
                text=T("Веб-модели выключены: включите Gemini Web в «Настройки» → «Gemini Web».",
                       "Web models are off: enable Gemini Web in Settings → Gemini Web."), fg=TEXT_MUTED)
        if cloud_models:
            self.cloud_model_list.selection_set(0)
        elif web_models:
            self.web_model_list.selection_set(0)
        self._refresh_example()

    def _loop(self):
        try:
            self._poll_status()
            if self.proc and self.proc.poll() is not None:
                code = self.proc.returncode
                self.proc = None
                self._report_server_exit(code)
        except Exception:
            # Одно исключение не должно навсегда останавливать автообновление.
            pass
        finally:
            try:
                self.after(2500, self._loop)
            except Exception:
                pass

    def _exit_code(self):
        """Код возврата, который панель покажет при следующем тике."""
        try:
            return self.proc.returncode
        except Exception:
            return None

    def _log_tail(self, lines=8):
        """Хвост журнала сервера без API-ключа — его печатают логи шлюза."""
        try:
            with open(LOG_FILE, "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - 2000))
                tail = _decode_console(f.read())
        except OSError:
            return ""
        tail = "\n".join(tail.splitlines()[-lines:])
        return tail.replace(API_KEY, "[ключ скрыт]") if API_KEY else tail

    def _report_server_exit(self, code):
        """Сервер, запущенный панелью, упал: показываем код и хвост лога — иначе причину не найти."""
        tail = self._log_tail() or T("(журнал пуст)", "(log is empty)")
        self.status_text.configure(text=T("Сервер остановился", "Server stopped"), fg=DANGER)
        self.account_label.configure(
            text=T(f"Сервер завершился с кодом {code}. Журнал: {LOG_FILE}",
                   f"The server exited with code {code}. Log: {LOG_FILE}"), fg=DANGER)
        messagebox.showerror(
            T("API-сервер остановился", "API server stopped"),
            T(f"Процесс server.js завершился с кодом {code}.\n\nПоследние строки журнала {LOG_FILE}:\n\n{tail}",
              f"server.js exited with code {code}.\n\nLast lines of {LOG_FILE}:\n\n{tail}"),
            parent=self)

    def _on_close(self):
        # Панель запустила сервер — панель его и останавливает, иначе node
        # продолжает держать порт после закрытия окна.
        try:
            self.stop_server()
        except Exception:
            pass
        try:
            self.destroy()
        except Exception:
            pass


def main():
    hidden = "--hidden" in sys.argv
    selftest = "--selftest" in sys.argv
    if selftest:
        original_lang = read_ui_language()
        assert set_ui_language("en") == "en" and T("да", "yes") == "yes"
        assert set_ui_language("ru") == "ru" and T("да", "yes") == "да"
        set_ui_language(original_lang)

        probe = {"port": 8317, "geminiWeb": {"enabled": True}}
        assert set_theme_config(probe, "dark")["theme"] == "dark"
        assert probe["port"] == 8317 and probe["geminiWeb"]["enabled"] is True
        assert set_theme_config(probe, "unexpected")["theme"] == "light"
        assert set_theme_config({"theme": "dark"}, "dark")["theme"] == "dark"

        sample = [
            {"id": "cloud/gemini-3-flash", "display_name": "Gemini 3 Flash",
             "capabilities": {"tools": "native", "thinking": False}},
            {"id": "web/gemini-4-argon", "provider": "web", "displayName": "Gemini 4 Argon",
             "capabilities": {"tools": "emulated", "thinking": True}},
            {"id": "web/gemini-4", "display_name": "Gemini 4",
             "capabilities": {"tools": "emulated"}},
            {"not": "a model"},
        ]
        cloud, web = split_models(sample)
        assert [m["id"] for m in cloud] == ["cloud/gemini-3-flash"]
        assert [m["id"] for m in web] == ["web/gemini-4-argon", "web/gemini-4"]
        row = format_model_row(sample[0])
        assert row.split("  —  ")[0].strip() == "cloud/gemini-3-flash" and "[native tools]" in row
        row_web = format_model_row(sample[1])
        assert "[VERY unreliable]" in row_web and "[thinking]" in row_web
        assert format_model_row(sample[2]).count("[VERY unreliable]") == 1
    if not selftest and not window_guard.acquire():
        return
    app = App(hidden=hidden)
    if selftest:
        # DPI/Tk-проба: процессы, логику и сеть не трогаем.
        assert app.protocol("WM_DELETE_WINDOW") not in ("", None)
        app.withdraw()
        app.after(1500, app.destroy)
        app.mainloop()
        print("SELFTEST OK", flush=True)
        return
    app.mainloop()


if __name__ == "__main__":
    main()

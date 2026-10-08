# -*- coding: utf-8 -*-
"""
Antigravity API — Desktop Control Panel & Dashboard.

Design Principles (Aligned with official Google Antigravity & IDE aesthetic):
- Deep Space Obsidian theme (#0B0C10 / #141622 / #1B1E2E) with subtle borders (#23273C)
- Antigravity Electric Indigo (#6366F1) and Vibrant Cyan (#38BDF8) accents
- Real Upstream Quota Meters in Percentages (%) directly from Google Cloud Code API
- Clean Main Dashboard focused on real Google quotas, account status, and connection info
- Local Safe Mode Guard & artificial limits moved to Settings as an optional feature
- Fully in English by default
- One-Click IDE Token Auto-Detection & Sync
- Multi-resolution Windows ICO icon support
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from datetime import datetime, timezone

import tkinter as tk
from tkinter import font as tkfont
from tkinter import messagebox

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

# ==================== ANTIGRAVITY COLOR PALETTE ====================
BG = "#0B0C10"              # Deep space obsidian workspace background
PANEL = "#141622"           # Card surface
PANEL_SUBTLE = "#1B1E2E"    # Inner input and badge background
PANEL_HOVER = "#23273C"     # Hover state for interactive items
BORDER = "#23273C"          # Subtle card border
BORDER_LIGHT = "#353B57"    # Highlighted border on focus

TEXT_PRIMARY = "#FFFFFF"    # Crisp white primary text
TEXT_MUTED = "#94A3B8"      # Slate secondary text
TEXT_DIM = "#64748B"        # Dim helper text

# Accents
ACCENT = "#6366F1"          # Electric Indigo (Antigravity primary)
ACCENT_HOVER = "#818CF8"    # Lighter Indigo hover
ACCENT_SUBTLE = "#1E1B4B"   # Translucent indigo pill background
ACCENT_CYAN = "#38BDF8"     # Electric Cyan

# Statuses
SUCCESS = "#10B981"         # Emerald Green (Online / Healthy)
SUCCESS_BG = "#064E3B"
SUCCESS_BORDER = "#047857"

WARNING = "#F59E0B"         # Amber (Quota warning / Cooldown)
WARNING_BG = "#451A03"
WARNING_BORDER = "#B45309"

DANGER = "#EF4444"          # Coral Red (Offline / 429 / Critical)
DANGER_BG = "#450A0A"
DANGER_BORDER = "#B91C1C"

MUTED_BAR = "#2A2E42"       # Background for empty progress bars


def read_config():
    try:
        with open(os.path.join(BASE, "config.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    try:
        with open(os.path.join(BASE, "config.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        return True
    except Exception:
        return False


def read_api_key():
    try:
        with open(os.path.join(BASE, "apikey.txt"), encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


CFG = read_config()
PORT = int(CFG.get("port", 8317))
BASE_URL = f"http://127.0.0.1:{PORT}/v1"
API_KEY = read_api_key()


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


def pid_on_port():
    if sys.platform == "win32":
        try:
            out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10).stdout
            for line in out.splitlines():
                if f":{PORT}" in line and "LISTENING" in line.upper() and "127.0.0.1" in line:
                    parts = line.split()
                    if parts[-1].isdigit():
                        return int(parts[-1])
        except Exception:
            pass
    else:
        try:
            out = subprocess.run(["lsof", f"-ti:{PORT}"], capture_output=True, text=True, timeout=5).stdout.strip()
            if out:
                first = out.split()[0]
                if first.isdigit():
                    return int(first)
        except Exception:
            pass
    return None


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
            return "Refreshing now"
        days = total_seconds // 86400
        hours = (total_seconds % 86400) // 3600
        mins = (total_seconds % 3600) // 60
        if days > 0:
            return f"Resets in {days}d {hours}h"
        elif hours > 0:
            return f"Resets in {hours}h {mins}m"
        else:
            return f"Resets in {mins}m"
    except Exception:
        return str(iso_str)


# ==================== SETTINGS DIALOG (OPTIONAL LIMITS & GUARD) ====================

class SettingsDialog(tk.Toplevel):
    """In-app configuration dialog for optional rate limits and Safe Mode guard."""

    def __init__(self, parent, on_saved=None, last_result=None):
        super().__init__(parent)
        self.title("Settings & Optional Guard Limits")
        self.configure(bg=BG)
        self.geometry("560x700")
        self.minsize(500, 600)
        self.transient(parent)
        self.grab_set()
        self.on_saved = on_saved
        self.last_result = last_result or {}

        if os.path.exists(ICO_PATH):
            try:
                self.iconbitmap(ICO_PATH)
            except Exception:
                pass

        self._cfg = read_config()
        self._safe = self._cfg.get("safeMode", {})
        self._build_ui()

    def _build_ui(self):
        # Header
        head = tk.Frame(self, bg=BG)
        head.pack(fill="x", padx=20, pady=(18, 10))

        tk.Label(head, text="SETTINGS & LIMITS", bg=BG, fg=TEXT_PRIMARY,
                 font=("Segoe UI", 12, "bold")).pack(side="left")
        tk.Label(head, text="Optional Guard", bg=ACCENT_SUBTLE, fg=ACCENT_HOVER,
                 font=("Segoe UI", 8, "bold"), padx=6, pady=2).pack(side="left", padx=(10, 0))

        sub = tk.Label(self, text="Configure optional client-side rate limits. By default, requests are sent directly to Google Cloud without local throttles or token blocks.",
                       bg=BG, fg=TEXT_MUTED, font=("Segoe UI", 8), wraplength=510, justify="left")
        sub.pack(anchor="w", padx=20, pady=(0, 12))

        # Main Scrollable Form Container
        canvas = tk.Canvas(self, bg=BG, highlightthickness=0)
        vsb = tk.Scrollbar(self, orient="vertical", command=canvas.yview, bg=PANEL, troughcolor=BG,
                           relief="flat", activebackground=ACCENT, width=8)
        form_root = tk.Frame(canvas, bg=BG)
        win = canvas.create_window((0, 0), window=form_root, anchor="nw")

        def _on_form_config(e):
            canvas.configure(scrollregion=canvas.bbox("all"))

        def _on_canvas_config(e):
            canvas.itemconfigure(win, width=e.width)

        form_root.bind("<Configure>", _on_form_config)
        canvas.bind("<Configure>", _on_canvas_config)

        def _on_wheel(e):
            canvas.yview_scroll(-1 if e.delta > 0 else 1, "units")

        canvas.bind_all("<MouseWheel>", _on_wheel)
        canvas.pack(side="top", fill="both", expand=True, padx=(20, 10), pady=(0, 10))
        vsb.pack(side="right", fill="y")

        # 1. Safe Mode Guard Toggle Card
        guard_card = tk.Frame(form_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        guard_card.pack(fill="x", pady=(0, 12))

        cb_frame = tk.Frame(guard_card, bg=PANEL)
        cb_frame.pack(fill="x", padx=14, pady=12)

        self.var_enabled = tk.BooleanVar(value=self._safe.get("enabled", False))
        cb = tk.Checkbutton(cb_frame, text="Enable Local Rate Limit & Safe Mode Guard (Optional)",
                            variable=self.var_enabled, bg=PANEL, fg=TEXT_PRIMARY,
                            selectcolor=PANEL_SUBTLE, activebackground=PANEL,
                            activeforeground=TEXT_PRIMARY, highlightthickness=0,
                            font=("Segoe UI", 9, "bold"))
        cb.pack(anchor="w")

        hint = tk.Label(cb_frame, text="When disabled (recommended), requests are handled directly by Google's backend without artificial local 429 lockouts or daily token cutoffs. Enable this only if you want your local proxy to artificially cap usage.",
                        bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), wraplength=480, justify="left")
        hint.pack(anchor="w", pady=(4, 0))

        # 2. Limit Parameters Card
        lim_card = tk.Frame(form_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        lim_card.pack(fill="x", pady=(0, 12))

        l_head = tk.Frame(lim_card, bg=PANEL)
        l_head.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(l_head, text="GUARD PARAMETERS (ACTIVE WHEN GUARD IS ENABLED)", bg=PANEL, fg=TEXT_MUTED,
                 font=("Segoe UI", 8, "bold")).pack(side="left")

        sep = tk.Frame(lim_card, bg=BORDER, height=1)
        sep.pack(fill="x", padx=14, pady=(0, 10))

        self.entries = {}
        fields = [
            ("maxRequestsPerMinute", "Max Requests / Minute (RPM)", str(self._safe.get("maxRequestsPerMinute", 60)), "Limits burst request frequency"),
            ("maxRequestsPerHour", "Max Requests / Hour", str(self._safe.get("maxRequestsPerHour", 600)), "Caps hourly generation volume"),
            ("maxRequestsPerDay", "Max Requests / Day", str(self._safe.get("maxRequestsPerDay", 3000)), "Daily request ceiling (resets at 00:00 UTC)"),
            ("maxTokensPerDay", "Max Tokens / Day", str(self._safe.get("maxTokensPerDay", 50000000)), "Daily token volume ceiling"),
            ("minIntervalMs", "Min Interval Between Requests (ms)", str(self._safe.get("minIntervalMs", 200)), "Minimum pause between requests to prevent bot spikes"),
            ("maxConcurrent", "Max Concurrent Requests", str(self._safe.get("maxConcurrent", 4)), "Parallel request concurrency limit"),
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

        # 3. Local Consumption History Card (Optional Stats)
        loc = self.last_result.get("local", {})
        stat_card = tk.Frame(form_root, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        stat_card.pack(fill="x", pady=(0, 12))

        s_head = tk.Frame(stat_card, bg=PANEL)
        s_head.pack(fill="x", padx=14, pady=(10, 6))
        tk.Label(s_head, text="LOCAL USAGE METRICS (INFORMATIONAL)", bg=PANEL, fg=TEXT_MUTED,
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

        tk.Label(row_stat, text=f"Today: {req_today} requests, {tok_today:,} tokens",
                 bg=PANEL, fg=TEXT_PRIMARY, font=("Segoe UI", 9)).pack(side="left")
        tk.Label(row_stat, text=f"7 Days: {week_req} requests, {week_tok:,} tokens",
                 bg=PANEL, fg=TEXT_MUTED, font=("Segoe UI", 9)).pack(side="right")

        # Feedback & Save Buttons (Sticky at bottom)
        foot = tk.Frame(self, bg=BG)
        foot.pack(fill="x", padx=20, pady=(6, 16))

        self.status_lbl = tk.Label(foot, text="", bg=BG, fg=SUCCESS, font=("Segoe UI", 9))
        self.status_lbl.pack(side="left")

        btn_save = tk.Label(foot, text="Save & Apply", bg=ACCENT, fg="#FFFFFF",
                            font=("Segoe UI", 9, "bold"), padx=16, pady=7, cursor="hand2")
        btn_save.pack(side="right")
        btn_save.bind("<Button-1>", lambda e: self._save())
        btn_save.bind("<Enter>", lambda e: btn_save.configure(bg=ACCENT_HOVER))
        btn_save.bind("<Leave>", lambda e: btn_save.configure(bg=ACCENT))

        btn_cancel = tk.Label(foot, text="Cancel", bg=PANEL_SUBTLE, fg=TEXT_MUTED,
                              font=("Segoe UI", 9), padx=14, pady=7, cursor="hand2",
                              highlightbackground=BORDER, highlightthickness=1)
        btn_cancel.pack(side="right", padx=(0, 10))
        btn_cancel.bind("<Button-1>", lambda e: self.destroy())
        btn_cancel.bind("<Enter>", lambda e: btn_cancel.configure(bg=PANEL_HOVER, fg=TEXT_PRIMARY))
        btn_cancel.bind("<Leave>", lambda e: btn_cancel.configure(bg=PANEL_SUBTLE, fg=TEXT_MUTED))

    def _save(self):
        new_safe = {"enabled": self.var_enabled.get()}
        for k, var in self.entries.items():
            val = var.get().strip().replace(" ", "").replace("_", "")
            try:
                new_safe[k] = int(val)
            except ValueError:
                self.status_lbl.configure(text=f"Invalid number for {k}", fg=DANGER)
                return

        # 1. Update config.json
        cfg = read_config()
        cfg["safeMode"] = { **(cfg.get("safeMode", {})), **new_safe }
        if not save_config(cfg):
            self.status_lbl.configure(text="Failed to write config.json", fg=DANGER)
            return

        # 2. Push to live server if running
        if is_running():
            try:
                res = http_post("/_config", {"safeMode": new_safe}, timeout=2.0, with_key=True)
                if res.get("ok"):
                    self.status_lbl.configure(text="✓ Saved & applied dynamically!", fg=SUCCESS)
                else:
                    self.status_lbl.configure(text="✓ Saved to config.json", fg=SUCCESS)
            except Exception:
                self.status_lbl.configure(text="✓ Saved to config.json", fg=SUCCESS)
        else:
            self.status_lbl.configure(text="✓ Saved to config.json", fg=SUCCESS)

        if self.on_saved:
            self.after(500, self.on_saved)
        self.after(900, self.destroy)


# ==================== MAIN DASHBOARD APPLICATION ====================

class App(tk.Tk):
    def __init__(self, hidden=False):
        super().__init__()
        self.title("Antigravity API")
        self.configure(bg=BG)
        self.geometry("700x780")
        self.minsize(580, 520)
        self.proc = None
        self._models_loaded = False
        self._last_running = None
        self._logo_image = None
        self._last_limits_result = {}

        if os.path.exists(ICO_PATH):
            try:
                self.iconbitmap(ICO_PATH)
            except Exception:
                pass

        # Check and auto-extract token on first run if missing
        self._check_first_run_auth()

        self._build()
        self._poll_status()
        self.after(2500, self._loop)

        if hidden:
            self.withdraw()

    def _check_first_run_auth(self):
        global API_KEY
        if not os.path.exists(AUTH_FILE):
            try:
                auto_extract(force=False, out_path=AUTH_FILE)
            except Exception:
                pass
        if not API_KEY:
            API_KEY = read_api_key()

    # ---------------- Scrollable Workspace ----------------

    def _scrollable(self, parent):
        canvas = tk.Canvas(parent, bg=BG, highlightthickness=0)
        vsb = tk.Scrollbar(parent, orient="vertical", command=canvas.yview, bg=PANEL, troughcolor=BG,
                           relief="flat", activebackground=ACCENT, width=10)
        inner = tk.Frame(canvas, bg=BG)
        win = canvas.create_window((0, 0), window=inner, anchor="nw")

        def _on_inner_config(e):
            canvas.configure(scrollregion=canvas.bbox("all"))

        def _on_canvas_config(e):
            canvas.itemconfigure(win, width=e.width)

        inner.bind("<Configure>", _on_inner_config)
        canvas.bind("<Configure>", _on_canvas_config)

        def _on_wheel(e):
            canvas.yview_scroll(-1 if e.delta > 0 else 1, "units")

        canvas.bind_all("<MouseWheel>", _on_wheel)
        canvas.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        return inner

    # ---------------- Styled Card ----------------

    def _card(self, parent, title=None, badge=None, right_widget_fn=None, **pack):
        f = tk.Frame(parent, bg=PANEL, highlightbackground=BORDER, highlightthickness=1)
        f.pack(**pack)

        if title or right_widget_fn:
            head = tk.Frame(f, bg=PANEL)
            head.pack(fill="x", padx=14, pady=(10, 6))

            title_row = tk.Frame(head, bg=PANEL)
            title_row.pack(side="left")

            if title:
                tk.Label(title_row, text=title.upper(), bg=PANEL, fg=TEXT_MUTED,
                         font=("Segoe UI", 8, "bold")).pack(side="left")

            if badge:
                b_lbl = tk.Label(title_row, text=badge, bg=ACCENT_SUBTLE, fg=ACCENT_HOVER,
                                 font=("Segoe UI", 7, "bold"), padx=6, pady=1)
                b_lbl.pack(side="left", padx=(8, 0))

            if right_widget_fn:
                right_widget_fn(head)

            sep = tk.Frame(f, bg=BORDER, height=1)
            sep.pack(fill="x", padx=14, pady=(2, 8))

        return f

    # ---------------- Build GUI ----------------

    def _build(self):
        root = self._scrollable(self)

        # 1. Header (Brand Logo + Live Status Pill Badge)
        head_card = tk.Frame(root, bg=BG)
        head_card.pack(fill="x", padx=18, pady=(16, 12))

        title_box = tk.Frame(head_card, bg=BG)
        title_box.pack(side="left", fill="y")

        if HAS_PIL and os.path.exists(LOGO_PNG):
            try:
                img = Image.open(LOGO_PNG).resize((36, 36), Image.Resampling.LANCZOS)
                self._logo_image = ImageTk.PhotoImage(img)
                logo_lbl = tk.Label(title_box, image=self._logo_image, bg=BG)
                logo_lbl.pack(side="left", padx=(0, 10))
            except Exception:
                pass

        title_text_box = tk.Frame(title_box, bg=BG)
        title_text_box.pack(side="left", anchor="w")

        title_lbl = tk.Label(title_text_box, text="ANTIGRAVITY", bg=BG, fg=TEXT_PRIMARY,
                             font=("Segoe UI", 13, "bold"))
        title_lbl.pack(side="left")

        sub_lbl = tk.Label(title_text_box, text="API", bg=BG, fg=ACCENT_CYAN,
                           font=("Segoe UI", 13, "bold"))
        sub_lbl.pack(side="left", padx=(4, 0))

        tag_lbl = tk.Label(title_text_box, text="v1.5", bg=PANEL_SUBTLE, fg=TEXT_MUTED,
                           font=("Segoe UI", 8), padx=5, pady=0)
        tag_lbl.pack(side="left", padx=(8, 0))

        # Status Pill Badge
        self.status_pill = tk.Frame(head_card, bg=PANEL_SUBTLE, highlightbackground=BORDER, highlightthickness=1)
        self.status_pill.pack(side="right", pady=2)

        self.status_dot = tk.Canvas(self.status_pill, width=10, height=10, bg=PANEL_SUBTLE, highlightthickness=0)
        self.status_dot.pack(side="left", padx=(8, 4), pady=5)
        self.status_text = tk.Label(self.status_pill, text="CHECKING", bg=PANEL_SUBTLE, fg=TEXT_MUTED,
                                    font=("Segoe UI", 9, "bold"), padx=4)
        self.status_text.pack(side="left", padx=(0, 8))

        # 2. Action Controls Bar
        actions_bar = tk.Frame(root, bg=BG)
        actions_bar.pack(fill="x", padx=18, pady=(0, 12))

        self.btn_toggle = self._primary_button(actions_bar, "Start API Server", self.toggle_server)
        self.btn_toggle.pack(side="left")

        self.btn_refresh = self._secondary_button(actions_bar, "Refresh", self.refresh_all)
        self.btn_refresh.pack(side="left", padx=(8, 0))

        self.btn_settings = self._secondary_button(actions_bar, "Settings & Limits", self.open_settings)
        self.btn_settings.pack(side="left", padx=(8, 0))

        self.btn_auto_token = self._secondary_button(actions_bar, "Re-link IDE Token", self.auto_detect_token_gui)
        self.btn_auto_token.pack(side="left", padx=(8, 0))

        self.btn_web = self._secondary_button(actions_bar, "Web Monitor", lambda: webbrowser.open(f"http://127.0.0.1:{PORT}/"))
        self.btn_web.pack(side="left", padx=(8, 0))

        # 3. Card: REAL UPSTREAM MODEL QUOTAS (in Percent %)
        def _quota_head(h):
            self._icon_button(h, "Refresh Quotas", self.refresh_limits).pack(side="right")

        q_card = self._card(root, title="Upstream Model Quotas", badge="Google Cloud Code Quotas",
                            right_widget_fn=_quota_head, fill="x", padx=18, pady=(0, 12))

        q_desc = tk.Label(q_card, text="Actual server-side percentage quotas retrieved directly from Google Cloud Code upstream.",
                          bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), anchor="w")
        q_desc.pack(fill="x", padx=14, pady=(0, 8))

        # Two Family Groups: Gemini Models & Claude/GPT Models
        q_grid = tk.Frame(q_card, bg=PANEL)
        q_grid.pack(fill="x", padx=14, pady=(0, 10))

        # Box 1: Gemini Models
        gem_box = tk.Frame(q_grid, bg=PANEL_SUBTLE, highlightbackground=BORDER, highlightthickness=1)
        gem_box.pack(fill="x", pady=(0, 8))

        g_head = tk.Frame(gem_box, bg=PANEL_SUBTLE)
        g_head.pack(fill="x", padx=12, pady=(8, 6))

        tk.Label(g_head, text="● GEMINI MODELS", bg=PANEL_SUBTLE, fg=ACCENT_CYAN,
                 font=("Segoe UI", 9, "bold")).pack(side="left")
        tk.Label(g_head, text="Gemini Flash, Pro, 3.x", bg=PANEL_SUBTLE, fg=TEXT_DIM,
                 font=("Segoe UI", 8)).pack(side="left", padx=(8, 0))

        g_bars = tk.Frame(gem_box, bg=PANEL_SUBTLE)
        g_bars.pack(fill="x", padx=12, pady=(0, 10))

        self.gem_weekly_bar = self._quota_bar(g_bars, 0, "Weekly Limit")
        self.gem_5h_bar = self._quota_bar(g_bars, 1, "5-Hour Limit")

        # Box 2: Claude & GPT Models
        claude_box = tk.Frame(q_grid, bg=PANEL_SUBTLE, highlightbackground=BORDER, highlightthickness=1)
        claude_box.pack(fill="x", pady=(0, 4))

        c_head = tk.Frame(claude_box, bg=PANEL_SUBTLE)
        c_head.pack(fill="x", padx=12, pady=(8, 6))

        tk.Label(c_head, text="● CLAUDE & GPT MODELS", bg=PANEL_SUBTLE, fg=ACCENT_HOVER,
                 font=("Segoe UI", 9, "bold")).pack(side="left")
        tk.Label(c_head, text="Claude Opus, Claude Sonnet, GPT-OSS", bg=PANEL_SUBTLE, fg=TEXT_DIM,
                 font=("Segoe UI", 8)).pack(side="left", padx=(8, 0))

        c_bars = tk.Frame(claude_box, bg=PANEL_SUBTLE)
        c_bars.pack(fill="x", padx=12, pady=(0, 10))

        self.claude_weekly_bar = self._quota_bar(c_bars, 0, "Weekly Limit")
        self.claude_5h_bar = self._quota_bar(c_bars, 1, "5-Hour Limit")

        # 4. Card: Account Profile & Google Tier
        acc_card = self._card(root, title="Account Profile & Google Tier", badge="Active",
                             fill="x", padx=18, pady=(0, 12))

        self.account_bar = tk.Frame(acc_card, bg=PANEL_SUBTLE, padx=12, pady=8)
        self.account_bar.pack(fill="x", padx=14, pady=(0, 12))

        self.account_icon = tk.Label(self.account_bar, text="●", bg=PANEL_SUBTLE, fg=ACCENT, font=("Segoe UI", 8))
        self.account_icon.pack(side="left", padx=(0, 6))

        self.account_label = tk.Label(self.account_bar, text="Loading Google account tier and project…",
                                      bg=PANEL_SUBTLE, fg=TEXT_MUTED, font=("Segoe UI", 9), anchor="w")
        self.account_label.pack(side="left", fill="x", expand=True)

        # 5. Card: Connection Credentials
        conn = self._card(root, title="Connection Credentials", fill="x", padx=18, pady=(0, 12))

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
        self._copy_button(row1, self.url_var)

        # API Key
        row2 = tk.Frame(conn, bg=PANEL)
        row2.pack(fill="x", padx=14, pady=(0, 12))

        tk.Label(row2, text="API Key", bg=PANEL, fg=TEXT_MUTED, width=12, anchor="w",
                 font=("Segoe UI", 9)).pack(side="left")

        self.key_var = tk.StringVar(value=API_KEY or "(not generated — start server)")
        self.key_entry = tk.Entry(row2, textvariable=self.key_var, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                                  relief="flat", insertbackground=ACCENT, font=("Consolas", 9),
                                  show="•", highlightbackground=BORDER, highlightthickness=1)
        self.key_entry.pack(side="left", fill="x", expand=True, ipady=5, padx=(0, 6))
        self._copy_button(row2, self.key_var)

        self.btn_show = self._icon_button(row2, "Show", self.toggle_key)
        self.btn_show.pack(side="left", padx=(4, 0))

        # 6. Card: Model Catalog
        def _model_btn(h):
            self._icon_button(h, "Copy Model ID", self.copy_model).pack(side="right")

        models_card = self._card(root, title="Model Catalog", badge="Auto-synced",
                                 right_widget_fn=_model_btn, fill="x", padx=18, pady=(0, 12))

        m_frame = tk.Frame(models_card, bg=PANEL)
        m_frame.pack(fill="x", padx=14, pady=(0, 6))

        self.model_list = tk.Listbox(m_frame, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY, relief="flat",
                                     selectbackground=ACCENT, selectforeground="#FFFFFF",
                                     font=("Consolas", 9), activestyle="none", height=7,
                                     highlightbackground=BORDER, highlightthickness=1)
        sb = tk.Scrollbar(m_frame, command=self.model_list.yview, bg=PANEL_SUBTLE,
                          troughcolor=PANEL_SUBTLE, relief="flat", width=10)
        self.model_list.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.model_list.pack(side="left", fill="both", expand=True)

        tip_lbl = tk.Label(models_card, text="💡 Compatible with OpenAI SDK, Cursor, Cline, Continue, LibreChat, and Open-WebUI.",
                           bg=PANEL, fg=TEXT_DIM, font=("Segoe UI", 8), anchor="w")
        tip_lbl.pack(fill="x", padx=14, pady=(0, 8))

        # 7. Card: Quick Example (cURL)
        def _ex_btn(h):
            self._icon_button(h, "Copy cURL", self.copy_example).pack(side="right")

        ex_card = self._card(root, title="Quick Example (cURL)", right_widget_fn=_ex_btn,
                             fill="x", padx=18, pady=(0, 12))

        self.example_text = tk.Text(ex_card, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY, relief="flat",
                                    height=6, font=("Consolas", 8), insertbackground=ACCENT,
                                    wrap="word", highlightbackground=BORDER, highlightthickness=1)
        self.example_text.pack(fill="x", padx=14, pady=(0, 12))
        self.example_text.insert("1.0", self._example())
        self.example_text.configure(state="disabled")

        # 8. Footer (Windows Startup Autolaunch)
        foot = tk.Frame(root, bg=BG)
        foot.pack(fill="x", padx=18, pady=(0, 18))

        self.startup_var = tk.BooleanVar(value=os.path.exists(self._startup_lnk_path()))
        cb = tk.Checkbutton(foot, text="Start Antigravity API minimized on Windows startup",
                            variable=self.startup_var, command=self.toggle_startup,
                            bg=BG, fg=TEXT_MUTED, selectcolor=PANEL_SUBTLE,
                            activebackground=BG, activeforeground=TEXT_PRIMARY,
                            highlightthickness=0, font=("Segoe UI", 9))
        cb.pack(side="left")

    # ---------------- Buttons & UI Helpers ----------------

    def _primary_button(self, parent, text, cmd):
        b = tk.Label(parent, text=text, bg=ACCENT, fg="#FFFFFF",
                     font=("Segoe UI", 9, "bold"), padx=16, pady=7, cursor="hand2")
        b.bind("<Button-1>", lambda e: cmd())
        b.bind("<Enter>", lambda e: b.configure(bg=ACCENT_HOVER))
        b.bind("<Leave>", lambda e: b.configure(bg=ACCENT))
        return b

    def _secondary_button(self, parent, text, cmd):
        b = tk.Label(parent, text=text, bg=PANEL_SUBTLE, fg=TEXT_PRIMARY,
                     font=("Segoe UI", 9), padx=12, pady=6, cursor="hand2",
                     highlightbackground=BORDER, highlightthickness=1)
        b.bind("<Button-1>", lambda e: cmd())
        b.bind("<Enter>", lambda e: b.configure(bg=PANEL_HOVER, highlightbackground=BORDER_LIGHT))
        b.bind("<Leave>", lambda e: b.configure(bg=PANEL_SUBTLE, highlightbackground=BORDER))
        return b

    def _icon_button(self, parent, text, cmd):
        b = tk.Label(parent, text=text, bg=PANEL_SUBTLE, fg=TEXT_MUTED,
                     font=("Segoe UI", 8), padx=8, pady=3, cursor="hand2",
                     highlightbackground=BORDER, highlightthickness=1)
        b.bind("<Button-1>", lambda e: cmd())
        b.bind("<Enter>", lambda e: b.configure(bg=PANEL_HOVER, fg=TEXT_PRIMARY, highlightbackground=BORDER_LIGHT))
        b.bind("<Leave>", lambda e: b.configure(bg=PANEL_SUBTLE, fg=TEXT_MUTED, highlightbackground=BORDER))
        return b

    def _copy_button(self, parent, var):
        b = tk.Label(parent, text="Copy", bg=PANEL_SUBTLE, fg=TEXT_MUTED,
                     font=("Segoe UI", 8), padx=10, pady=5, cursor="hand2",
                     highlightbackground=BORDER, highlightthickness=1)

        def _do_copy():
            self.copy_var(var)
            b.configure(text="Copied!", fg=SUCCESS)
            self.after(1200, lambda: b.configure(text="Copy", fg=TEXT_MUTED))

        b.bind("<Button-1>", lambda e: _do_copy())
        b.bind("<Enter>", lambda e: b.configure(bg=PANEL_HOVER, highlightbackground=BORDER_LIGHT))
        b.bind("<Leave>", lambda e: b.configure(bg=PANEL_SUBTLE, highlightbackground=BORDER))
        b.pack(side="left")
        return b

    # ---------------- Quota Bars in Percent (%) ----------------

    def _quota_bar(self, grid, col, title):
        cell = tk.Frame(grid, bg=PANEL_SUBTLE)
        cell.grid(row=0, column=col, sticky="we", padx=(0, 12 if col == 0 else 0), pady=4)
        grid.columnconfigure(col, weight=1)

        hdr = tk.Frame(cell, bg=PANEL_SUBTLE)
        hdr.pack(fill="x", pady=(0, 3))

        tk.Label(hdr, text=title, bg=PANEL_SUBTLE, fg=TEXT_MUTED, font=("Segoe UI", 8, "bold")).pack(side="left")
        val_lbl = tk.Label(hdr, text="—%", bg=PANEL_SUBTLE, fg=TEXT_PRIMARY, font=("Consolas", 9, "bold"))
        val_lbl.pack(side="right")

        canvas = tk.Canvas(cell, bg=MUTED_BAR, highlightthickness=1,
                           highlightbackground=BORDER, height=10)
        canvas.pack(fill="x")

        sub_lbl = tk.Label(cell, text="Waiting for quota data…", bg=PANEL_SUBTLE, fg=TEXT_DIM, font=("Segoe UI", 8), anchor="w")
        sub_lbl.pack(fill="x", pady=(3, 0))

        return {"canvas": canvas, "value": val_lbl, "sub": sub_lbl}

    @staticmethod
    def _set_quota_bar(bar, percent, reset_text, disabled=False):
        c = bar["canvas"]
        c.delete("all")
        w = c.winfo_width() or 260

        if disabled:
            c.create_rectangle(0, 0, w, 10, fill=MUTED_BAR, outline="")
            bar["value"].configure(text="Disabled", fg=TEXT_DIM)
            bar["sub"].configure(text=reset_text or "Weekly quota reached", fg=TEXT_DIM)
            return

        if percent is None:
            c.create_rectangle(0, 0, w, 10, fill=MUTED_BAR, outline="")
            bar["value"].configure(text="—%", fg=TEXT_MUTED)
            bar["sub"].configure(text=reset_text or "No quota data", fg=TEXT_DIM)
            return

        pct = max(0.0, min(100.0, float(percent)))
        frac = pct / 100.0

        if pct >= 50.0:
            color = SUCCESS
        elif pct >= 20.0:
            color = WARNING
        else:
            color = DANGER

        c.create_rectangle(0, 0, w, 10, fill=MUTED_BAR, outline="")
        if frac > 0:
            fill_w = max(4, int(w * frac))
            c.create_rectangle(0, 0, fill_w, 10, fill=color, outline="")

        bar["value"].configure(text=f"{pct:.1f}%", fg=color)
        bar["sub"].configure(text=reset_text or "Active", fg=TEXT_MUTED if pct > 0 else DANGER)

    # ---------------- Actions & Event Handlers ----------------

    def open_settings(self):
        SettingsDialog(self, on_saved=self.refresh_all, last_result=self._last_limits_result)

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
                self.account_label.configure(text="✓ OAuth token successfully re-linked from Antigravity IDE!", fg=SUCCESS)
                self.after(2000, self.refresh_limits)
            else:
                self.account_label.configure(text=f"✗ Error: {payload[:70]}", fg=DANGER)

        self.account_label.configure(text="Scanning system for Antigravity IDE state database…", fg=WARNING)
        self._call_async(_worker, _callback)

    def copy_var(self, var):
        self.clipboard_clear()
        self.clipboard_append(var.get())

    def toggle_key(self):
        hidden = self.key_entry.cget("show") == "•"
        self.key_entry.configure(show="" if hidden else "•")
        self.btn_show.configure(text="Hide" if hidden else "Show")

    def copy_model(self):
        sel = self.model_list.curselection()
        if not sel:
            return
        self.clipboard_clear()
        self.clipboard_append(self.model_list.get(sel[0]).split("  —  ")[0].strip())

    def _example(self):
        key = API_KEY or "<api_key_from_apikey.txt>"
        model = "gemini-3.8-flash-tiered"
        try:
            if self.model_list.size() > 0:
                model = self.model_list.get(0).split("  —  ")[0].strip()
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

    def copy_example(self):
        self.clipboard_clear()
        self.clipboard_append(self.example_text.get("1.0", "end").strip())

    def toggle_server(self):
        if is_running():
            self.stop_server()
        else:
            self.start_server()
        self.after(400, self._poll_status)

    def start_server(self):
        node = find_node()
        if not node:
            self.status_text.configure(text="NODE.JS NOT FOUND", fg=DANGER)
            messagebox.showerror("Node.js Required", "Node.js 18+ was not found in PATH.\nPlease install Node.js from https://nodejs.org/")
            return

        if not os.path.exists(AUTH_FILE):
            try:
                auto_extract(force=False, out_path=AUTH_FILE)
            except Exception as e:
                self.status_text.configure(text="TOKEN MISSING", fg=DANGER)
                self.account_label.configure(text=f"Please sign in to Antigravity IDE: {str(e)[:60]}", fg=DANGER)
                return

        log = open(LOG_FILE, "ab")
        popen_kwargs = {"cwd": BASE, "stdout": log, "stderr": subprocess.STDOUT}
        if sys.platform == "win32":
            popen_kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        self.proc = subprocess.Popen([node, "server.js"], **popen_kwargs)
        self.status_text.configure(text="STARTING…", fg=WARNING)

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
            if pid:
                try:
                    if sys.platform == "win32":
                        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
                    else:
                        import signal
                        os.kill(pid, signal.SIGTERM)
                except Exception:
                    pass
        self.status_text.configure(text="STOPPED", fg=DANGER)

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
        def worker():
            try:
                result = fn()
            except Exception as e:
                result = e
            self.after(0, lambda: cb(result))
        threading.Thread(target=worker, daemon=True).start()

    def _poll_status(self):
        self._call_async(is_running, self._apply_status)
        self.refresh_limits()

    def _apply_status(self, running):
        global API_KEY
        self.status_dot.delete("all")
        if running:
            self.status_dot.create_oval(1, 1, 9, 9, fill=SUCCESS, outline="")
            self.status_text.configure(text="ONLINE · RUNNING", fg=SUCCESS)
            self.status_pill.configure(bg=SUCCESS_BG, highlightbackground=SUCCESS_BORDER)
            self.status_dot.configure(bg=SUCCESS_BG)
            self.btn_toggle.configure(text="Stop API Server", bg="#D9383A")
        else:
            self.status_dot.create_oval(1, 1, 9, 9, fill=TEXT_DIM, outline="")
            self.status_text.configure(text="OFFLINE · STOPPED", fg=TEXT_MUTED)
            self.status_pill.configure(bg=PANEL_SUBTLE, highlightbackground=BORDER)
            self.status_dot.configure(bg=PANEL_SUBTLE)
            self.btn_toggle.configure(text="Start API Server", bg=ACCENT)

        if not API_KEY or "(not generated" in self.key_var.get():
            new_key = read_api_key()
            if new_key:
                API_KEY = new_key
                self.key_var.set(new_key)

        if running and not self._models_loaded:
            self.refresh_models()
        if not running:
            self._models_loaded = False

    def refresh_all(self):
        self._models_loaded = False
        self._poll_status()

    def refresh_limits(self):
        self._call_async(lambda: http_get("/_limits", timeout=8, with_key=True), self._apply_limits)

    def _apply_limits(self, result):
        if isinstance(result, Exception):
            return

        self._last_limits_result = result

        # 1. Real Server Quotas in Percent (%)
        server_quotas = result.get("serverQuotas") or {}
        groups = server_quotas.get("groups") or []

        for g in groups:
            d_name = (g.get("displayName") or "").lower()
            buckets = g.get("buckets") or []
            is_gemini = "gemini" in d_name
            is_claude = "claude" in d_name or "gpt" in d_name

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
                    elif w == "5h":
                        self._set_quota_bar(self.gem_5h_bar, rem_pct, time_label, disabled)
                elif is_claude:
                    if w == "weekly":
                        self._set_quota_bar(self.claude_weekly_bar, rem_pct, time_label, disabled)
                    elif w == "5h":
                        self._set_quota_bar(self.claude_5h_bar, rem_pct, time_label, disabled)

        # 2. Account Profile & Tier
        acc = result.get("account") or {}
        if acc.get("error"):
            self.account_label.configure(text=f"Account status: Offline ({str(acc['error'])[:60]})", fg=TEXT_MUTED)
            self.account_icon.configure(fg=TEXT_DIM)
        else:
            tier = acc.get("tier") or "Antigravity"
            proj = acc.get("project") or "default"
            reg = acc.get("region") or "global"
            self.account_label.configure(text=f"Tier: {tier}  ·  Project: {proj}  ·  Region: {reg}", fg=TEXT_PRIMARY)
            self.account_icon.configure(fg=SUCCESS)

    def refresh_models(self):
        self._call_async(lambda: http_get("/v1/models", timeout=5, with_key=True), self._apply_models)

    def _apply_models(self, result):
        if isinstance(result, Exception):
            return
        self.model_list.delete(0, "end")
        for m in result.get("data", []):
            display = m.get("display_name") or ""
            self.model_list.insert("end", f"{m['id']:<32}  —  {display}")
        self._models_loaded = True
        self.example_text.configure(state="normal")
        self.example_text.delete("1.0", "end")
        self.example_text.insert("1.0", self._example())
        self.example_text.configure(state="disabled")

    def _loop(self):
        self._poll_status()
        if self.proc and self.proc.poll() is not None:
            self.proc = None
        self.after(2500, self._loop)


def main():
    hidden = "--hidden" in sys.argv
    selftest = "--selftest" in sys.argv
    if not selftest and not window_guard.acquire():
        return
    app = App(hidden=hidden)
    if selftest:
        app.withdraw()
        app.after(1500, app.destroy)
        app.mainloop()
        print("SELFTEST OK", flush=True)
        return
    app.mainloop()


if __name__ == "__main__":
    main()

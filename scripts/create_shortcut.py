# -*- coding: utf-8 -*-
"""
Создаёт и обновляет ярлык 'Antigravity API' на Рабочем столе Windows.

Автоматически находит реальную папку Рабочего стола:
- Локальный Desktop (%USERPROFILE%/Desktop)
- Папку OneDrive (OneDrive/Рабочий стол или OneDrive/Desktop)
- Пути через Windows Shell API
"""

import os
import subprocess
import sys

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_PY = os.path.join(BASE_DIR, "app.py")
ICO_PATH = os.path.join(BASE_DIR, "assets", "antigravity_api.ico")
SHORTCUT_NAME = "Antigravity API.lnk"


def get_all_desktop_folders():
    folders = set()
    userprofile = os.environ.get("USERPROFILE", "")
    
    # 1. Попытка через реестр Windows Shell Folders
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")
        val, _ = winreg.QueryValueEx(key, "Desktop")
        expanded = os.path.expandvars(val)
        if os.path.isdir(expanded):
            folders.add(expanded)
    except Exception:
        pass

    # 2. Стандартные папки Desktop / OneDrive
    candidates = [
        os.path.join(userprofile, "OneDrive", "Рабочий стол"),
        os.path.join(userprofile, "OneDrive", "Desktop"),
        os.path.join(userprofile, "Рабочий стол"),
        os.path.join(userprofile, "Desktop"),
    ]
    for c in candidates:
        if os.path.isdir(c):
            folders.add(c)

    return list(folders)


def get_start_menu_folder():
    appdata = os.environ.get("APPDATA", "")
    sm = os.path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs")
    return sm if os.path.isdir(sm) else None


def create_shortcut():
    pythonw = os.path.join(sys.base_prefix, "pythonw.exe")
    if not os.path.exists(pythonw):
        pythonw = "pythonw.exe"

    targets = []

    # 1. Desktop directories
    desktops = get_all_desktop_folders()
    for d in desktops:
        targets.append((os.path.join(d, SHORTCUT_NAME), "Desktop"))

    # 2. Start Menu Programs
    sm = get_start_menu_folder()
    if sm:
        targets.append((os.path.join(sm, SHORTCUT_NAME), "Start Menu"))

    if not targets:
        print("✗ Could not find Desktop or Start Menu directories.")
        return False

    print(f"Creating shortcuts in {len(targets)} locations...")
    created_any = False
    for lnk, loc_name in targets:
        ps_script = f"""
$ws = New-Object -ComObject WScript.Shell;
$s = $ws.CreateShortcut('{lnk}');
$s.TargetPath = '{pythonw}';
$s.Arguments = '"{APP_PY}"';
$s.WorkingDirectory = '{BASE_DIR}';
$s.IconLocation = '{ICO_PATH},0';
$s.Description = 'Antigravity API Desktop Control Panel';
$s.Save();
"""
        res = subprocess.run(["powershell", "-NoProfile", "-Command", ps_script], capture_output=True, text=True)
        if res.returncode == 0:
            print(f"[OK] Shortcut created [{loc_name}]: {lnk}")
            created_any = True
        else:
            print(f"[ERROR] Failed to create shortcut [{loc_name}]: {res.stderr.strip()}")

    # Refresh Windows shell icon cache
    try:
        subprocess.run(["ie4uinit.exe", "-show"], capture_output=True)
    except Exception:
        pass

    return created_any


if __name__ == "__main__":
    create_shortcut()

"""Open Gemini in a dedicated browser profile without exporting credentials.

The profile is always started with a loopback-only DevTools endpoint
(``--remote-debugging-port=0``). ``scripts/cookies_cdp.py`` uses it to read
already-authenticated cookies straight from the browser, which bypasses
Chrome's App-Bound Encryption (v20) without touching the cookie database.
"""
import os
import shutil
import subprocess
import time
from pathlib import Path

GEMINI_URL = "https://gemini.google.com/app"


def get_profile_dir():
    root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share")
    return root / "AntigravityAPI" / "GeminiBrowser"


def find_browser_executable():
    candidates = [shutil.which(name) for name in
                  ("msedge", "chrome", "google-chrome", "chromium", "chromium-browser")]
    for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
                 os.environ.get("LOCALAPPDATA")):
        if base:
            candidates.extend(str(Path(base) / suffix) for suffix in
                              ("Microsoft/Edge/Application/msedge.exe",
                               "Google/Chrome/Application/chrome.exe"))
    candidates.extend(("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                       "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"))
    return next((p for p in candidates if p and Path(p).is_file()), None)


def close_profile_browser(profile=None):
    """Закрыть только окна с нашим профилем, не трогая обычный браузер."""
    profile = str(Path(profile) if profile else get_profile_dir())
    try:
        if os.name == "nt":
            escaped = profile.replace("'", "''")
            query = (
                "Get-CimInstance Win32_Process | "
                "Where-Object { $_.Name -in @('chrome.exe','msedge.exe') -and "
                f"$_.CommandLine -like '*--user-data-dir={escaped}*' }}"
            )
            # Сначала мягко: даём Chrome записать cookie-базу (v20 пишется на диск).
            subprocess.run(["powershell", "-NoProfile", "-Command",
                            query + " | ForEach-Object { $p = Get-Process -Id $_.ProcessId "
                                    "-ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow() } }"],
                           capture_output=True, timeout=15)
            time.sleep(2.0)
            subprocess.run(["powershell", "-NoProfile", "-Command",
                            query + " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force "
                                    "-ErrorAction SilentlyContinue }"],
                           capture_output=True, timeout=15)
        else:
            subprocess.run(["pkill", "-TERM", "-f", f"--user-data-dir={profile}"], capture_output=True)
            time.sleep(2.0)
            subprocess.run(["pkill", "-KILL", "-f", f"--user-data-dir={profile}"], capture_output=True)
    except Exception:
        pass


def launch_browser(executable, profile, url=GEMINI_URL, remote_debugging=True):
    profile = Path(profile)
    profile.mkdir(parents=True, exist_ok=True)
    args = [str(executable), f"--user-data-dir={profile}", "--new-window",
            "--no-first-run", "--no-default-browser-check"]
    if remote_debugging:
        args.extend(["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"])
    args.append(url)
    return subprocess.Popen(args, shell=False)


def open_gemini_browser(remote_debugging=True, close_existing=False):
    executable = find_browser_executable()
    if not executable:
        raise RuntimeError("Chrome or Edge is required for a dedicated Gemini profile.")
    profile = get_profile_dir()
    if close_existing:
        close_profile_browser(profile)
        time.sleep(0.6)
    launch_browser(executable, profile, remote_debugging=remote_debugging)
    return profile

# -*- coding: utf-8 -*-
"""Защита от второго запуска панели (именованный mutex Windows)."""

import ctypes
import sys

MUTEX_NAME = "AntigravityAPI_Panel_Mutex"
ERROR_ALREADY_EXISTS = 183


def acquire(show_message=True):
    """True — можно запускаться; False — панель уже открыта."""
    ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        if show_message:
            try:
                import tkinter as tk
                from tkinter import messagebox
                root = tk.Tk()
                root.withdraw()
                messagebox.showinfo("Antigravity API", "Antigravity API is already running. Check your taskbar.")
                root.destroy()
            except Exception:
                pass
        return False
    return True


if __name__ == "__main__":
    sys.exit(0 if acquire() else 1)

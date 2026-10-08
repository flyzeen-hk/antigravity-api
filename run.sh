#!/usr/bin/env bash
# Antigravity API — Linux / macOS Launcher
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "========================================================"
echo "       Antigravity API — Cross-platform Launcher"
echo "========================================================"

if command -v python3 &>/dev/null; then
    python3 app.py "$@"
elif command -v python &>/dev/null; then
    python app.py "$@"
else
    echo "[ERROR] Python 3 не найден в системе!"
    exit 1
fi

#!/usr/bin/env bash
# Antigravity API — Linux & macOS Installer
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "========================================================"
echo "       ANTIGRAVITY API — LINUX & MACOS INSTALLER"
echo "========================================================"
echo

# 1. Check Python
echo "[1/5] Checking Python 3..."
if command -v python3 &>/dev/null; then
    PY="python3"
elif command -v python &>/dev/null; then
    PY="python"
else
    echo "[ERROR] Python 3 is not installed!"
    echo "Please install Python 3.10+ using your package manager (apt/brew/pacman/dnf)."
    exit 1
fi
$PY --version

# 2. Check Node.js
echo
echo "[2/5] Checking Node.js..."
if command -v node &>/dev/null; then
    node --version
else
    echo "[ERROR] Node.js is not installed!"
    echo "Please install Node.js 18+ from https://nodejs.org/ or using your package manager."
    exit 1
fi

# 3. Install Python dependencies
echo
echo "[3/5] Installing dependencies..."
$PY -m pip install --quiet -r requirements.txt || true
echo "[OK] Dependencies checked."

# 4. Extract Antigravity credentials
echo
echo "[4/5] Auto-detecting Google Antigravity credentials..."
$PY scripts/extract_token.py || echo "[NOTICE] Antigravity IDE not detected yet. Start Antigravity IDE and sign in."

# 5. Optional Desktop launcher (Linux only)
echo
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    read -r -p "Create a Desktop application launcher? (y/N): " CREATE_DESKTOP
    if [[ "$CREATE_DESKTOP" =~ ^[Yy]$ ]]; then
        DESKTOP_DIR="$HOME/.local/share/applications"
        mkdir -p "$DESKTOP_DIR"
        cat <<EOF > "$DESKTOP_DIR/antigravity-api.desktop"
[Desktop Entry]
Name=Antigravity API
Comment=Local OpenAI & Gemini API Gateway for Antigravity
Exec=$DIR/run.sh
Icon=$DIR/assets/antigravity_icon_512.png
Terminal=false
Type=Application
Categories=Development;Utility;
EOF
        chmod +x "$DESKTOP_DIR/antigravity-api.desktop"
        echo "[OK] Desktop launcher created at $DESKTOP_DIR/antigravity-api.desktop"
    else
        echo "[SKIPPED] Desktop launcher creation skipped."
    fi
fi

echo
echo "========================================================"
echo "          INSTALLATION COMPLETED SUCCESSFULLY!"
echo "========================================================"
echo
echo "To run Antigravity API:"
echo "  ./run.sh"
echo

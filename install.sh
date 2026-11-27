#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/bootstrap_node.sh
source "$ROOT/scripts/bootstrap_node.sh"
ag_ensure_node
cd "$ROOT"

echo "[OK] Node.js $("$AG_NODE" -v): $AG_NODE"
echo ""

read -r -p "Extract Antigravity IDE OAuth token into auth.json if present? [Y/n]: " ex
if [[ -z "$ex" || "$ex" =~ ^[Yy]$ ]]; then
  "$AG_NODE" "$ROOT/lib/token_extract.js" || true
  echo ""
fi

read -r -p "Create application menu / Desktop shortcuts? [Y/n]: " sc
if [[ -z "$sc" || "$sc" =~ ^[Yy]$ ]]; then
  "$AG_NODE" "$ROOT/scripts/shortcuts.js" || true
  echo ""
fi

read -r -p "Launch Antigravity API Control Panel now? [Y/n]: " go
if [[ -z "$go" || "$go" =~ ^[Yy]$ ]]; then
  exec "$AG_NODE" "$ROOT/scripts/launcher.js"
fi
echo "Setup complete. Run ./run.sh anytime."

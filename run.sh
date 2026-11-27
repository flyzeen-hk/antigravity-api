#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/bootstrap_node.sh
source "$ROOT/scripts/bootstrap_node.sh"
ag_ensure_node
cd "$ROOT"
exec "$AG_NODE" "$ROOT/scripts/launcher.js" "$@"

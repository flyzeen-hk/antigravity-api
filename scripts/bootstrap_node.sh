#!/usr/bin/env bash
set -euo pipefail

# Shared helper: resolves local ./runtime/node/bin/node or system node (>= 18),
# or asks explicit consent before downloading SHA-256 verified Node.js v22 LTS.

ag_root_dir() {
  local src="${BASH_SOURCE[0]}"
  cd "$(dirname "$src")/.." && pwd
}

ag_node_major() {
  local exe="$1"
  [ -x "$exe" ] || { echo 0; return; }
  local ver
  ver="$("$exe" -e 'process.stdout.write(String(process.versions.node || ""))' 2>/dev/null || true)"
  local major="${ver%%.*}"
  if [[ "$major" =~ ^[0-9]+$ ]]; then
    echo "$major"
  else
    echo 0
  fi
}

ag_find_node() {
  local root
  root="$(ag_root_dir)"
  local local_node="$root/runtime/node/bin/node"
  if [ "$(ag_node_major "$local_node")" -ge 18 ]; then
    echo "$local_node"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    local sys_node
    sys_node="$(command -v node)"
    if [ "$(ag_node_major "$sys_node")" -ge 18 ]; then
      echo "$sys_node"
      return 0
    fi
  fi
  return 1
}

ag_download_portable_node() {
  local root os_name arch_raw arch ext tmp_dir sums url tarball expected actual
  root="$(ag_root_dir)"
  case "$(uname -s)" in
    Darwin) os_name="darwin"; ext="tar.gz" ;;
    Linux)  os_name="linux";  ext="tar.xz" ;;
    *) echo "Unsupported OS for portable Node archive: $(uname -s)" >&2; return 1 ;;
  esac
  arch_raw="$(uname -m)"
  case "$arch_raw" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "Unsupported architecture: $arch_raw" >&2; return 1 ;;
  esac

  local base="https://nodejs.org/dist/latest-v22.x/"
  echo "Fetching SHA-256 sums from $base ..."
  sums="$(curl -fsSL "${base}SHASUMS256.txt")"
  local line
  line="$(echo "$sums" | grep -E "^[0-9a-f]{64}[[:space:]]+node-v22\.[0-9.]+-${os_name}-${arch}\.${ext}$" | head -n1 || true)"
  if [ -z "$line" ]; then
    echo "Could not find node-v22.*-${os_name}-${arch}.${ext} in SHASUMS256.txt" >&2
    return 1
  fi
  expected="$(echo "$line" | awk '{print $1}')"
  tarball="$(echo "$line" | awk '{print $2}')"
  url="${base}${tarball}"

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN
  echo "Downloading $tarball ..."
  curl -fsSL "$url" -o "$tmp_dir/$tarball"

  echo "Verifying SHA-256 checksum ..."
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp_dir/$tarball" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp_dir/$tarball" | awk '{print $1}')"
  else
    echo "Neither sha256sum nor shasum found to verify download." >&2
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "SHA-256 verification failed! Expected $expected, got $actual" >&2
    return 1
  fi

  rm -rf "$root/runtime/node"
  mkdir -p "$root/runtime/node"
  tar -xf "$tmp_dir/$tarball" -C "$root/runtime/node" --strip-components=1
  if [ "$(ag_node_major "$root/runtime/node/bin/node")" -lt 18 ]; then
    echo "Installed portable Node verification failed." >&2
    return 1
  fi
  echo "$root/runtime/node/bin/node"
}

ag_ensure_node() {
  local found
  if found="$(ag_find_node)"; then
    AG_NODE="$found"
    export AG_NODE
    return 0
  fi

  echo ""
  echo "=========================================================="
  echo "  Node.js 18+ was not found (local runtime or PATH)"
  echo "=========================================================="
  echo "  Antigravity API requires Node.js 18+ (no Python needed)."
  echo "  Choose how to proceed:"
  echo ""
  echo "  [1] Download portable Node.js v22 LTS into ./runtime/node/"
  echo "      (official nodejs.org archive, SHA-256 verified)"
  echo "  [2] Cancel and exit"
  echo ""
  read -r -p "Enter choice [1/2]: " choice
  if [ "${choice:-2}" = "1" ]; then
    AG_NODE="$(ag_download_portable_node | tail -n1)"
    export AG_NODE
    return 0
  fi
  echo "Cancelled by user. Nothing was downloaded."
  return 1
}

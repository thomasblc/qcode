#!/usr/bin/env bash
# Download QVAC Fabric LLM prebuilt binary for macOS ARM64 (M1/M2/M3/M4).
# This is the inference runtime from github.com/tetherto/qvac-fabric-llm.cpp
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
RELEASE="${QCODE_FABRIC_RELEASE:-b7349}"
ASSET="llama-${RELEASE}-bin-macos-arm64.tar.gz"
URL="https://github.com/tetherto/qvac-fabric-llm.cpp/releases/download/${RELEASE}/${ASSET}"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "warning: this script targets macOS ARM64 (Apple Silicon). You're on $(uname -m)." >&2
  echo "For other platforms, grab a matching binary from: https://github.com/tetherto/qvac-fabric-llm.cpp/releases" >&2
fi

mkdir -p "$VENDOR"

if [[ -x "$VENDOR/llama-server" ]]; then
  echo "llama-server already present at $VENDOR/llama-server — skipping."
  echo "  (delete vendor/ and rerun this script to reinstall)"
  exit 0
fi

echo "downloading QVAC Fabric LLM $RELEASE (macOS ARM64)..."
curl -L --progress-bar -o "$VENDOR/$ASSET" "$URL"

echo "extracting..."
tar -xzf "$VENDOR/$ASSET" -C "$VENDOR"
rm "$VENDOR/$ASSET"

# Remove quarantine flag so macOS doesn't block the unsigned binary
xattr -dr com.apple.quarantine "$VENDOR" 2>/dev/null || true

echo "done. QVAC Fabric LLM installed at: $VENDOR"
"$VENDOR/llama-cli" --version 2>&1 | head -4 || true

#!/usr/bin/env bash
# Start QVAC Fabric LLM server (llama-server) with Qwen 2.5 Coder 7B on Metal.
# This is the inference backend qcode talks to over HTTP (OpenAI-compatible API).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
DEFAULT_MODEL="$ROOT/models/qwen2.5-coder-3b-instruct-q4_k_m.gguf"
MODEL="${QCODE_MODEL:-$DEFAULT_MODEL}"
PORT="${QCODE_LLAMA_PORT:-8080}"
CTX="${QCODE_LLAMA_CTX:-4096}"

if [[ ! -x "$VENDOR/llama-server" ]]; then
  echo "error: $VENDOR/llama-server missing. Run scripts/download-fabric.sh first." >&2
  exit 1
fi

if [[ ! -f "$MODEL" ]]; then
  echo "error: $MODEL missing. Run scripts/download-model.sh first." >&2
  exit 1
fi

echo "booting QVAC Fabric LLM server on :$PORT"
echo "  model: $(basename "$MODEL")"
echo "  ctx:   $CTX  (override with QCODE_LLAMA_CTX)"
echo "  hint:  for 7B on 8GB M3, close browsers first: export QCODE_MODEL=\$PWD/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
exec "$VENDOR/llama-server" \
  -m "$MODEL" \
  --host 127.0.0.1 \
  --port "$PORT" \
  -c "$CTX" \
  -ngl 99 \
  --jinja

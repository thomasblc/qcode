#!/usr/bin/env bash
# Download the default Qwen 2.5 Coder model (3B Q4_K_M, ~2 GB) from HuggingFace.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS="$ROOT/models"

SIZE="${QCODE_MODEL_SIZE:-3b}"   # 3b (default, 2 GB) or 7b (4.4 GB, needs 16 GB Mac ideally)
if [[ "$SIZE" != "3b" && "$SIZE" != "7b" ]]; then
  echo "error: QCODE_MODEL_SIZE must be 3b or 7b (got: $SIZE)" >&2
  exit 1
fi

FILE="qwen2.5-coder-${SIZE}-instruct-q4_k_m.gguf"
URL="https://huggingface.co/Qwen/Qwen2.5-Coder-${SIZE^^}-Instruct-GGUF/resolve/main/${FILE}?download=true"

mkdir -p "$MODELS"

if [[ -f "$MODELS/$FILE" ]]; then
  echo "$FILE already present at $MODELS/ — skipping."
  exit 0
fi

echo "downloading $FILE from HuggingFace..."
echo "  (this is a $([ "$SIZE" = "3b" ] && echo "~2 GB" || echo "~4.4 GB") file, be patient)"
curl -L --progress-bar -o "$MODELS/$FILE" "$URL"

echo "done. Model at: $MODELS/$FILE"
ls -lh "$MODELS/$FILE"

#!/usr/bin/env bash
# Smoke test for qcode daemon. Sends a prompt, polls events, prints summary.
#
# Usage:
#   ./scripts/smoke-test.sh "hi"
#   ./scripts/smoke-test.sh "list files in src/agent"

set -eu

URL="${QCODE_URL:-http://127.0.0.1:3000}"
KEY="${QCODE_KEY:-$(cat .qcode-state/auth-key 2>/dev/null || echo)}"
ROOT="${QCODE_ROOT:-$(pwd)}"
MODE="${QCODE_MODE:-yolo}"
PROMPT="${1:-hi}"

if [ -z "$KEY" ]; then
  echo "no auth key; set QCODE_KEY or run the daemon once" >&2
  exit 1
fi

echo "=== POST /sessions ==="
echo "    prompt: $PROMPT"
PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'prompt':sys.argv[1],'projectRoot':sys.argv[2],'mode':sys.argv[3]}))" "$PROMPT" "$ROOT" "$MODE")
RESPONSE=$(curl -sS -X POST "$URL/sessions" \
  -H "x-qcode-key: $KEY" \
  -H "content-type: application/json" \
  -d "$PAYLOAD")
echo "    response: $RESPONSE"

SESSION_ID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('sessionId',''))" "$RESPONSE")
if [ -z "$SESSION_ID" ]; then
  echo "no sessionId" >&2
  exit 1
fi

echo
echo "=== poll /sessions/$SESSION_ID/snapshot ==="
SINCE=0
# 480 iterations * 0.5s = 240 seconds = 4 minutes. Long enough for
# local tasks AND for a first-time delegated task where the peer is
# downloading a model.
for i in $(seq 1 480); do
  SNAP=$(curl -sS "$URL/sessions/$SESSION_ID/snapshot?since=$SINCE" -H "x-qcode-key: $KEY")
  python3 scripts/smoke-print.py "$SNAP"
  SINCE=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(max([e.get('id',0) for e in d.get('events',[])],default=int(sys.argv[2])))" "$SNAP" "$SINCE")
  FINAL=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print('yes' if (d.get('closed') or d.get('status') in ('done','error','stopped')) else 'no')" "$SNAP")
  if [ "$FINAL" = "yes" ]; then
    STATUS=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('status',''))" "$SNAP")
    echo "=== final status: $STATUS ==="
    break
  fi
  sleep 0.5
done

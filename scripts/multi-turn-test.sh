#!/usr/bin/env bash
# Multi-turn smoke test. Creates a session with the first prompt, then
# appends follow-up turns via /sessions/:id/messages. This is the real
# acceptance test for the priorContext pollution fix: a chat reply on
# turn 1 must NOT contaminate turn 2, and a task on turn 2 must NOT
# contaminate turn 3.

set -eu

URL="${QCODE_URL:-http://127.0.0.1:3000}"
KEY="${QCODE_KEY:-$(cat .qcode-state/auth-key 2>/dev/null || echo)}"
ROOT="${QCODE_ROOT:-$(pwd)}"
MODE="${QCODE_MODE:-yolo}"

if [ -z "$KEY" ]; then
  echo "no auth key" >&2
  exit 1
fi

poll_until_done() {
  local sid="$1"
  local since=0
  for _ in $(seq 1 240); do
    local snap
    snap=$(curl -sS "$URL/sessions/$sid/snapshot?since=$since" -H "x-qcode-key: $KEY")
    python3 scripts/smoke-print.py "$snap"
    since=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(max([e.get('id',0) for e in d.get('events',[])],default=int(sys.argv[2])))" "$snap" "$since")
    local final
    final=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print('yes' if (d.get('closed') or d.get('status') in ('done','error','stopped')) else 'no')" "$snap")
    if [ "$final" = "yes" ]; then
      local status
      status=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('status',''))" "$snap")
      echo "    ↳ final status: $status"
      return
    fi
    sleep 0.5
  done
  echo "    ↳ TIMEOUT after 120s"
}

turn1="${1:-hi}"
turn2="${2:-list files in src/agent}"
turn3="${3:-hi again}"

echo
echo "=== TURN 1: $turn1 ==="
payload=$(python3 -c "import json,sys; print(json.dumps({'prompt':sys.argv[1],'projectRoot':sys.argv[2],'mode':sys.argv[3]}))" "$turn1" "$ROOT" "$MODE")
response=$(curl -sS -X POST "$URL/sessions" -H "x-qcode-key: $KEY" -H "content-type: application/json" -d "$payload")
echo "    response: $response"
sid=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('sessionId',''))" "$response")
[ -z "$sid" ] && echo "no sid" && exit 1
poll_until_done "$sid"

echo
echo "=== TURN 2: $turn2 ==="
p2=$(python3 -c "import json,sys; print(json.dumps({'content':sys.argv[1],'mode':sys.argv[2]}))" "$turn2" "$MODE")
curl -sS -X POST "$URL/sessions/$sid/messages" -H "x-qcode-key: $KEY" -H "content-type: application/json" -d "$p2" > /dev/null
poll_until_done "$sid"

echo
echo "=== TURN 3: $turn3 ==="
p3=$(python3 -c "import json,sys; print(json.dumps({'content':sys.argv[1],'mode':sys.argv[2]}))" "$turn3" "$MODE")
curl -sS -X POST "$URL/sessions/$sid/messages" -H "x-qcode-key: $KEY" -H "content-type: application/json" -d "$p3" > /dev/null
poll_until_done "$sid"

echo
echo "=== SESSION DUMP ==="
curl -sS "$URL/sessions/$sid" -H "x-qcode-key: $KEY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
s = d.get('session', {})
print('  id:', s.get('id'))
print('  status:', s.get('status'))
print('  turns:')
for i, t in enumerate(s.get('turns', [])):
    summary = t.get('summary', '')
    marker = ' (EMPTY = filtered from priorContext)' if not summary else ''
    print(f'    {i+1}. task={t.get(\"task\",\"\")!r}')
    print(f'       summary={summary!r}{marker}')
"

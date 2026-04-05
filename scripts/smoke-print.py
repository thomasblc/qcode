#!/usr/bin/env python3
"""Print qcode snapshot events in human-readable form."""
import json
import sys


def main() -> None:
    if len(sys.argv) < 2:
        return
    try:
        d = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(f"  [PARSE_ERR] {e}", flush=True)
        return
    for e in d.get("events", []):
        et = e.get("type", "?")
        data = e.get("data", {}) or {}
        if et == "iteration":
            print(f"  [iter {data.get('iter', '?')}]", flush=True)
        elif et == "tool_call":
            args = json.dumps(data.get("args", {}))[:120]
            print(f"  [tool_call] {data.get('tool', '?')}({args})", flush=True)
        elif et == "tool_result":
            r = data.get("result", {})
            ok = r.get("ok") if isinstance(r, dict) else None
            status = "ok" if ok else "FAIL"
            if isinstance(r, dict) and "text" in r:
                text = str(r["text"])[:200]
                print(f"  [tool_result] {data.get('tool', '?')}: {status} text={text!r}", flush=True)
            else:
                print(f"  [tool_result] {data.get('tool', '?')}: {status}", flush=True)
        elif et == "done":
            summary = str(data.get("summary", ""))[:300]
            reply = data.get("reply", False)
            print(f"  [done] reply={reply} summary={summary!r}", flush=True)
        elif et == "error":
            print(f"  [ERROR] {data.get('message', '?')}", flush=True)
        elif et == "assistant_text":
            text = str(data.get("text", ""))[:300]
            print(f"  [assistant] {text!r}", flush=True)
        elif et == "state":
            pass  # noisy
        else:
            print(f"  [{et}] {json.dumps(data)[:150]}", flush=True)


if __name__ == "__main__":
    main()

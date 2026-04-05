# Scenario 1 — Refactor promises to async/await

**Difficulty**: easy (tested with Qwen 2.5 Coder 3B)

**Recommended mode**: 📝 `plan-first` (shows agent reasoning) or ⚡ `auto-writes` (fast)

### Prompt (paste into qcode)
```
refactor examples/01-refactor/users.ts to use async/await instead of promise chains. keep the same behavior.
```

### Expected flow
1. `read_file` users.ts
2. `write_file` with async/await version (awaits the diff)
3. `done`

### What you should see
- Streaming tokens in the thinking panel
- Diff preview showing old promise chain → new async/await
- ~15-30 seconds total on M3 with 3B

### Reset after demo
```bash
git checkout examples/01-refactor/users.ts
```

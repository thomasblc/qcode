# Scenario 2 — Fix an off-by-one bug

**Difficulty**: medium (tested with Qwen 2.5 Coder 3B)

**Recommended mode**: 🔒 `ask` (see the fix before applying)

### Prompt (paste into qcode)
```
there's an off-by-one bug in examples/02-bugfix/pagination.ts. read the file, find the bug, and fix it so page 1 returns the first pageSize items.
```

### Expected flow
1. `read_file` pagination.ts
2. `write_file` fixing `start = (page - 1) * pageSize`
3. `done`

### The fix
```diff
- const start = page * pageSize;
+ const start = (page - 1) * pageSize;
```

### What you should see
- Agent reads the file, identifies the bug from the comment hint
- Diff popup showing the single-line fix
- You tap approve → file updated

### Reset after demo
```bash
git checkout examples/02-bugfix/pagination.ts
```

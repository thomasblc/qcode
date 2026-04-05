# Scenario 3 — Add a new function

**Difficulty**: easy (tested with Qwen 2.5 Coder 3B)

**Recommended mode**: 📝 `plan-first` (perfect showcase of plan → execute flow)

### Prompt (paste into qcode)
```
add a function calculateROI(initial, current) to examples/03-feature/math.ts that returns the return-on-investment as a percentage. use the existing percentChange function.
```

### Expected flow (plan-first mode)
1. `propose_plan` — agent outlines: read file, append new function, done
2. **You approve the plan** → iPhone popup
3. `read_file` math.ts
4. `write_file` with the added function (auto-approved)
5. `done`

### The expected output (approximate)
```typescript
export function calculateROI(initial: number, current: number): number {
  return percentChange(initial, current);
}
```

### What you should see
- First approval popup: the PLAN (3 steps + rationale)
- After approval: writes happen automatically, no more popups
- Green `done` event at the end

### Reset after demo
```bash
git checkout examples/03-feature/math.ts
```

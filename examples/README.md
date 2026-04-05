# qcode demo scenarios

Three realistic coding tasks that work reliably with Qwen 2.5 Coder 3B on an M3 8GB Mac.

| # | Task | Difficulty | Best mode |
|---|---|---|---|
| 1 | Refactor promises → async/await | easy | 📝 plan-first or ⚡ auto-writes |
| 2 | Find & fix an off-by-one bug | medium | 🔒 ask |
| 3 | Add a new function to a module | easy | 📝 plan-first |

### How to run a scenario

1. Start both servers (see main README).
2. Open qcode on your iPhone (or Mac browser).
3. Copy the **Prompt** from the scenario's README into the qcode textarea.
4. Select the recommended mode.
5. Tap **run**, watch the events stream, approve when asked.
6. After the demo, reset the starter file with `git checkout`.

### Why these three

- **Refactor**: shows tool chaining (read → write → done).
- **Bugfix**: shows reasoning about file content, single-line change.
- **New function**: cleanest plan-first demo (plan popup, then silent execution).

### Known limits with 3B

- Keep prompts concrete and specific ("refactor X in file Y").
- Ambiguous prompts ("improve this code") tend to hallucinate.
- For heavy refactors or multi-file tasks, swap to 7B:
  ```bash
  QCODE_MODEL=$PWD/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf ./scripts/start-llama-server.sh
  ```
  (close browser tabs first — 7B needs all the RAM on 8GB Macs)

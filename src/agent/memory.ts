// Project memory: reads qcode.md / AGENTS.md from the project root and
// surfaces it to the model as extra system-prompt context. Model-agnostic
// by design (qcode runs any GGUF, not just one vendor's model).

import { promises as fs } from "node:fs";
import path from "node:path";

const CANDIDATES = ["qcode.md", "AGENTS.md", ".cursorrules"];
const MAX_BYTES = 8000; // don't blow up context, 2k tokens max

export async function readProjectMemory(projectRoot: string): Promise<string | null> {
  for (const name of CANDIDATES) {
    const full = path.join(projectRoot, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      const raw = await fs.readFile(full, "utf-8");
      const trimmed = raw.slice(0, MAX_BYTES);
      return `## Project memory (${name})\n\n${trimmed}${raw.length > MAX_BYTES ? "\n…[truncated]" : ""}`;
    } catch { /* not present, try next */ }
  }
  return null;
}

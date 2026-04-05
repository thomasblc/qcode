import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth.js";

const HOME = path.resolve(os.homedir());
const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build", "vendor", "models", ".qcode-state", ".DS_Store"]);

// Folder browser for the PWA's "change project root" flow.
// Sandboxed to the user's home directory. We never show paths outside $HOME.
function safeResolve(p: string): string | null {
  const abs = path.resolve(p.startsWith("~") ? p.replace(/^~/, HOME) : p);
  // Prefix check MUST use path.sep, otherwise e.g. /Users/thomas would
  // also allow /Users/thomas_attacker. Also treat exact-match as inside.
  if (abs !== HOME && !abs.startsWith(HOME + path.sep)) return null;
  return abs;
}

export function registerFsRoutes(app: Express): void {
  // GET /fs/list?path=...: list directories under path
  app.get("/fs/list", requireAuth, async (req: Request, res: Response) => {
    const pathArg = String(req.query.path ?? HOME);
    const abs = safeResolve(pathArg);
    if (!abs) { res.status(400).json({ error: "path must be inside $HOME" }); return; }

    try {
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) { res.status(400).json({ error: "not a directory" }); return; }
    } catch {
      res.status(404).json({ error: "not found" }); return;
    }

    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith("."))
        .map(e => ({ name: e.name, path: path.join(abs, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = abs === HOME ? null : path.dirname(abs);
      res.json({
        path: abs,
        displayPath: abs.replace(HOME, "~"),
        parent,
        parentDisplay: parent ? parent.replace(HOME, "~") : null,
        entries: dirs,
        home: HOME,
        homeDisplay: "~",
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

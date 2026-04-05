import type { Express, Request, Response } from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { requireAuth } from "./auth.js";

// Serves any file from the user's current project root. Auth required.
// Used by the PWA's preview button to open a generated HTML (or any file)
// directly in the browser.
//
// Security notes:
// - Auth gated (x-qcode-key or ?key=).
// - Path-escape check prevents `..` traversal.
// - Read-only.
export function registerPreviewRoutes(app: Express, getProjectRoot: () => string | null): void {
  app.get(/^\/files\/(.+)/, requireAuth, async (req: Request, res: Response) => {
    const projectRoot = getProjectRoot();
    if (!projectRoot) { res.status(400).json({ error: "no project root set" }); return; }
    const relative = decodeURIComponent((req.params as unknown as string[])[0] ?? "");
    const full = path.resolve(projectRoot, relative);
    if (full !== projectRoot && !full.startsWith(projectRoot + path.sep)) {
      res.status(403).json({ error: "path escapes project root" }); return;
    }
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) { res.status(404).json({ error: "not a file" }); return; }
      // Set content-type based on extension (Express doesn't do this automatically for .send)
      const ext = path.extname(full).toLowerCase();
      const mimes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
      };
      res.setHeader("content-type", mimes[ext] ?? "application/octet-stream");
      res.sendFile(full);
    } catch {
      res.status(404).json({ error: "not found" });
    }
  });
}

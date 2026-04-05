import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";

// A shared secret the client (iPhone Shortcut / curl / PWA) must send in the
// x-qcode-key header. Persisted to .qcode-state/auth-key on first boot so it
// does NOT change across restarts. Override with QCODE_KEY env var.
let SERVER_KEY: string | null = null;

function getKeyPath(): string {
  return path.join(process.cwd(), ".qcode-state", "auth-key");
}

export function initAuthKey(): string {
  // 1. Env var takes precedence (for tests / override)
  const fromEnv = process.env.QCODE_KEY;
  if (fromEnv && fromEnv.length >= 16) {
    SERVER_KEY = fromEnv;
    return SERVER_KEY;
  }
  // 2. Try to load from disk
  const keyPath = getKeyPath();
  try {
    const persisted = readFileSync(keyPath, "utf-8").trim();
    if (persisted && persisted.length >= 16) {
      SERVER_KEY = persisted;
      return SERVER_KEY;
    }
  } catch { /* first boot, fall through */ }
  // 3. Generate new + persist
  SERVER_KEY = randomBytes(18).toString("base64url");
  try {
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, SERVER_KEY, { mode: 0o600 });
  } catch { /* persistence failure is non-fatal */ }
  return SERVER_KEY;
}

export function getAuthKey(): string {
  if (!SERVER_KEY) throw new Error("auth key not initialized, call initAuthKey() first");
  return SERVER_KEY;
}

// Timing-safe string compare so a LAN attacker cannot extract the key one
// byte at a time from response timing. Falls back to false if lengths differ
// (timingSafeEqual requires equal-length buffers) and always compares a
// constant-length buffer to avoid leaking the key length on mismatch.
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // Always compare against aBuf to keep compare cost constant.
  if (aBuf.length !== bBuf.length) {
    // Still do a compare with a dummy buffer so mismatching-length cases take
    // the same time as matching-length mismatches.
    try { timingSafeEqual(aBuf, Buffer.alloc(aBuf.length)); } catch { /* noop */ }
    return false;
  }
  try { return timingSafeEqual(aBuf, bBuf); } catch { return false; }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header("x-qcode-key") ?? (req.query.key as string | undefined);
  if (!provided || !SERVER_KEY || !constantTimeEquals(provided, SERVER_KEY)) {
    res.status(401).json({ error: "missing or invalid x-qcode-key" });
    return;
  }
  next();
}

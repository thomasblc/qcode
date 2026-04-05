// System info endpoint: surfaces Mac specs to the PWA so we can label
// model recommendations ("recommended for your 8GB M3" vs "won't fit").

import os from "node:os";
import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth.js";

export interface SystemInfo {
  platform: string;      // darwin / linux / win32
  arch: string;          // arm64 / x64
  cpus: number;
  totalRamGB: number;    // rounded to 1 decimal
  freeRamGB: number;
  hostname: string;
  nodeVersion: string;
}

export function getSystemInfo(): SystemInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalRamGB: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    freeRamGB: Math.round((os.freemem() / 1024 / 1024 / 1024) * 10) / 10,
    hostname: os.hostname(),
    nodeVersion: process.version,
  };
}

export function registerSystemRoutes(app: Express): void {
  app.get("/system/info", requireAuth, (_req: Request, res: Response) => {
    res.json(getSystemInfo());
  });
}

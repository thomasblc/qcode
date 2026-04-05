import path from "node:path";

// Project root is set once at startup by the CLI/server.
// All file tools resolve paths against it and refuse to escape.
let PROJECT_ROOT: string | null = null;

export function setProjectRoot(root: string): void {
  PROJECT_ROOT = path.resolve(root);
}

export function getProjectRoot(): string {
  if (!PROJECT_ROOT) {
    throw new Error("project root not set. Call setProjectRoot() first");
  }
  return PROJECT_ROOT;
}

export function resolveInProjectRoot(p: string): string {
  const root = getProjectRoot();
  const resolved = path.resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes project root: ${p}`);
  }
  return resolved;
}

// Tiny math utility module.

export function percentChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

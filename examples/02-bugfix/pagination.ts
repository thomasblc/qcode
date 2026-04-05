// Paginate an array. Returns items for the given 1-indexed page.
// BUG: the slice boundaries are off by one. "page 1" should return items 1..pageSize.

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize;
  const end = start + pageSize;
  return items.slice(start, end);
}

// Example: paginate([a,b,c,d,e], 1, 2) should return [a,b] but currently returns [c,d].

// Internal SQL helpers for the data layer; not part of the data API facade.

// Numbered D1 placeholder list for IN clauses: placeholderList(3) -> "?1, ?2, ?3",
// placeholderList(2, 4) -> "?4, ?5". Keep every IN clause on this helper so the
// numbering arithmetic (especially offsets past earlier bind params) lives in
// exactly one place.
export function placeholderList(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(', ');
}

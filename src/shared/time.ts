// Timestamp parsing and stall thresholds shared across client, HTTP, services,
// data, and AI layers.

// Drizzle returns PostgreSQL timestamps verbatim, including space-separated
// values with an explicit offset. Add UTC only when the value is truly zoneless.
export function parseUtc(ts: string): number {
  const normalized = ts
    .replace(' ', 'T')
    // PostgreSQL preserves up to six fractional digits; ECMAScript timestamps
    // accept milliseconds, so discard only sub-millisecond precision.
    .replace(/\.(\d{3})\d+/, '.$1')
    // PostgreSQL commonly renders UTC as +00. Expand short/compact offsets to
    // the ISO form consistently accepted by both Node and workerd.
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    .replace(/([+-]\d{2})$/, '$1:00');
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized);
  return Date.parse(hasZone ? normalized : `${normalized}Z`);
}

// A dispatched review that never completed and is older than this is presumed
// dead (agent error before post_review) rather than still running. The UI's
// 'stalled' state, the dispatch sweep in tryRecordReview, and the dashboard
// running counts must all agree on this cutoff, so they all derive from here.
export const STALL_AFTER_MINUTES = 20;
export const STALL_AFTER_MS = STALL_AFTER_MINUTES * 60 * 1000;
// PostgreSQL interval literal for the same cutoff, interpolated into data-layer queries.
export const STALL_CUTOFF_MODIFIER = `-${STALL_AFTER_MINUTES} minutes`;

// Timestamp parsing and stall thresholds shared across client, HTTP, services,
// data, and AI layers.

// PostgreSQL timestamptz rows are returned as ISO strings. Keep this tolerant
// of space-separated UTC timestamps for optional one-off imports.
export function parseUtc(ts: string): number {
  return Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
}

// A dispatched review that never completed and is older than this is presumed
// dead (agent error before post_review) rather than still running. The UI's
// 'stalled' state, the dispatch sweep in tryRecordReview, and the dashboard
// running counts must all agree on this cutoff, so they all derive from here.
export const STALL_AFTER_MINUTES = 20;
export const STALL_AFTER_MS = STALL_AFTER_MINUTES * 60 * 1000;
// PostgreSQL interval literal for the same cutoff, interpolated into data-layer queries.
export const STALL_CUTOFF_MODIFIER = `-${STALL_AFTER_MINUTES} minutes`;

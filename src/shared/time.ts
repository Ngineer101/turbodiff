// Timestamp parsing and stall thresholds shared across client, HTTP, services,
// data, and AI layers.

// D1's datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS' with no zone marker;
// ISO strings with a 'T' already carry their own zone info.
export function parseUtc(ts: string): number {
  return Date.parse(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
}

// A dispatched review that never completed and is older than this is presumed
// dead (agent error before post_review) rather than still running. The UI's
// 'stalled' state, the dispatch sweep in tryRecordReview, and the dashboard
// running counts must all agree on this cutoff, so they all derive from here.
export const STALL_AFTER_MINUTES = 20;
export const STALL_AFTER_MS = STALL_AFTER_MINUTES * 60 * 1000;
// SQLite datetime() modifier for the same cutoff, interpolated into data-layer queries.
export const STALL_CUTOFF_MODIFIER = `-${STALL_AFTER_MINUTES} minutes`;

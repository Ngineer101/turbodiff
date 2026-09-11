// Converts a Flue settlement into a bounded, user-visible failure reason for
// the remaining durable Flue adapters.
export function settlementReason(event: {
  outcome: 'completed' | 'failed' | 'aborted';
  error?: { name?: string; message: string; type?: string; details?: string };
}): string {
  if (event.outcome === 'completed') return 'agent run ended without producing its artifact';
  const error = event.error;
  if (!error) return `agent run ${event.outcome}`;
  const head = [error.type ?? error.name, error.message].filter(Boolean).join(': ');
  return `${event.outcome}: ${head}${error.details ? ` — ${error.details}` : ''}`.slice(0, 1_000);
}

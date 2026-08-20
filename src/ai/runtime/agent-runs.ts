import { env } from 'cloudflare:workers';
import { recordAgentRun, type AgentRunKind } from '../../data/db.ts';

// Full agent-session logs (docs/software-factory-design.md): the one place
// the *full* stdout+stderr of a sandboxed agent CLI invocation lands, as
// opposed to the short truncated summaries each call site keeps for its own
// thrown-error / PR-comment text. Content must already be scrubbed of
// tokens/secrets by the caller before it reaches here.
export async function persistAgentLog(
  kind: AgentRunKind,
  content: string,
  success: boolean,
  owner: { planId?: number; featureId?: number; fixAttemptId?: number; automationRunId?: number },
  // Raw stream-json stdout (every turn, not just the final result) for
  // runners that capture it — stored as a sibling object addressed by the
  // same logKey (see transcriptKey), no extra DB row. Must be pre-scrubbed
  // like `content`.
  transcript?: string,
): Promise<void> {
  const key = `logs/${kind}/${crypto.randomUUID()}.log`;
  if (transcript !== undefined) {
    await env.ARTIFACTS.put(transcriptKey(key), transcript, {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
  }
  await env.ARTIFACTS.put(key, content, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  await recordAgentRun(kind, key, success, owner);
}

// The transcript rides next to the log under a key convention instead of its
// own column — agent_runs.log_key addresses both.
export function transcriptKey(logKey: string): string {
  return logKey.replace(/\.log$/, '.transcript.jsonl');
}

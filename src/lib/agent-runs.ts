import { env } from 'cloudflare:workers';
import { recordAgentRun, type AgentRunKind } from './db.ts';

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
): Promise<void> {
  const key = `logs/${kind}/${crypto.randomUUID()}.log`;
  await env.ARTIFACTS.put(key, content, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  await recordAgentRun(kind, key, success, owner);
}

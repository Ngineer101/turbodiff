import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getFeature, latestVerificationForFeature } from '../../data/db.ts';
import { runVerification } from '../runners/verifier.ts';
import { parseUtc } from '../../shared/time.ts';
import { notifyFeatureLive } from '../../services/live-updates.ts';

// Verification as a durable Workflow, for the same reason generation is one:
// the queue consumer's 15-minute wall clock silently killed long verify runs
// (launch discovery + screenshots + a recording routinely exceed it),
// stranding rows in 'running'. runVerification records its own outcomes and
// never throws for business reasons, so one long-budget step suffices; the
// retry (limit 1) only fires on infrastructure death, and the stranded-row
// sweep in db.ts mops up any run the engine itself loses.

export type VerificationParams = {
  featureId: number;
};

export class VerificationWorkflow extends WorkflowEntrypoint<unknown, VerificationParams> {
  async run(event: WorkflowEvent<VerificationParams>, step: WorkflowStep): Promise<string> {
    const { featureId } = event.payload;
    await step.do(
      'run verification',
      { retries: { limit: 1, delay: '5 minutes' }, timeout: '40 minutes' },
      async () => {
        await runVerification(featureId);
        await notifyFeatureLive(featureId);
      },
    );
    return 'done';
  }
}

// Queue entry point. Dedupe: a fresh 'running' verification for this feature
// means an instance is already on it (e.g. a queue redelivery) — skip.
export async function startVerification(featureId: number): Promise<void> {
  const feature = await getFeature(featureId);
  if (!feature) return;
  const latest = await latestVerificationForFeature(featureId);
  if (latest?.status === 'running') {
    const startedMs = parseUtc(latest.created_at);
    if (Date.now() - startedMs < 45 * 60_000) {
      console.log(`turbodiff: verification skipped for feature ${featureId} — a run is in flight`);
      return;
    }
  }
  await env.VERIFY_WORKFLOW.create({
    id: `verify-${featureId}-${Date.now()}`,
    params: { featureId },
  });
}

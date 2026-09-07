import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getFeature, latestVerificationForFeature } from '../../data/db.ts';
import { runVerification } from '../runners/verifier.ts';
import { verdictRecordedSince, verificationSkipReason } from '../../domain/verification.ts';
import { notifyFeatureLive } from '../../services/live-updates.ts';
import { completeLifecycleStage } from '../../services/lifecycle.ts';
import type { VerifyQueueMessage } from '../../shared/factory-messages.ts';

// Verification as a durable Workflow, for the same reason generation is one:
// the queue consumer's 15-minute wall clock silently killed long verify runs
// (launch discovery + screenshots + a recording routinely exceed it),
// stranding rows in 'running'. runVerification records its own outcomes and
// never throws for business reasons, so one long-budget step suffices; the
// retry (limit 1) only fires on infrastructure death, and the stranded-row
// sweep in db.ts mops up any run the engine itself loses.
//
// That retry can also re-execute a callback that already finished (the
// engine reports "Attempt failed due to internal workflows error" after the
// verdict was recorded), so the step is idempotent on the verdict: a
// terminal verification recorded since this instance was queued is reused
// instead of paying for a second run — see verdictRecordedSince.

export type VerificationParams = {
  featureId: number;
  factoryRunId?: number;
  stageRunId?: number;
};

export class VerificationWorkflow extends WorkflowEntrypoint<unknown, VerificationParams> {
  async run(event: WorkflowEvent<VerificationParams>, step: WorkflowStep): Promise<string> {
    const { featureId, stageRunId } = event.payload;
    try {
      await step.do(
        'run verification',
        { retries: { limit: 1, delay: '5 minutes' }, timeout: '40 minutes' },
        async () => {
          const prior = await latestVerificationForFeature(featureId);
          if (verdictRecordedSince(prior, event.timestamp.getTime())) {
            console.log(
              `turbodiff: verification for feature ${featureId} already recorded by an earlier ` +
                `attempt of ${event.instanceId} — not re-running`,
            );
          } else {
            // Under the lifecycle the coordinator schedules the repair from
            // the recorded verdict; the verifier's own fix dispatch is only
            // for legacy runs.
            await runVerification(featureId, { lifecycleOwned: stageRunId !== undefined });
          }
          await notifyFeatureLive(featureId);
        },
      );
      if (stageRunId) {
        await step.do('settle lifecycle verification', async () => {
          const result = await latestVerificationForFeature(featureId);
          const passed = result?.status === 'passed';
          await completeLifecycleStage(
            stageRunId,
            'verify',
            result !== null,
            { kind: 'verification_completed', featureId, status: result?.status ?? 'missing' },
            { verificationPassed: passed },
          );
        });
      }
      return 'done';
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (stageRunId) {
        await step.do('settle lifecycle verification failure', async () => {
          await completeLifecycleStage(stageRunId, 'verify', false, {
            kind: 'verification_failed',
            featureId,
            detail,
          });
        });
      }
      throw error;
    }
  }
}

// Queue entry point, gated by verificationSkipReason: a feature already in a
// terminal state (merged/abandoned/pr_closed) has nothing left to prove, and
// a fresh 'running' verification means an instance is already on it (e.g. a
// queue redelivery) — skip both.
export async function startVerification(message: VerifyQueueMessage): Promise<void> {
  const { featureId, factoryRunId, stageRunId } = message;
  const feature = await getFeature(featureId);
  if (!feature) return;
  const latest = await latestVerificationForFeature(featureId);
  const skip = verificationSkipReason(feature, latest, Date.now());
  if (skip === 'terminal') {
    console.log(
      `turbodiff: verification skipped for feature ${featureId} — feature is ${feature.status}`,
    );
    if (stageRunId) {
      await completeLifecycleStage(stageRunId, 'verify', false, {
        kind: 'verification_skipped',
        featureId,
        reason: 'terminal feature',
      });
    }
    return;
  }
  if (skip === 'in_flight') {
    console.log(`turbodiff: verification skipped for feature ${featureId} — a run is in flight`);
    if (stageRunId) {
      await completeLifecycleStage(stageRunId, 'verify', false, {
        kind: 'verification_skipped',
        featureId,
        reason: 'verification already in flight',
      });
    }
    return;
  }
  await env.VERIFY_WORKFLOW.create({
    id: `verify-${featureId}-${Date.now()}`,
    params: { featureId, factoryRunId, stageRunId },
  });
}

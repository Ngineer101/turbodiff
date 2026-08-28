// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
//   - Named exports become top-level Worker exports — e.g. application-owned
//     Durable Object classes (declare their bindings in wrangler.jsonc).
//   - An optional default export adds non-HTTP handlers: scheduled (cron),
//     queue consumers, inbound email, etc. (never `fetch`).
//
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint

import { startAutomationRun, AutomationWorkflow } from './ai/workflows/automation.ts';
import { pollAutomations } from './services/automation-poll.ts';
import {
  ConflictResolveWorkflow,
  startResolveConflict,
} from './ai/workflows/conflict-resolution.ts';
import { startChatTurn, ChatWorkflow } from './ai/workflows/chat.ts';
import { startFix, FixWorkflow } from './ai/workflows/fix.ts';
import type { FactoryMessage } from './shared/factory-messages.ts';
import { startGeneration } from './ai/workflows/generation.ts';
import { failStrandedGeneration, failStrandedVerifications } from './data/factory.ts';
import { sweepFactoryPrConflicts } from './services/merge-conflicts.ts';
import { runPlanAnalyze, runPlanRefine } from './ai/runners/planner.ts';
import { dispatchNativeCrReviews } from './ai/review/native-dispatch.ts';
import { runQueuedCrMerge } from './services/change-requests.ts';
import { startVerification, VerificationWorkflow } from './ai/workflows/verification.ts';
import { notifyPlanLive } from './services/live-updates.ts';

// The fixer sandbox container (docs/software-factory-design.md). Declared in
// wrangler.jsonc under containers/durable_objects with migration tag v2.
export { Sandbox } from '@cloudflare/sandbox';
export { LiveUpdates } from './live-updates.ts';

// Generation, verification, and automations run as durable Workflows
// (bindings GEN_WORKFLOW / VERIFY_WORKFLOW / AUTOMATION_WORKFLOW in
// wrangler.jsonc): memoized steps, bounded retries, no wall-clock kills.
export { GenerationWorkflow } from './ai/workflows/generation.ts';
// Started by the platform itself on Artifacts events — see the
// `triggers.events` entries in wrangler.jsonc (docs/artifacts-provider.md).
export { ArtifactsEventsWorkflow } from './ai/workflows/artifacts-events.ts';
export { VerificationWorkflow };
export { FixWorkflow };
export { ChatWorkflow };
export { AutomationWorkflow };
export { ConflictResolveWorkflow };

// Fix and generation runs take minutes, far beyond what a webhook or intake
// request can wait on, so producers enqueue and these consumers do the work.
// Both processors never throw (failures land in fix_attempts / features), so
// every message acks — a broken run is not retried into repeat token spend.
export default {
  async queue(batch: MessageBatch<FactoryMessage>): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body;
      switch (body.kind) {
        case 'generate':
          // Just creates a durable workflow instance (sub-second) — the
          // run itself lives outside any consumer wall clock.
          await startGeneration(body.featureId);
          break;
        case 'plan_analyze':
          await runPlanAnalyze(body.planId);
          await notifyPlanLive(body.planId);
          break;
        case 'plan_refine':
          await runPlanRefine(body.planId);
          await notifyPlanLive(body.planId);
          break;
        case 'verify':
          // Just creates a durable workflow instance — verify runs exceed
          // the consumer wall clock routinely (launch discovery + demos).
          await startVerification(body.featureId);
          break;
        case 'automation':
          await startAutomationRun(body.automationId);
          break;
        case 'chat':
          // Chat turns get the same no-wall-clock treatment as fixes: the
          // consumer just creates the durable workflow instance.
          await startChatTurn(body);
          break;
        case 'resolve_conflict':
          // A new message kind must not silently fall into the `default`
          // (fix) branch and mis-dispatch.
          await startResolveConflict(body);
          break;
        case 'cr_merge':
          // Native merges run sandbox git and can queue behind long agent
          // execs in the same container — never inside an HTTP request
          // (live finding: a cockpit merge took 2+ minutes server-side and
          // the response timed out while the merge itself succeeded).
          await runQueuedCrMerge(body.changeRequestId, body.actor);
          break;
        case 'cr_review':
          // Native change-request review (docs/artifacts-provider.md):
          // risk-tiered dispatch of the SAME configured reviewer agents that
          // review GitHub PRs, with CR-backed tools swapped in by the pin.
          await dispatchNativeCrReviews(body.changeRequestId);
          break;
        default:
          // Fix runs get the same no-wall-clock treatment as generation
          // and verification: the consumer just creates the instance.
          await startFix(body);
      }
      message.ack();
    }
  },

  // Fixed-interval poll for due automations (src/services/automation-poll.ts) —
  // schedule precision is bounded by the cron interval in wrangler.jsonc.
  async scheduled(): Promise<void> {
    await pollAutomations();
    // Conflict sweep rides the same tick: base-branch pushes fire no event
    // this app receives, so open factory PRs are re-checked here (see
    // merge-conflicts.ts).
    await sweepFactoryPrConflicts();
    // Stranded-run backstops, moved off the hot read paths (they used to be
    // two serialized table-sweeping UPDATEs on every board/task/feature
    // GET). The strand thresholds are 45 minutes, so the 15-minute cron adds
    // negligible staleness.
    await failStrandedGeneration();
    await failStrandedVerifications();
  },
};

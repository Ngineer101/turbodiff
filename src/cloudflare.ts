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
import { startFix, FixWorkflow } from './ai/workflows/fix.ts';
import type { FactoryMessage } from './shared/factory-messages.ts';
import { startGeneration } from './ai/workflows/generation.ts';
import { sweepFactoryPrConflicts } from './services/merge-conflicts.ts';
import { runPlanAnalyze, runPlanRefine } from './ai/runners/planner.ts';
import { startVerification, VerificationWorkflow } from './ai/workflows/verification.ts';

// The fixer sandbox container (docs/software-factory-design.md). Declared in
// wrangler.jsonc under containers/durable_objects with migration tag v2.
export { Sandbox } from '@cloudflare/sandbox';

// Generation, verification, and automations run as durable Workflows
// (bindings GEN_WORKFLOW / VERIFY_WORKFLOW / AUTOMATION_WORKFLOW in
// wrangler.jsonc): memoized steps, bounded retries, no wall-clock kills.
export { GenerationWorkflow } from './ai/workflows/generation.ts';
export { VerificationWorkflow };
export { FixWorkflow };
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
          break;
        case 'plan_refine':
          await runPlanRefine(body.planId);
          break;
        case 'verify':
          // Just creates a durable workflow instance — verify runs exceed
          // the consumer wall clock routinely (launch discovery + demos).
          await startVerification(body.featureId);
          break;
        case 'automation':
          await startAutomationRun(body.automationId);
          break;
        case 'resolve_conflict':
          // A new message kind must not silently fall into the `default`
          // (fix) branch and mis-dispatch.
          await startResolveConflict(body);
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
  },
};

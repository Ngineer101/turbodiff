// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
//   - Named exports become top-level Worker exports — e.g. application-owned
//     Durable Object classes (declare their bindings in wrangler.jsonc).
//   - An optional default export adds non-HTTP handlers: scheduled (cron),
//     queue consumers, inbound email, etc. (never `fetch`).
//
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint

import {
  startAutomationRun,
  AutomationWorkflow,
  type AutomationQueueMessage,
} from './lib/automation-workflow.ts';
import { pollAutomations } from './lib/automation-poll.ts';
import { startFix, FixWorkflow } from './lib/fix-workflow.ts';
import { type FixQueueMessage } from './lib/fixer.ts';
import { startGeneration, type GenQueueMessage } from './lib/generation-workflow.ts';
import { runPlanAnalyze, runPlanRefine, type PlanQueueMessage } from './lib/planner.ts';
import { startVerification, VerificationWorkflow } from './lib/verification-workflow.ts';
import { type VerifyQueueMessage } from './lib/verifier.ts';

// The fixer sandbox container (docs/software-factory-design.md). Declared in
// wrangler.jsonc under containers/durable_objects with migration tag v2.
export { Sandbox } from '@cloudflare/sandbox';

// Generation, verification, and automations run as durable Workflows
// (bindings GEN_WORKFLOW / VERIFY_WORKFLOW / AUTOMATION_WORKFLOW in
// wrangler.jsonc): memoized steps, bounded retries, no wall-clock kills.
export { GenerationWorkflow } from './lib/generation-workflow.ts';
export { VerificationWorkflow };
export { FixWorkflow };
export { AutomationWorkflow };

// Fix and generation runs take minutes, far beyond what a webhook or intake
// request can wait on, so producers enqueue and these consumers do the work.
// Both processors never throw (failures land in fix_attempts / features), so
// every message acks — a broken run is not retried into repeat token spend.
type FactoryMessage =
  | AutomationQueueMessage
  | FixQueueMessage
  | GenQueueMessage
  | PlanQueueMessage
  | VerifyQueueMessage;

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
        default:
          // Fix runs get the same no-wall-clock treatment as generation
          // and verification: the consumer just creates the instance.
          await startFix(body);
      }
      message.ack();
    }
  },

  // Fixed-interval poll for due automations (src/lib/automation-poll.ts) —
  // schedule precision is bounded by the cron interval in wrangler.jsonc.
  async scheduled(): Promise<void> {
    await pollAutomations();
  },
};

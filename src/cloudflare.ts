// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
//   - Named exports become top-level Worker exports — e.g. application-owned
//     Durable Object classes (declare their bindings in wrangler.jsonc).
//   - An optional default export adds non-HTTP handlers: scheduled (cron),
//     queue consumers, inbound email, etc. (never `fetch`).
//
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint

import { processFixMessage, type FixQueueMessage } from './lib/fixer.ts';
import { startGeneration, type GenQueueMessage } from './lib/generation-workflow.ts';
import { runPlanAnalyze, runPlanRefine, type PlanQueueMessage } from './lib/planner.ts';
import { runVerification, type VerifyQueueMessage } from './lib/verifier.ts';

// The fixer sandbox container (docs/software-factory-design.md). Declared in
// wrangler.jsonc under containers/durable_objects with migration tag v2.
export { Sandbox } from '@cloudflare/sandbox';

// Generation runs as a durable Workflow (binding GEN_WORKFLOW in
// wrangler.jsonc): memoized steps, bounded retries, no wall-clock kills.
export { GenerationWorkflow } from './lib/generation-workflow.ts';

// Fix and generation runs take minutes, far beyond what a webhook or intake
// request can wait on, so producers enqueue and these consumers do the work.
// Both processors never throw (failures land in fix_attempts / features), so
// every message acks — a broken run is not retried into repeat token spend.
type FactoryMessage = FixQueueMessage | GenQueueMessage | PlanQueueMessage | VerifyQueueMessage;

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
					await runVerification(body.featureId);
					break;
				default:
					await processFixMessage(body);
			}
			message.ack();
		}
	},
};

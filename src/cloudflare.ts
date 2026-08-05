// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
//   - Named exports become top-level Worker exports — e.g. application-owned
//     Durable Object classes (declare their bindings in wrangler.jsonc).
//   - An optional default export adds non-HTTP handlers: scheduled (cron),
//     queue consumers, inbound email, etc. (never `fetch`).
//
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint

import { processFixMessage, type FixQueueMessage } from './lib/fixer.ts';
import { runGeneration, type GenQueueMessage } from './lib/generator.ts';

// The fixer sandbox container (docs/software-factory-design.md). Declared in
// wrangler.jsonc under containers/durable_objects with migration tag v2.
export { Sandbox } from '@cloudflare/sandbox';

// Fix and generation runs take minutes, far beyond what a webhook or intake
// request can wait on, so producers enqueue and these consumers do the work.
// Both processors never throw (failures land in fix_attempts / features), so
// every message acks — a broken run is not retried into repeat token spend.
export default {
	async queue(batch: MessageBatch<FixQueueMessage | GenQueueMessage>): Promise<void> {
		for (const message of batch.messages) {
			if (message.body.kind === 'generate') {
				await runGeneration(message.body.featureId);
			} else {
				await processFixMessage(message.body);
			}
			message.ack();
		}
	},
};

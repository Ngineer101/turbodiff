// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
//   - Named exports become top-level Worker exports — e.g. application-owned
//     Durable Object classes (declare their bindings in wrangler.jsonc).
//   - An optional default export adds non-HTTP handlers: scheduled (cron),
//     queue consumers, inbound email, etc. (never `fetch`).
//
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint

import { processFixMessage, type FixQueueMessage } from './lib/fixer.ts';

// The fixer sandbox container (docs/software-factory-design.md). Declared in
// wrangler.jsonc under containers/durable_objects with migration tag v2.
export { Sandbox } from '@cloudflare/sandbox';

// Auto-fix runs take minutes, far beyond what a webhook request can wait on,
// so the pull_request_review webhook enqueues and this consumer does the work.
// processFixMessage never throws (failures are recorded in fix_attempts), so
// every message acks — a broken fix run is not retried into repeat token spend.
export default {
	async queue(batch: MessageBatch<FixQueueMessage>): Promise<void> {
		for (const message of batch.messages) {
			await processFixMessage(message.body);
			message.ack();
		}
	},
};

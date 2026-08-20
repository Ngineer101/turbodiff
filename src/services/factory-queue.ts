import { env } from 'cloudflare:workers';
import type { FactoryMessage } from '../shared/factory-messages.ts';

// Wrangler cannot infer the producer body type from configuration, so the
// generated binding is Queue<unknown>. Narrow it once at this application
// boundary instead of letting every producer send an unchecked object.
function factoryQueue(): Queue<FactoryMessage> {
  // SAFETY: every producer is constrained by enqueueFactoryMessage's
  // FactoryMessage parameter and this is the only producer binding access.
  return env.FACTORY_QUEUE as Queue<FactoryMessage>;
}

export async function enqueueFactoryMessage(
  message: FactoryMessage,
  options?: QueueSendOptions,
): Promise<void> {
  await factoryQueue().send(message, { ...options, contentType: 'json' });
}

export async function enqueueFactoryMessages(messages: FactoryMessage[]): Promise<void> {
  await Promise.all(messages.map((message) => enqueueFactoryMessage(message)));
}

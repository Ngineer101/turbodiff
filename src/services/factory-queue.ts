import { env } from 'cloudflare:workers';
import type { FactoryMessage } from '../shared/factory-messages.ts';

export async function enqueueFactoryMessage(
  message: FactoryMessage,
  options?: QueueSendOptions,
): Promise<void> {
  await env.FACTORY_QUEUE.send(message, { ...options, contentType: 'json' });
}

export async function enqueueFactoryMessages(messages: FactoryMessage[]): Promise<void> {
  await Promise.all(messages.map((message) => enqueueFactoryMessage(message)));
}

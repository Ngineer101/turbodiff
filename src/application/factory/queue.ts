import { env } from 'cloudflare:workers';
import type { RunFactoryMessage } from './message.ts';

export async function enqueueFactoryMessage(
  message: RunFactoryMessage,
  options?: QueueSendOptions,
): Promise<void> {
  await env.FACTORY_QUEUE.send(message, { ...options, contentType: 'json' });
}

export async function enqueueFactoryMessages(messages: RunFactoryMessage[]): Promise<void> {
  await Promise.all(messages.map((message) => enqueueFactoryMessage(message)));
}

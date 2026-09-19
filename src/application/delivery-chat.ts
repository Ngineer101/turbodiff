import { createDeliveryChatTurn } from '../data/deliveries.ts';
import { CHAT_FLOW } from './factory/flows.ts';
import type { RunFactoryMessage } from './factory/message.ts';

export async function sendDeliveryChatMessage(
  input: { deliveryId: number; organizationId: string; authorUserId: string; body: string },
  enqueue: (message: RunFactoryMessage) => Promise<void>,
) {
  const result = await createDeliveryChatTurn({
    ...input,
    flowKey: CHAT_FLOW.key,
    flowVersion: CHAT_FLOW.version,
    stageKey: CHAT_FLOW.initialStage,
  });
  if (result.kind === 'accepted') {
    try {
      await enqueue({
        kind: 'run_factory',
        factoryRunId: result.factoryRun.id,
        stageRunId: result.stageRun.id,
      });
    } catch (error) {
      console.warn('turbodiff: chat enqueue deferred to factory recovery', error);
    }
  }
  return result;
}

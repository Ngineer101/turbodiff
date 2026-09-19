import { deliveryCandidates } from '../../data/delivery-lifecycle.ts';
import { reconcileChangeDelivery } from './delivery-lifecycle.ts';
import { listRecoverableFactoryStages } from '../../data/execution.ts';
import { enqueueFactoryMessages } from './queue.ts';

export async function recoverFactoryStages(): Promise<void> {
  for (const change of await deliveryCandidates()) {
    try {
      await reconcileChangeDelivery(change.id);
    } catch (error) {
      console.warn('turbodiff: delivery recovery failed', change.id, error);
    }
  }
  const stages = await listRecoverableFactoryStages();
  await enqueueFactoryMessages(
    stages.map((stage) => ({
      kind: 'run_factory',
      factoryRunId: stage.factory_run_id,
      stageRunId: stage.stage_run_id,
    })),
  );
}

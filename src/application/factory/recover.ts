import { listRecoverableFactoryStages } from '../../data/db.ts';
import { enqueueFactoryMessages } from './queue.ts';

export async function recoverFactoryStages(): Promise<void> {
  const stages = await listRecoverableFactoryStages();
  await enqueueFactoryMessages(
    stages.map((stage) => ({
      kind: 'run_factory',
      factoryRunId: stage.factory_run_id,
      stageRunId: stage.stage_run_id,
    })),
  );
}

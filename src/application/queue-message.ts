import { Schema } from 'effect';
import {
  RunFactoryMessage,
  type RunFactoryMessage as RunFactoryMessageType,
} from './factory/message.ts';

const PositiveInt = Schema.Int.pipe(Schema.positive());
const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

export interface AiGatewayUsageReference {
  logId: string;
  organizationId: string;
  agentRunId: number;
}

export const TrackAiGatewayUsageMessage = Schema.Struct({
  kind: Schema.Literal('track_ai_gateway_usage'),
  logId: NonEmptyString,
  organizationId: NonEmptyString,
  agentRunId: PositiveInt,
});
export type TrackAiGatewayUsageMessage = typeof TrackAiGatewayUsageMessage.Type;

export const WorkerQueueMessage = Schema.Union(RunFactoryMessage, TrackAiGatewayUsageMessage);
export type WorkerQueueMessage = typeof WorkerQueueMessage.Type;

export const parseWorkerQueueMessage = Schema.decodeUnknownSync(WorkerQueueMessage);

export function aiGatewayUsageQueueMessage(
  reference: AiGatewayUsageReference,
): TrackAiGatewayUsageMessage {
  return {
    kind: 'track_ai_gateway_usage',
    ...reference,
  };
}

export interface WorkerQueueDependencies {
  startFactoryStage(message: RunFactoryMessageType): Promise<void>;
  trackAiGatewayUsage(reference: AiGatewayUsageReference): Promise<void>;
}

export interface WorkerQueueDelivery {
  readonly body: WorkerQueueMessage;
  readonly attempts: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

function usageRetryDelaySeconds(attempts: number): number {
  return Math.min(60 * 60, 2 ** Math.min(Math.max(attempts, 0), 12));
}

export async function consumeWorkerQueueMessage(
  delivery: WorkerQueueDelivery,
  dependencies: WorkerQueueDependencies,
): Promise<string | null> {
  const message = parseWorkerQueueMessage(delivery.body);
  if (message.kind === 'run_factory') {
    await dependencies.startFactoryStage(message);
    delivery.ack();
    return null;
  }

  try {
    await dependencies.trackAiGatewayUsage({
      logId: message.logId,
      organizationId: message.organizationId,
      agentRunId: message.agentRunId,
    });
    delivery.ack();
    return null;
  } catch (failure) {
    delivery.retry({ delaySeconds: usageRetryDelaySeconds(delivery.attempts) });
    return failure instanceof Error ? failure.message : 'AI Gateway usage queue delivery failed';
  }
}

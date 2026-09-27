import { describe, expect, it, vi } from 'vite-plus/test';
import {
  aiGatewayUsageQueueMessage,
  consumeWorkerQueueMessage,
  type WorkerQueueDelivery,
} from '../../../src/application/queue-message.ts';

const reference = {
  logId: 'gateway-log-123',
  organizationId: 'org-123',
  agentRunId: 42,
};

function delivery(attempts = 1) {
  return {
    body: aiGatewayUsageQueueMessage(reference),
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies WorkerQueueDelivery;
}

describe('Worker queue messages', () => {
  it('carries every durable usage identifier through the producer and consumer contract', async () => {
    const queued = delivery();
    const trackAiGatewayUsage = vi.fn().mockResolvedValue(undefined);

    await expect(
      consumeWorkerQueueMessage(queued, {
        startFactoryStage: vi.fn(),
        trackAiGatewayUsage,
      }),
    ).resolves.toBeNull();

    expect(queued.body).toEqual({ kind: 'track_ai_gateway_usage', ...reference });
    expect(trackAiGatewayUsage).toHaveBeenCalledWith(reference);
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it('durably retries a usage reference when PostgreSQL registration fails', async () => {
    const queued = delivery(4);

    await expect(
      consumeWorkerQueueMessage(queued, {
        startFactoryStage: vi.fn(),
        trackAiGatewayUsage: vi.fn().mockRejectedValue(new Error('Hyperdrive unavailable')),
      }),
    ).resolves.toBe('Hyperdrive unavailable');

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 16 });
  });

  it('preserves the existing factory message dispatch contract', async () => {
    const queued = {
      body: { kind: 'run_factory', factoryRunId: 12, stageRunId: 34 } as const,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const startFactoryStage = vi.fn().mockResolvedValue(undefined);

    await consumeWorkerQueueMessage(queued, {
      startFactoryStage,
      trackAiGatewayUsage: vi.fn(),
    });

    expect(startFactoryStage).toHaveBeenCalledWith(queued.body);
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });
});

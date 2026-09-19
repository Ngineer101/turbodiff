import { afterEach, expect, it, vi } from 'vite-plus/test';
import { getDeliveryChat } from '../../../../src/client/lib/backend.ts';
import { pendingTurn } from '../../../../src/client/lib/chat-rail.ts';

afterEach(() => vi.unstubAllGlobals());

it('keeps queued and running server turns pending and exposes failures and replies', async () => {
  vi.stubGlobal('location', { origin: 'https://turbodiff.test', pathname: '/' });
  let status = 'queued';
  vi.stubGlobal('fetch', async () =>
    Response.json({
      items: [
        {
          id: 1,
          role: 'user',
          body: 'Fix the check',
          authorUserId: 'user',
          createdAt: '2026-09-19T17:45:00Z',
          factoryRunId: 3,
          status,
          outcome: null,
          commitSha: null,
          error: status === 'failed' ? 'Check failed' : null,
        },
      ],
    }),
  );
  expect(pendingTurn((await getDeliveryChat(1)).messages)?.status).toBe('queued');
  status = 'running';
  expect(pendingTurn((await getDeliveryChat(1)).messages)?.status).toBe('running');
  status = 'failed';
  const failed = await getDeliveryChat(1);
  expect(pendingTurn(failed.messages)).toBeNull();
  expect(failed.messages[0]).toMatchObject({ status: 'failed', error: 'Check failed' });
  status = 'succeeded';
  expect((await getDeliveryChat(1)).messages[0].status).toBe('done');
});

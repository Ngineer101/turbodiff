import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  getDeliveryChat,
  sendDeliveryMessage,
  sendDeliveryChatTurn,
} from '../../../../src/client/lib/backend.ts';
import { pendingTurn } from '../../../../src/client/lib/chat-rail.ts';

afterEach(() => vi.unstubAllGlobals());

it('uses separate endpoints for saved feedback and executable agent-chat turns', async () => {
  vi.stubGlobal('location', { origin: 'https://turbodiff.test', pathname: '/' });
  const paths: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    paths.push(path);
    const chat = path.endsWith('/chat-turns');
    return Response.json(
      {
        id: 1,
        role: 'user',
        body: 'Feedback',
        authorUserId: 'user',
        createdAt: '2026-09-19T17:45:00Z',
        factoryRunId: chat ? 3 : null,
        status: chat ? 'queued' : null,
        outcome: null,
        commitSha: null,
        error: null,
      },
      { status: chat ? 202 : 201 },
    );
  });
  expect((await sendDeliveryMessage(1, 'Save this feedback')).factoryRunId).toBeNull();
  expect((await sendDeliveryChatTurn(1, 'Act on this request')).status).toBe('queued');
  expect(paths).toEqual(['/api/deliveries/1/messages', '/api/deliveries/1/chat-turns']);
});

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

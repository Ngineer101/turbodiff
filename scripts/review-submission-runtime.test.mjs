// Real Flue dispatch, tools, finish hooks and SQLite conversation persistence.
// Only the model and the application review-store boundary are local fixtures;
// no provider credentials, network requests or AI credits are used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineTool, init, useDelivery, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { useReviewSubmissionGuard } from '../src/ai/review/submission-guard.ts';

await test('prose-only completion continues to real submission, including a second review in the same conversation', async () => {
  const rows = new Map([
    [1, 'running'],
    [2, 'running'],
  ]);
  const published = [];
  const provider = fauxProvider({ provider: 'review-test', models: [{ id: 'reviewer' }] });
  function Reviewer() {
    const delivery = useDelivery();
    const id = Number(delivery.attributes.review_id);
    useModel('review-test/reviewer');
    useReviewSubmissionGuard(id, async () => rows.get(id) ?? null);
    useTool(
      defineTool({
        name: 'post_review',
        description: 'Publish the review',
        input: v.object({}),
        run: async () => {
          published.push(id);
          rows.set(id, 'completed');
          return { output: { posted: true } };
        },
      }),
    );
    return 'Review and call post_review.';
  }
  const runtime = await start({ agents: [Reviewer], providers: [provider.provider], env: {} });
  try {
    const agent = init(Reviewer, { id: 'repeat-review' });
    for (const id of [1, 2]) {
      provider.setResponses([
        fauxAssistantMessage("I'm posting a clean approval."),
        (context) => {
          assert.match(JSON.stringify(context.messages), /This review is still unsubmitted/);
          assert.equal(rows.get(id), 'running');
          return fauxAssistantMessage(fauxToolCall('post_review', {}, { id: 'call_post_review' }), {
            stopReason: 'toolUse',
          });
        },
        fauxAssistantMessage('Posted.'),
      ]);
      const receipt = await agent.dispatch({
        message: {
          kind: 'signal',
          type: 'review.request',
          body: 'Review this change.',
          attributes: { review_id: String(id) },
        },
      });
      await agent.read(receipt);
      assert.equal(rows.get(id), 'completed');
      assert.deepEqual(published, id === 1 ? [1] : [1, 2]);
      assert.equal(provider.getPendingResponseCount(), 0);
    }
  } finally {
    await runtime.stop();
  }
});

await test('a non-throwing post_review that does not complete the row cannot pass the guard or loop indefinitely', async () => {
  const provider = fauxProvider({ provider: 'unsubmitted-test', models: [{ id: 'reviewer' }] });
  let calls = 0;
  function Reviewer() {
    useModel('unsubmitted-test/reviewer');
    useReviewSubmissionGuard(3, async () => 'running');
    useTool(
      defineTool({
        name: 'post_review',
        description: 'Publish the review',
        input: v.object({}),
        run: async () => {
          calls++;
          return { output: { posted: false } };
        },
      }),
    );
    return 'Review and call post_review.';
  }
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('post_review', {}, { id: 'call_post_review' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Posted.'),
    fauxAssistantMessage('I already posted it.'),
  ]);
  const runtime = await start({ agents: [Reviewer], providers: [provider.provider], env: {} });
  try {
    const agent = init(Reviewer, { id: 'unsatisfied-review' });
    const receipt = await agent.dispatch('Review this change.');
    await assert.rejects(agent.read(receipt), (error) => {
      assert.equal(error.outcome, 'failed');
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(provider.state.callCount, 3);
  } finally {
    await runtime.stop();
  }
});

/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createFeature,
  createUserChatMessage,
  getChatMessage,
  listChatMessages,
  setChatMessageStatus,
  tryRecordFixAttempt,
  updateFeature,
} from '../../data/db.ts';
import {
  processChatMessage,
  type ChatProcessorDependencies,
  type ChatTurnResult,
} from './chat.ts';
import { CHAT_BUSY_RETRIES } from '../../shared/factory-messages.ts';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
type ExecuteTurn = NonNullable<ChatProcessorDependencies['runChatTurn']>;
// SAFETY: vitest.worker.config.ts defines the test-only TEST_MIGRATIONS
// miniflare binding, which the generated production Cloudflare.Env cannot
// know about.
const testEnv = env as TestEnv;

const noChanges: ChatTurnResult = {
  reply: 'Nothing to change here.',
  outcome: 'no_changes',
  fixStatus: 'no_changes',
  usage: null,
};

// auto_fix stays OFF: chat is human-supervised and must run without the
// automated-fix toggle, unlike processFixMessage.
async function seedOpenFactoryPr(): Promise<number> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO repositories (id, installation_id, owner, name, enabled, auto_fix)
		 VALUES (101, 1001, 'acme', 'api', 1, 0)`,
    ),
  ]);
  const featureId = await createFeature(101, 'Factory feature', 'Implementation spec');
  await updateFeature(featureId, { status: 'pr_opened', prNumber: 42 });
  return featureId;
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  const tables = [
    'agent_runs',
    'chat_messages',
    'fix_attempts',
    'verifications',
    'features',
    'repositories',
    'installations',
  ];
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM "${table}"`)));
});

describe('chat queue consumption', () => {
  it('runs a turn without auto-fix, records the attempt, and stores the reply', async () => {
    const featureId = await seedOpenFactoryPr();
    const chatMessageId = await createUserChatMessage(featureId, 'Tweak it', 'octocat', 1);
    const runChatTurn = vi.fn<ExecuteTurn>(async () => noChanges);

    await processChatMessage({ kind: 'chat', featureId, chatMessageId }, { runChatTurn });

    expect(runChatTurn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'api',
        prNumber: 42,
        installationId: 1001,
        repositoryId: 101,
      }),
    );
    const attempt = await testEnv.DB.prepare(
      'SELECT "trigger", status FROM fix_attempts WHERE repository_id = 101 AND pr_number = 42',
    ).first<{ trigger: string; status: string }>();
    expect(attempt).toEqual({ trigger: 'chat', status: 'no_changes' });
    expect(await getChatMessage(chatMessageId)).toMatchObject({ status: 'done' });
    const messages = await listChatMessages(featureId);
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      body: 'Nothing to change here.',
      outcome: 'no_changes',
    });
  });

  it('fails the turn without spending tokens when the PR is closed or the run was interrupted', async () => {
    const featureId = await seedOpenFactoryPr();
    const runChatTurn = vi.fn<ExecuteTurn>(async () => noChanges);

    // A 'running' message on redelivery is an interrupted paid run — fail
    // closed rather than double-running it.
    const interrupted = await createUserChatMessage(featureId, 'Tweak it', 'octocat', 1);
    await setChatMessageStatus(interrupted, 'running');
    await processChatMessage(
      { kind: 'chat', featureId, chatMessageId: interrupted },
      { runChatTurn },
    );
    expect(await getChatMessage(interrupted)).toMatchObject({ status: 'failed' });

    await updateFeature(featureId, { status: 'merged' });
    const afterClose = await createUserChatMessage(featureId, 'One more', 'octocat', 1);
    await processChatMessage(
      { kind: 'chat', featureId, chatMessageId: afterClose },
      { runChatTurn },
    );
    expect(await getChatMessage(afterClose)).toMatchObject({ status: 'failed' });

    expect(runChatTurn).not.toHaveBeenCalled();
    const count = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM fix_attempts WHERE repository_id = 101 AND pr_number = 42',
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('gives up after the busy retries when another run holds the PR', async () => {
    const featureId = await seedOpenFactoryPr();
    const chatMessageId = await createUserChatMessage(featureId, 'Tweak it', 'octocat', 1);
    const runChatTurn = vi.fn<ExecuteTurn>(async () => noChanges);
    // Another sandbox run in flight on the same PR.
    expect(await tryRecordFixAttempt(101, 42, 'blocking_review', 3)).not.toBeNull();

    await processChatMessage(
      { kind: 'chat', featureId, chatMessageId, attempt: CHAT_BUSY_RETRIES },
      { runChatTurn },
    );

    expect(runChatTurn).not.toHaveBeenCalled();
    const message = await getChatMessage(chatMessageId);
    expect(message?.status).toBe('failed');
    expect(message?.error).toContain('another agent run');
  });
});

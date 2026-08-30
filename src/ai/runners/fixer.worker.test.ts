/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { testDatabase } from '../../test/database-fixture.ts';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createFeature,
  ensureBuiltinAgents,
  getFactoryRun,
  listStageRuns,
  setInstallationSuspended,
  tryRecordReview,
  updateFeature,
  upsertChange,
} from '../../data/db.ts';
import {
  fixLabel,
  processFixMessage,
  type FixOutcome,
  type FixProcessorDependencies,
} from './fixer.ts';
import type { FactoryMessage, FixQueueMessage } from '../../shared/factory-messages.ts';
import type { RunStageCommand } from '../../domain/lifecycle-contract.ts';
import {
  completeLifecycleReview,
  runLifecycleStage,
  scheduleChangeReview,
} from '../../services/lifecycle.ts';
import type { ReviewDispatcher } from '../../services/change-review.ts';

type ExecuteFix = NonNullable<FixProcessorDependencies['runFix']>;

const ciMessage: FixQueueMessage = {
  kind: 'fix',
  repoId: 101,
  prNumber: 42,
  trigger: 'ci_failure',
  workflowRunId: 9001,
};

const noChanges: FixOutcome = {
  status: 'no_changes',
  authMode: 'gateway',
  branch: 'factory/feature-42',
  agentOutput: '',
  usage: null,
};

function stageCommands(messages: FactoryMessage[]): RunStageCommand[] {
  return messages.filter((message): message is RunStageCommand => message.kind === 'run_stage');
}

async function seedOpenFactoryPr(): Promise<number> {
  await testDatabase().batch([
    testDatabase().prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testDatabase().prepare(
      `INSERT INTO repositories (id, installation_id, owner, name, enabled, auto_fix)
       VALUES (101, 1001, 'acme', 'api', TRUE, TRUE)`,
    ),
  ]);
  const featureId = await createFeature(101, 'Factory feature', 'Implementation spec');
  await updateFeature(featureId, { status: 'pr_opened', prNumber: 42 });
  return featureId;
}

beforeEach(async () => {
  const tables = [
    'agent_runs',
    'fix_attempts',
    'verifications',
    'features',
    'repositories',
    'installations',
  ];
  await testDatabase().batch(
    tables.map((table) => testDatabase().prepare(`DELETE FROM "${table}"`)),
  );
});

describe('CI fix queue consumption', () => {
  it('threads the trigger and workflow run into the fixer and records the outcome', async () => {
    await seedOpenFactoryPr();
    const runFix = vi.fn<ExecuteFix>(async () => noChanges);

    await processFixMessage(ciMessage, { runFix });

    expect(runFix).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'api',
        prNumber: 42,
        installationId: 1001,
        repositoryId: 101,
        trigger: 'ci_failure',
        workflowRunId: 9001,
      }),
    );
    const attempt = await testDatabase()
      .prepare(
        'SELECT "trigger", status FROM fix_attempts WHERE repository_id = 101 AND pr_number = 42',
      )
      .first<{ trigger: string; status: string }>();
    expect(attempt).toEqual({ trigger: 'ci_failure', status: 'no_changes' });
  });

  it('does not spend a fix attempt after the PR closes or installation is suspended', async () => {
    const featureId = await seedOpenFactoryPr();
    const runFix = vi.fn<ExecuteFix>(async () => noChanges);

    await updateFeature(featureId, { status: 'merged' });
    await processFixMessage(ciMessage, { runFix });

    await updateFeature(featureId, { status: 'pr_opened' });
    await setInstallationSuspended(1001, true);
    await processFixMessage(ciMessage, { runFix });

    expect(runFix).not.toHaveBeenCalled();
    const count = await testDatabase()
      .prepare(
        'SELECT COUNT(*) AS n FROM fix_attempts WHERE repository_id = 101 AND pr_number = 42',
      )
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('coordinator-owned repair', () => {
  it('repairs an existing human PR and schedules re-review without a feature row', async () => {
    await testDatabase().batch([
      testDatabase().prepare(
        `INSERT INTO installations (id, account_login, account_id, account_type)
         VALUES (1001, 'acme', 2001, 'Organization')`,
      ),
      testDatabase().prepare(
        `INSERT INTO repositories
          (id, installation_id, owner, name, enabled, auto_fix, review_intake, process_profile)
         VALUES (101, 1001, 'acme', 'api', TRUE, FALSE, 'all_changes', 'review_and_repair')`,
      ),
    ]);
    await ensureBuiltinAgents(1001);
    const change = await upsertChange({
      repositoryId: 101,
      providerKey: 'github:42',
      number: 42,
      origin: 'human',
      title: 'Contributor change',
      externalUrl: 'https://github.com/acme/api/pull/42',
      sourceBranch: 'contributor/topic',
      targetBranch: 'main',
      status: 'open',
      sourceHead: 'a'.repeat(40),
      targetHead: 'b'.repeat(40),
      draft: false,
      capabilities: ['read_change', 'publish_review', 'write_head', 'publish_check'],
    });
    const queued: FactoryMessage[] = [];
    const enqueue = async (message: FactoryMessage) => {
      queued.push(message);
    };
    await scheduleChangeReview({
      changeId: change.id,
      trigger: 'opened',
      idempotencyKey: 'repair-loop-42',
      enqueue,
    });
    const reviewCommand = stageCommands(queued)[0];
    if (!reviewCommand) throw new Error('review stage was not scheduled');
    const dispatch: ReviewDispatcher = async (agent, repo, prNumber, _url, trigger, options) => {
      const id = await tryRecordReview(
        repo.id,
        repo.installation_id,
        prNumber,
        trigger,
        agent.slug,
        `${agent.slug}--${repo.owner}--${repo.name}--${prNumber}`,
        options?.riskTier ?? null,
        options?.stageRunId ?? null,
      );
      return id !== null;
    };
    await runLifecycleStage(reviewCommand, dispatch, {
      computeRisk: async () => 'full',
      enqueue,
    });
    await completeLifecycleReview(
      'review--acme--api--42',
      'https://github.com/acme/api/pull/42#review',
      1,
      'request_changes',
      enqueue,
    );

    const repairCommand = stageCommands(queued).find((command) => command.stage === 'repair');
    if (!repairCommand) throw new Error('repair stage was not scheduled');
    await runLifecycleStage(repairCommand, dispatch, { enqueue });
    const fix = queued.find(
      (message): message is FixQueueMessage =>
        message.kind === 'fix' && message.stageRunId === repairCommand.stageRunId,
    );
    if (!fix) throw new Error('repair did not enqueue a fix command');
    await processFixMessage(fix, {
      runFix: async () => ({
        status: 'fixed',
        authMode: 'gateway',
        branch: 'contributor/topic',
        commit: 'c'.repeat(40),
        agentOutput: 'fixed',
        usage: null,
      }),
    });

    await expect(getFactoryRun(reviewCommand.factoryRunId)).resolves.toMatchObject({
      status: 'active',
    });
    await expect(listStageRuns(reviewCommand.factoryRunId)).resolves.toMatchObject([
      { stage: 'review', status: 'completed', attempt: 1 },
      { stage: 'repair', status: 'completed', attempt: 1 },
      { stage: 'review', status: 'queued', attempt: 2 },
    ]);
  });
});

describe('fix labels', () => {
  it.each([
    ['ci_failure', 'failing CI checks'],
    ['verification_failed', 'unmet acceptance criteria'],
    ['blocking_review', 'review findings'],
    [undefined, 'review findings'],
  ])('labels %s as %s', (trigger, expected) => {
    expect(fixLabel(trigger)).toBe(expected);
  });
});

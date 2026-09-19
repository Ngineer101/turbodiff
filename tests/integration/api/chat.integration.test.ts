import { readRepositoryChangeArtifact } from '../../../src/integrations/agent-runtime/repository-change-artifact.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { isString } from '../../../src/shared/json.ts';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  DeliveryService,
  DeliveryServiceLive,
} from '../../../src/api/server/deliveries/service.ts';
import { executeFactoryStage } from '../../../src/application/factory/execute.ts';
import {
  parseRunFactoryMessage,
  type RunFactoryMessage,
} from '../../../src/application/factory/message.ts';
import type { ChatStageRuntime } from '../../../src/application/factory/stages/chat.ts';
import { getArtifact } from '../../../src/data/artifacts.ts';
import {
  latestChangeRevision,
  updateChangeStatus,
  upsertChange,
} from '../../../src/data/changes.ts';
import { createDeliveryMessage, listDeliveryMessages } from '../../../src/data/deliveries.ts';
import {
  claimStageRun,
  getFactoryRun,
  listAgentRunsForStage,
  listRecoverableFactoryStages,
} from '../../../src/data/execution.ts';
import { execute, queryOne, withTransaction } from '../../../src/data/postgres.ts';
import {
  createDeliveries,
  createWorkItem,
  getDelivery,
  updateDeliveryStatus,
} from '../../../src/data/work.ts';
import { loadJsonArtifact } from '../../../src/application/artifacts.ts';
import { implementerInputSchema } from '../../../src/agents/implementer.ts';
import { ApiDependencies } from '../../../src/api/server/context.ts';
import {
  apiDependencies,
  createTenant,
  recordingApiDependencies,
  rollbackAfter,
  type TenantFixture,
} from './support.ts';

async function fixture(tenant: TenantFixture) {
  const work = await createWorkItem({
    organizationId: tenant.organizationId,
    origin: 'idea',
    title: 'Chat feature',
    description: 'Follow up',
    createdByUserId: tenant.userId,
    repositoryIds: [tenant.repositoryId],
  });
  const delivery = (await createDeliveries(work))[0]!;
  await updateDeliveryStatus(delivery.id, 'completed');
  const change = await upsertChange({
    organizationId: tenant.organizationId,
    repositoryId: tenant.repositoryId,
    deliveryId: delivery.id,
    providerIntegrationId: tenant.integrationId,
    providerKey: `chat:${crypto.randomUUID()}`,
    number: 185,
    title: 'Chat feature',
    sourceRef: 'feature',
    targetRef: 'main',
    origin: 'factory',
  });
  return { delivery, change };
}

function service(messages: RunFactoryMessage[]) {
  return DeliveryServiceLive.pipe(Layer.provide(recordingApiDependencies(messages)));
}

function send(
  tenant: TenantFixture,
  deliveryId: number,
  messages: RunFactoryMessage[],
  body = 'Fix the failing check',
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* DeliveryService).createMessage(tenant.user, deliveryId, body);
    }).pipe(Effect.provide(service(messages))),
  );
}

// Only the paid agent and remote credentials/provider API are faked. Checkout,
// commit, checks, and push execute their production shell against a real Git
// remote. The database, dispatcher, tracked artifacts, and chat API stay real.
function localRuntime(root: string, changeFiles: boolean, onInvoke?: () => Promise<void>) {
  const origin = join(root, 'origin');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', origin, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  mkdirSync(origin);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  writeFileSync(join(origin, 'base.txt'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  writeFileSync(join(origin, 'feature.txt'), 'existing feature');
  git('add', '.');
  git('commit', '-qm', 'existing feature');
  const originalHead = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const path = (value: string) => value.replaceAll('/workspace', root);
  let invocations = 0;
  const runtime: ChatStageRuntime = {
    remote: async () => ({
      provider: 'github',
      authUrl: '$GIT_REMOTE',
      cleanUrl: origin,
      configFlags: '',
      env: { GIT_REMOTE: origin },
      token: '',
    }),
    assertWritable: async () => undefined,
    sandbox: () => ({
      exec: async (command, options) => {
        const result = spawnSync('bash', ['-c', path(command)], {
          encoding: 'utf8',
          cwd: options?.cwd ? path(options.cwd) : root,
          env: { ...process.env, ...options?.env },
        });
        return {
          success: result.status === 0,
          exitCode: result.status ?? 1,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          command,
          timestamp: new Date().toISOString(),
          duration: 0,
        };
      },
      writeFile: async (file, contents) => {
        if (!isString(contents)) throw new Error('Test sandbox only accepts text files');
        writeFileSync(path(file), contents);
        return { success: true, path: file, timestamp: new Date().toISOString() };
      },
    }),
    invoke: async (
      _agent,
      repository,
      workDir,
      _prompt,
      summaryFile,
      notesFile,
      request,
      output,
    ) => {
      invocations += 1;
      expect(request.prompt).toContain('Current user request:');
      if (changeFiles) writeFileSync(join(path(workDir), 'fix.txt'), 'fixed');
      writeFileSync(
        path(summaryFile),
        changeFiles ? 'Fixed the failing check' : 'The existing feature works as follows.',
      );
      await onInvoke?.();
      return {
        artifact: await readRepositoryChangeArtifact(
          {
            exec: runtime.sandbox(repository).exec,
            readFile: async (file) => ({ content: readFileSync(path(file), 'utf8') }),
          },
          workDir,
          output,
          { summary: summaryFile, notes: notesFile },
        ),
        run: {
          success: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          resultText: 'Finished',
          codingSessionId: null,
          usage: null,
          command: 'test-agent',
          timestamp: new Date().toISOString(),
          duration: 0,
        },
      };
    },
  };
  return { runtime, git, originalHead, invocations: () => invocations };
}

describe('delivery chat execution', () => {
  it('fails an interrupted turn visibly without rerunning a possible publication', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const { delivery } = await fixture(tenant);
      const messages: RunFactoryMessage[] = [];
      await send(tenant, delivery.id, messages);
      await claimStageRun(messages[0].stageRunId);
      await executeFactoryStage(messages[0]);
      expect((await listDeliveryMessages(delivery.id))[0]).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('interrupted'),
      });
      expect(await listAgentRunsForStage(messages[0].stageRunId)).toEqual([]);
    }));

  it.each(['concurrent push', 'revoked access'] as const)(
    'does not publish over %s while the agent is working',
    (scenario) =>
      rollbackAfter(async () => {
        const tenant = await createTenant();
        const { delivery } = await fixture(tenant);
        const messages: RunFactoryMessage[] = [];
        await send(tenant, delivery.id, messages);
        const root = mkdtempSync(join(tmpdir(), 'turbodiff-chat-'));
        try {
          const local = localRuntime(root, true, async () => {
            if (scenario === 'revoked access') {
              await execute(
                sql`UPDATE auth.member SET role = 'member' WHERE "organizationId" = ${tenant.organizationId}`,
              );
            } else {
              local.git('checkout', '-q', 'feature');
              writeFileSync(join(root, 'origin', 'human.txt'), 'concurrent human edit');
              local.git('add', '.');
              local.git('commit', '-qm', 'human edit');
              local.git('checkout', '-q', 'main');
            }
          });
          await executeFactoryStage(messages[0], local.runtime);
          expect((await listDeliveryMessages(delivery.id))[0]).toMatchObject({
            status: 'failed',
            error: expect.stringContaining(
              scenario === 'revoked access' ? 'access was revoked' : 'Push failed',
            ),
          });
          expect(local.git('ls-tree', '--name-only', 'feature')).not.toContain('fix.txt');
          if (scenario === 'concurrent push')
            expect(local.git('show', 'feature:human.txt')).toBe('concurrent human edit');
          else expect(local.git('rev-parse', 'feature')).toBe(local.originalHead);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it('queues durable ids, updates the existing branch, saves a reply and real status, and ignores duplicate delivery', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const { delivery, change } = await fixture(tenant);
      const messages: RunFactoryMessage[] = [];
      await createDeliveryMessage({ delivery, role: 'user', body: 'Earlier context to preserve' });
      const accepted = await send(tenant, delivery.id, messages);
      expect(accepted.status).toBe('queued');
      expect(messages).toEqual([
        {
          kind: 'run_factory',
          factoryRunId: accepted.factoryRunId,
          stageRunId: expect.any(Number),
        },
      ]);
      const queued = parseRunFactoryMessage(messages[0]);
      const root = mkdtempSync(join(tmpdir(), 'turbodiff-chat-'));
      try {
        const local = localRuntime(root, true, async () => {
          expect((await listDeliveryMessages(delivery.id)).at(-1)?.status).toBe('running');
        });
        await executeFactoryStage(queued, local.runtime);
        await executeFactoryStage(queued, local.runtime);
        expect(local.invocations()).toBe(1);
        const head = local.git('rev-parse', 'feature');
        expect(head).not.toBe(local.originalHead);
        expect(local.git('show', 'feature:feature.txt')).toBe('existing feature');
        expect(local.git('show', 'feature:fix.txt')).toBe('fixed');
        expect(local.git('rev-parse', 'feature^')).toBe(local.originalHead);
        const transcript = await listDeliveryMessages(delivery.id);
        expect(transcript).toHaveLength(3);
        expect(transcript[1]).toMatchObject({ status: 'succeeded', error: null });
        expect(transcript[2]).toMatchObject({
          role: 'assistant',
          body: 'Fixed the failing check',
          outcome: 'changed',
          commit_sha: head,
        });
        expect((await latestChangeRevision(change.id))?.head_sha).toBe(head);
        const [agent] = await listAgentRunsForStage(queued.stageRunId);
        expect(agent.status).toBe('succeeded');
        const input = await loadJsonArtifact(
          (await getArtifact(agent.input_artifact_id))!,
          implementerInputSchema,
        );
        expect(input).toMatchObject({
          operation: 'implement',
          instructions: expect.stringContaining('Earlier context to preserve'),
        });
        expect((await getDelivery(delivery.id))?.status).toBe('completed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }));

  it('answers without an edit and allows the next turn after completion', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const { delivery } = await fixture(tenant);
      const skill = await queryOne<{ id: number }>(sql`
        INSERT INTO app.skills (organization_id, slug, name, content, content_hash)
        VALUES (${tenant.organizationId}, 'test-guidance', 'Test guidance', 'Explain clearly.', 'hash') RETURNING id
      `);
      await execute(sql`INSERT INTO app.repository_skills (repository_id, skill_id, organization_id)
        VALUES (${tenant.repositoryId}, ${skill!.id}, ${tenant.organizationId})`);
      const messages: RunFactoryMessage[] = [];
      await send(tenant, delivery.id, messages, 'Explain the feature');
      const root = mkdtempSync(join(tmpdir(), 'turbodiff-chat-'));
      try {
        const local = localRuntime(root, false);
        await executeFactoryStage(messages[0], local.runtime);
        expect(local.git('rev-parse', 'feature')).toBe(local.originalHead);
        expect((await listDeliveryMessages(delivery.id)).at(-1)).toMatchObject({
          body: 'The existing feature works as follows.',
          outcome: 'no_changes',
          commit_sha: null,
        });
        expect((await send(tenant, delivery.id, messages)).status).toBe('queued');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }));

  it('surfaces check failures without pushing or failing the completed delivery', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const { delivery } = await fixture(tenant);
      await execute(
        sql`UPDATE app.repositories SET settings = '{"checkCommand":"exit 1"}'::jsonb WHERE id = ${tenant.repositoryId}`,
      );
      const messages: RunFactoryMessage[] = [];
      await send(tenant, delivery.id, messages);
      const root = mkdtempSync(join(tmpdir(), 'turbodiff-chat-'));
      try {
        const local = localRuntime(root, true);
        await executeFactoryStage(messages[0], local.runtime);
        expect(local.git('rev-parse', 'feature')).toBe(local.originalHead);
        const transcript = await listDeliveryMessages(delivery.id);
        expect(transcript).toHaveLength(1);
        expect(transcript[0]).toMatchObject({
          status: 'failed',
          error: expect.stringContaining('Repository check failed'),
        });
        expect((await getDelivery(delivery.id))?.status).toBe('completed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }));

  it('denies other tenants, members, closed changes, and competing turns without persisting extra messages', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const other = await createTenant();
      const { delivery, change } = await fixture(tenant);
      const messages: RunFactoryMessage[] = [];
      await expect(send(other, delivery.id, messages)).rejects.toThrow('Unknown delivery');
      await execute(
        sql`UPDATE auth.member SET role = 'member' WHERE "organizationId" = ${tenant.organizationId}`,
      );
      await expect(send(tenant, delivery.id, messages)).rejects.toThrow(
        'Organization admin role required',
      );
      await execute(
        sql`UPDATE auth.member SET role = 'owner' WHERE "organizationId" = ${tenant.organizationId}`,
      );
      await updateChangeStatus(change.id, 'closed');
      await expect(send(tenant, delivery.id, messages)).rejects.toThrow(
        'Chat requires an open change',
      );
      expect(await listDeliveryMessages(delivery.id)).toEqual([]);
      expect(messages).toEqual([]);
      await updateChangeStatus(change.id, 'open');
      await send(tenant, delivery.id, messages);
      await expect(send(tenant, delivery.id, messages)).rejects.toThrow('already working');
      expect(await listDeliveryMessages(delivery.id)).toHaveLength(1);
      expect(messages).toHaveLength(1);
      const foreign = await fixture(other);
      await expect(
        withTransaction(() =>
          createDeliveryMessage({
            delivery: foreign.delivery,
            factoryRunId: messages[0].factoryRunId,
            role: 'assistant',
            body: 'Must not cross tenants',
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23503' } });
      expect(await listDeliveryMessages(foreign.delivery.id)).toEqual([]);
    }));

  it('revalidates a closed change before agent execution', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const { delivery, change } = await fixture(tenant);
      const messages: RunFactoryMessage[] = [];
      await send(tenant, delivery.id, messages);
      await updateChangeStatus(change.id, 'merged');
      // Any attempted real sandbox access would throw in this test environment.
      await executeFactoryStage(messages[0]);
      expect((await listDeliveryMessages(delivery.id))[0]).toMatchObject({
        status: 'failed',
        error: 'The change is no longer open',
      });
      expect(await listAgentRunsForStage(messages[0].stageRunId)).toEqual([]);
    }));

  it('retains an accepted turn for recovery when queue delivery fails', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      const { delivery } = await fixture(tenant);
      const dependencies = {
        ...apiDependencies([]),
        enqueueFactory: async () => {
          throw new Error('queue unavailable');
        },
      };
      const accepted = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* DeliveryService).createMessage(tenant.user, delivery.id, 'Fix it');
        }).pipe(
          Effect.provide(
            DeliveryServiceLive.pipe(Layer.provide(Layer.succeed(ApiDependencies, dependencies))),
          ),
        ),
      );
      expect(accepted.status).toBe('queued');
      expect(await listRecoverableFactoryStages()).toContainEqual({
        factory_run_id: accepted.factoryRunId,
        stage_run_id: expect.any(Number),
      });
      expect((await getFactoryRun(accepted.factoryRunId!))?.status).toBe('queued');
      expect(
        await queryOne<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM app.delivery_messages WHERE delivery_id = ${delivery.id}`,
        ),
      ).toEqual({ count: 1 });
    }));
});

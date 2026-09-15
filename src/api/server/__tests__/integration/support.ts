import { sql } from 'drizzle-orm';
import { Layer } from 'effect';
import type { CurrentUserIdentity } from '../../../contract/auth.ts';
import { ApiDependencies } from '../../context.ts';
import { execute, queryOne, withTransaction } from '../../../../data/postgres.ts';
import { createSkillsShClient } from '../../../../integrations/skills-sh/client.ts';
import type { RunFactoryMessage } from '../../../../shared/factory-messages.ts';

const rollback = Symbol('rollback service integration test');

export interface TenantFixture {
  readonly user: CurrentUserIdentity;
  readonly organizationId: string;
  readonly userId: string;
  readonly integrationId: number;
  readonly repositoryId: number;
  readonly agentId: number;
}

export async function rollbackAfter(run: () => Promise<void>): Promise<void> {
  let completed = false;
  try {
    await withTransaction(async () => {
      await run();
      completed = true;
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (!completed) throw new Error('integration test transaction did not complete');
}

export function recordingApiDependencies(messages: RunFactoryMessage[]) {
  return Layer.succeed(ApiDependencies, {
    authenticate: async () => null,
    enqueueFactory: async (message) => {
      messages.push({ ...message });
    },
    githubAppSlug: 'integration-test',
    vapidPublicKey: 'integration-test',
    skillsSh: createSkillsShClient(undefined),
  });
}

export async function createTenant(role: 'owner' | 'admin' | 'member' = 'owner') {
  const suffix = crypto.randomUUID();
  const userId = `test-user-${suffix}`;
  const organizationId = `test-org-${suffix}`;
  const now = new Date().toISOString();

  await execute(sql`
    INSERT INTO auth."user" (id, name, email, "createdAt", "updatedAt")
    VALUES (${userId}, 'Integration Test', ${`${suffix}@example.test`}, ${now}, ${now})
  `);
  await execute(sql`
    INSERT INTO auth."organization" (id, name, slug, "createdAt")
    VALUES (${organizationId}, 'Integration Test', ${`test-${suffix}`}, ${now})
  `);
  await execute(sql`
    INSERT INTO auth."member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`test-member-${suffix}`}, ${organizationId}, ${userId}, ${role}, ${now})
  `);

  const integration = await queryOne<{ id: number }>(sql`
    INSERT INTO app.integrations (
      organization_id, kind, provider, name, external_account_id
    ) VALUES (
      ${organizationId}, 'scm', 'github', 'GitHub', ${`account-${suffix}`}
    )
    RETURNING id
  `);
  if (!integration) throw new Error('integration fixture insert returned no row');

  const repository = await queryOne<{ id: number }>(sql`
    INSERT INTO app.repositories (
      organization_id, source_integration_id, external_id, owner, name, default_branch
    ) VALUES (
      ${organizationId}, ${integration.id}, ${`repository-${suffix}`},
      'turbodiff-test', ${`repo-${suffix}`}, 'main'
    )
    RETURNING id
  `);
  if (!repository) throw new Error('repository fixture insert returned no row');

  const agent = await queryOne<{ id: number }>(sql`
    INSERT INTO app.agents (organization_id, definition_key, slug, name)
    VALUES (${organizationId}, 'planner', 'planner', 'Planner')
    RETURNING id
  `);
  if (!agent) throw new Error('agent fixture insert returned no row');

  return {
    user: {
      session: { authUserId: userId, githubUserId: null, login: null },
      organizationIds: [organizationId],
      activeOrganizationId: organizationId,
      githubConnected: false,
      githubStatus: 'not_connected',
      name: 'Integration Test',
    },
    organizationId,
    userId,
    integrationId: integration.id,
    repositoryId: repository.id,
    agentId: agent.id,
  } satisfies TenantFixture;
}

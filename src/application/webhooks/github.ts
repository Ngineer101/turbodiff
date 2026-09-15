import { z } from 'zod';
import {
  createFactoryRunWithStage,
  disableRepositoriesForIntegration,
  ensureGithubOrganization,
  findAuthUserByGithubId,
  getIntegration,
  getIntegrationByExternalAccount,
  getRepositoryByExternalId,
  getRepositoryByProviderExternalId,
  removeRepositories,
  updateIntegration,
  upsertChange,
  upsertExternalIntegration,
  upsertRepositories,
} from '../../data/db.ts';
import { isJsonObject, type JsonObject, type JsonValue } from '../../shared/json.ts';
import { enqueueFactoryMessage } from '../factory/queue.ts';
import { REVIEW_FLOW } from '../factory/flows.ts';
import { syncGithubChangeRevision } from '../changes/github-revision.ts';

const webhookRepository = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  full_name: z.string(),
  default_branch: z.string().optional(),
});
const installationEvent = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number().int().positive(),
    account: z.object({ login: z.string(), id: z.number().int().positive(), type: z.string() }),
  }),
  repositories: z.array(webhookRepository).optional(),
  repositories_added: z.array(webhookRepository).optional(),
  repositories_removed: z.array(webhookRepository).optional(),
  sender: z.object({ id: z.number().int().positive(), login: z.string() }).optional(),
});
const pullRequestEvent = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  installation: z.object({ id: z.number().int().positive() }).optional(),
  pull_request: z.object({
    draft: z.boolean(),
    html_url: z.string(),
    merged: z.boolean().optional(),
    title: z.string().optional(),
    user: z.object({ type: z.string() }).nullable().optional(),
    head: z.object({ ref: z.string(), sha: z.string() }).optional(),
    base: z.object({ ref: z.string(), sha: z.string() }).optional(),
  }),
  repository: webhookRepository,
});
const repositoryEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: webhookRepository,
});

type WebhookRepository = z.infer<typeof webhookRepository>;
type InstallationEvent = z.infer<typeof installationEvent>;
type PullRequestEvent = z.infer<typeof pullRequestEvent>;
type RepositoryEvent = z.infer<typeof repositoryEvent>;

type HandlerBody = Record<string, string | number | boolean>;
export interface WebhookHandlerResult {
  body: HandlerBody;
  status?: 400 | 502;
}
export interface GithubWebhookDependencies {
  enqueueFactory?: typeof enqueueFactoryMessage;
}

const ownerAndName = (repository: WebhookRepository) => {
  const [owner = '', name = repository.name] = repository.full_name.split('/');
  return {
    externalId: String(repository.id),
    owner,
    name,
    defaultBranch: repository.default_branch,
  };
};

const installationConfig = (event: InstallationEvent): JsonObject => ({
  accountId: event.installation.account.id,
  accountLogin: event.installation.account.login,
  accountType: event.installation.account.type,
  installerGithubId: event.sender?.id ?? null,
  suspended: event.action === 'suspend',
});

async function handleInstallation(event: InstallationEvent): Promise<WebhookHandlerResult> {
  const externalId = String(event.installation.id);
  if (event.action === 'deleted') {
    const integration = await getIntegrationByExternalAccount('github', externalId);
    if (integration) {
      await updateIntegration(integration.id, {
        name: integration.name,
        config: installationConfig(event),
        enabled: false,
      });
      await disableRepositoriesForIntegration(integration.id);
    }
    return { body: { ok: true, removed: externalId } };
  }

  let integration = await getIntegrationByExternalAccount('github', externalId);
  if (!integration) {
    const ownerUserId = event.sender ? await findAuthUserByGithubId(event.sender.id) : null;
    const organization = await ensureGithubOrganization({
      accountId: event.installation.account.id,
      accountLogin: event.installation.account.login,
      ownerUserId,
    });
    integration = await upsertExternalIntegration({
      organizationId: organization.id,
      kind: 'scm',
      provider: 'github',
      name: `github-${event.installation.account.login.toLowerCase()}`,
      externalAccountId: externalId,
      config: installationConfig(event),
      enabled: event.action !== 'suspend',
    });
  } else {
    await updateIntegration(integration.id, {
      name: integration.name,
      config: installationConfig(event),
      enabled: event.action !== 'suspend',
    });
    integration = (await getIntegration(integration.id)) ?? integration;
  }
  await upsertRepositories(
    integration,
    (event.repositories ?? event.repositories_added ?? []).map(ownerAndName),
  );
  for (const repository of event.repositories_removed ?? []) {
    const row = await getRepositoryByExternalId(integration.id, String(repository.id));
    if (row) await removeRepositories([row.id]);
  }
  return { body: { ok: true, integration: integration.id } };
}

async function handleRepository(event: RepositoryEvent): Promise<WebhookHandlerResult> {
  if (!event.installation || !['renamed', 'transferred', 'edited'].includes(event.action)) {
    return { body: { ok: true, ignored: event.action } };
  }
  const integration = await getIntegrationByExternalAccount(
    'github',
    String(event.installation.id),
  );
  if (!integration) return { body: { ok: true, skipped: 'integration not tracked' } };
  await upsertRepositories(integration, [ownerAndName(event.repository)]);
  return { body: { ok: true, repository: event.repository.full_name } };
}

async function handlePullRequest(
  event: PullRequestEvent,
  enqueue: typeof enqueueFactoryMessage,
): Promise<WebhookHandlerResult> {
  const repository = await getRepositoryByProviderExternalId('github', String(event.repository.id));
  if (!repository) return { body: { ok: true, skipped: 'repository not tracked' } };
  const integration = await getIntegration(repository.source_integration_id);
  if (!integration || !integration.enabled)
    return { body: { ok: true, skipped: 'integration disabled' } };
  const status =
    event.action === 'closed' ? (event.pull_request.merged ? 'merged' : 'closed') : 'open';
  const change = await upsertChange({
    organizationId: repository.organization_id,
    repositoryId: repository.id,
    providerIntegrationId: integration.id,
    providerKey: `pull_request:${event.number}`,
    number: event.number,
    title: event.pull_request.title ?? `Pull request #${event.number}`,
    sourceRef: event.pull_request.head?.ref ?? `refs/pull/${event.number}/head`,
    targetRef: event.pull_request.base?.ref ?? repository.default_branch ?? 'main',
    url: event.pull_request.html_url,
    origin: event.pull_request.head?.ref.startsWith('turbodiff/')
      ? 'factory'
      : event.pull_request.user?.type === 'Bot'
        ? 'automation'
        : 'human',
    status,
  });
  if (status !== 'open' || event.pull_request.draft)
    return { body: { ok: true, change: change.id } };
  const settings = isJsonObject(repository.settings) ? repository.settings : {};
  if (event.action === 'synchronize' && settings.reviewOnPush !== true)
    return { body: { ok: true, skipped: 'push reviews disabled' } };
  if (!['opened', 'ready_for_review', 'synchronize'].includes(event.action))
    return { body: { ok: true, ignored: event.action } };
  const revision = event.pull_request.head?.sha ?? 'unknown';
  if (revision !== 'unknown') await syncGithubChangeRevision(repository, change, revision);
  const key = `github-review:${change.id}:${revision}`;
  const created = await createFactoryRunWithStage(
    {
      organizationId: change.organization_id,
      flowKey: REVIEW_FLOW.key,
      flowVersion: REVIEW_FLOW.version,
      changeId: change.id,
      trigger: event.action,
      idempotencyKey: key,
    },
    {
      stageKey: REVIEW_FLOW.initialStage,
      idempotencyKey: `${key}:${REVIEW_FLOW.initialStage}`,
    },
  );
  await enqueue({
    kind: 'run_factory',
    factoryRunId: created.factoryRun.id,
    stageRunId: created.stageRun.id,
  });
  return { body: { ok: true, change: change.id, factoryRun: created.factoryRun.id } };
}

export function createGithubWebhookService(dependencies: GithubWebhookDependencies = {}) {
  const enqueue = dependencies.enqueueFactory ?? enqueueFactoryMessage;
  return {
    async handle(name: string, payload: JsonValue): Promise<WebhookHandlerResult> {
      if (!isJsonObject(payload))
        return { body: { ok: false, error: 'invalid payload' }, status: 400 };
      if (name === 'installation' || name === 'installation_repositories') {
        const parsed = installationEvent.safeParse(payload);
        return parsed.success
          ? handleInstallation(parsed.data)
          : { body: { ok: false, error: 'invalid installation payload' }, status: 400 };
      }
      if (name === 'repository') {
        const parsed = repositoryEvent.safeParse(payload);
        return parsed.success
          ? handleRepository(parsed.data)
          : { body: { ok: false, error: 'invalid repository payload' }, status: 400 };
      }
      if (name === 'pull_request') {
        const parsed = pullRequestEvent.safeParse(payload);
        return parsed.success
          ? handlePullRequest(parsed.data, enqueue)
          : { body: { ok: false, error: 'invalid pull request payload' }, status: 400 };
      }
      return { body: { ok: true, ignored: name } };
    },
  };
}

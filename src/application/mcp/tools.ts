import {
  createFactoryRunWithStage,
  createWorkItem as createWorkItemRow,
  getRepository,
  getWorkItem as getWorkItemRow,
  listFactoryRuns,
  listRepositories as listRepositoryRows,
  listWorkItems as listWorkItemRows,
  listWorkItemTargets,
  memberRole,
  updateWorkItem,
  type RepositoryRow,
  type WorkItemRow,
} from '../../data/db.ts';
import { installationToken } from '../../integrations/github/app.ts';
import {
  isValidRepoPath,
  isValidRepoRef,
  listBranchesAndDefault,
  readFile,
  readTree,
  RepoBrowserError,
} from '../../integrations/source-code/github.ts';
import {
  listBranchesAndDefaultArtifacts,
  readFileArtifacts,
  readTreeArtifacts,
} from '../../integrations/source-code/artifacts.ts';
import type { AuthedUser } from '../auth/session.ts';
import { DISPATCH_FLOW, PLANNING_FLOW } from '../factory/flows.ts';
import type { enqueueFactoryMessage } from '../factory/queue.ts';

export class McpToolError extends Error {}

function requireOrganization(user: AuthedUser, organizationId: string): void {
  if (!user.organizationIds.includes(organizationId)) {
    throw new McpToolError('unknown organization');
  }
}

async function requireOrganizationWrite(user: AuthedUser, organizationId: string): Promise<void> {
  requireOrganization(user, organizationId);
  const role = await memberRole(organizationId, user.session.authUserId);
  if (role !== 'owner' && role !== 'admin') {
    throw new McpToolError('organization admin role required');
  }
}

async function authorizedRepository(user: AuthedUser, id: number): Promise<RepositoryRow> {
  const repository = Number.isInteger(id) ? await getRepository(id) : null;
  if (!repository || !user.organizationIds.includes(repository.organization_id)) {
    throw new McpToolError('unknown repository');
  }
  return repository;
}

function serializeWorkItem(row: WorkItemRow) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    origin: row.origin,
    title: row.title,
    description: row.description,
    status: row.status,
    approved_plan_artifact_id: row.approved_plan_artifact_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

export async function listWorkItems(user: AuthedUser) {
  const rows = await listWorkItemRows(user.organizationIds);
  const targets = await listWorkItemTargets(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...serializeWorkItem(row),
    targets: targets
      .filter((target) => target.work_item_id === row.id)
      .map((target) => ({
        repository_id: target.repository_id,
        owner: target.owner,
        name: target.name,
      })),
  }));
}

export async function getWorkItem(user: AuthedUser, id: number) {
  const row = Number.isInteger(id) ? await getWorkItemRow(id) : null;
  if (!row || !user.organizationIds.includes(row.organization_id)) {
    throw new McpToolError('unknown work item');
  }
  const [targets, runs] = await Promise.all([
    listWorkItemTargets([row.id]),
    listFactoryRuns({ workItemId: row.id }),
  ]);
  return {
    ...serializeWorkItem(row),
    targets: targets.map((target) => ({
      repository_id: target.repository_id,
      owner: target.owner,
      name: target.name,
    })),
    factory_runs: runs.map((run) => ({
      id: run.id,
      flow_key: run.flow_key,
      status: run.status,
      created_at: run.created_at,
    })),
  };
}

export async function listRepositories(user: AuthedUser) {
  const rows = await listRepositoryRows(user.organizationIds);
  return rows.map((row) => ({
    id: row.id,
    organization_id: row.organization_id,
    owner: row.owner,
    name: row.name,
    provider: row.source_provider,
    default_branch: row.default_branch,
    enabled: row.enabled,
  }));
}

async function githubToken(repository: RepositoryRow): Promise<string> {
  const installationId = Number(repository.source_external_account_id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new McpToolError('repository has no usable GitHub integration');
  }
  return installationToken(installationId);
}

async function resolveRef(repository: RepositoryRow, ref?: string): Promise<string> {
  if (ref) {
    if (!isValidRepoRef(ref)) throw new McpToolError('a valid ref is required');
    return ref;
  }
  if (repository.source_provider === 'github') {
    return (await listBranchesAndDefault(await githubToken(repository), repository)).default_branch;
  }
  if (repository.source_provider === 'artifacts') {
    const branches = await listBranchesAndDefaultArtifacts(repository);
    if (branches.default_branch) return branches.default_branch;
  }
  throw new McpToolError('repository has no default branch');
}

export async function repositoryTree(
  user: AuthedUser,
  repositoryId: number,
  path = '',
  ref?: string,
) {
  const repository = await authorizedRepository(user, repositoryId);
  if (!isValidRepoPath(path)) throw new McpToolError('invalid path');
  try {
    const resolvedRef = await resolveRef(repository, ref);
    if (repository.source_provider === 'github') {
      return readTree(await githubToken(repository), repository, resolvedRef, path);
    }
    if (repository.source_provider === 'artifacts') {
      return readTreeArtifacts(repository, resolvedRef, path);
    }
    throw new McpToolError('repository provider does not support code browsing');
  } catch (error) {
    if (error instanceof RepoBrowserError) throw new McpToolError(error.message);
    throw error;
  }
}

export async function readRepositoryFile(
  user: AuthedUser,
  repositoryId: number,
  path: string,
  ref?: string,
) {
  const repository = await authorizedRepository(user, repositoryId);
  if (!path || !isValidRepoPath(path)) throw new McpToolError('invalid path');
  try {
    const resolvedRef = await resolveRef(repository, ref);
    if (repository.source_provider === 'github') {
      return readFile(await githubToken(repository), repository, resolvedRef, path);
    }
    if (repository.source_provider === 'artifacts') {
      return readFileArtifacts(repository, resolvedRef, path);
    }
    throw new McpToolError('repository provider does not support code browsing');
  } catch (error) {
    if (error instanceof RepoBrowserError) throw new McpToolError(error.message);
    throw error;
  }
}

export async function createWorkItem(
  user: AuthedUser,
  input: {
    organization_id: string;
    repository_ids: number[];
    title: string;
    description: string;
  },
) {
  await requireOrganizationWrite(user, input.organization_id);
  const title = input.title.trim();
  const description = input.description.trim();
  const repositoryIds = [...new Set(input.repository_ids)];
  if (!title || !description) throw new McpToolError('title and description are required');
  if (repositoryIds.length === 0 || repositoryIds.length > 3) {
    throw new McpToolError('choose between one and three repositories');
  }
  const repositories = await Promise.all(repositoryIds.map(getRepository));
  if (
    !repositories.every(
      (repository) => repository?.organization_id === input.organization_id && repository.enabled,
    )
  ) {
    throw new McpToolError('unknown, disabled, or cross-organization repository');
  }
  const row = await createWorkItemRow({
    organizationId: input.organization_id,
    origin: 'api',
    title: title.slice(0, 200),
    description,
    createdByUserId: user.session.authUserId,
    repositoryIds,
  });
  return { work_item_id: row.id };
}

export async function startFactoryRun(
  user: AuthedUser,
  input: { work_item_id: number; flow: 'planning' | 'delivery' },
  enqueue: typeof enqueueFactoryMessage,
) {
  const workItem = await getWorkItemRow(input.work_item_id);
  if (!workItem || !user.organizationIds.includes(workItem.organization_id)) {
    throw new McpToolError('unknown work item');
  }
  await requireOrganizationWrite(user, workItem.organization_id);
  if (workItem.status === 'completed' || workItem.status === 'cancelled') {
    throw new McpToolError(`work item is ${workItem.status}`);
  }
  if (input.flow === 'delivery' && !workItem.approved_plan_artifact_id) {
    throw new McpToolError('approve a plan artifact before delivery');
  }
  const flow = input.flow === 'planning' ? PLANNING_FLOW : DISPATCH_FLOW;
  const key = `${flow.key}:${workItem.id}:${crypto.randomUUID()}`;
  const started = await createFactoryRunWithStage(
    {
      organizationId: workItem.organization_id,
      flowKey: flow.key,
      flowVersion: flow.version,
      workItemId: workItem.id,
      trigger: 'mcp',
      actorUserId: user.session.authUserId,
      idempotencyKey: key,
    },
    { stageKey: flow.initialStage, idempotencyKey: `${key}:${flow.initialStage}:1` },
  );
  await updateWorkItem(workItem.id, {
    status: input.flow === 'planning' ? 'planning' : 'in_progress',
  });
  await enqueue({
    kind: 'run_factory',
    factoryRunId: started.factoryRun.id,
    stageRunId: started.stageRun.id,
  });
  return { factory_run_id: started.factoryRun.id, stage_run_id: started.stageRun.id };
}

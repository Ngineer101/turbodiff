import {
  createTodo as createTodoRow,
  createPlanForTodo,
  createUserChatMessage,
  getFeature as getFeatureRow,
  getPlanWithRepoById,
  getRepoById,
  getTaskRepoStatuses,
  getTodo,
  hasPendingChatTurn,
  latestVerificationForFeature,
  listChatMessages,
  listInstallationsWithRepos,
  listPlansForInstallations,
  listReposForTodo,
  listTodos,
  setTodoRepositories,
  todoRepositoriesForTodos,
  type RepositoryRow,
} from '../data/db.ts';
import { installationToken } from '../integrations/github/app.ts';
import { capabilityDenied } from './access-control.ts';
import { userCanPushToRepo, userIsGithubOrgAdmin, type AuthedUser } from './auth.ts';
import type { enqueueFactoryMessage } from './factory-queue.ts';
import {
  isValidRepoPath,
  isValidRepoRef,
  listBranchesAndDefault,
  readFile,
  readTree,
  RepoBrowserError,
} from './repo-browser.ts';

// Use cases behind the /mcp tool surface (integrations/mcp/server.ts). Every
// function takes the bearer-resolved AuthedUser and applies the same
// installation-membership and write gates as the corresponding api.ts route —
// the checks are reproduced here (never imported from src/http/, which sits
// above this layer) against the same service/data functions, so scoping
// cannot drift. Denials and validation failures throw McpToolError with the
// api.ts wording; like the API's 404s, membership failures say "unknown X"
// rather than revealing that the resource exists.

// A tool failure with a user-safe message — the integration layer maps it to
// an MCP `isError` tool result. Anything else that escapes is logged and
// reported generically.
export class McpToolError extends Error {}

const MAX_TASK_REPOS = 3;
const CODE_NOT_SUPPORTED = 'code browsing is not yet supported for turbodiff-hosted repositories';

function requireInstallation(user: AuthedUser, installationId: number): void {
  if (!user.installationIds.includes(installationId)) {
    throw new McpToolError('unknown installation');
  }
}

async function authorizedRepo(user: AuthedUser, repositoryId: number): Promise<RepositoryRow> {
  const repo = Number.isInteger(repositoryId) ? await getRepoById(repositoryId) : null;
  if (!repo || !user.installationIds.includes(repo.installation_id)) {
    throw new McpToolError('unknown repository');
  }
  return repo;
}

// Same computation as verificationSummary in http/api-support.ts, re-derived
// here to keep the service layer below http.
function verificationSummary(
  status: string | null | undefined,
  results: { verdict: string }[] | null | undefined,
): { status: string; total: number; failed: number } | null {
  if (!status) return null;
  const rows = results ?? [];
  return {
    status,
    total: rows.length,
    failed: rows.filter((r) => r.verdict === 'fail').length,
  };
}

export async function listBoard(user: AuthedUser) {
  const [groups, plans, todos] = await Promise.all([
    listInstallationsWithRepos(user.installationIds),
    listPlansForInstallations(user.installationIds),
    listTodos(user.installationIds),
  ]);
  const active = plans.filter((p) => !p.archived);
  const [repoStatuses, todoRepos] = await Promise.all([
    getTaskRepoStatuses(active.map((p) => p.id)),
    todoRepositoriesForTodos(todos.map((t) => t.id)),
  ]);
  return {
    todos: todos.map((t) => ({
      id: t.id,
      installation_id: t.installation_id,
      title: t.title,
      notes: t.notes,
      created_at: t.created_at,
      repos: todoRepos
        .filter((r) => r.todo_id === t.id)
        .map((r) => ({ id: r.repository_id, owner: r.owner, name: r.name })),
    })),
    tasks: active.map((p) => ({
      id: p.id,
      installation_id: p.installation_id,
      title: p.title,
      status: p.status,
      error: p.error,
      created_at: p.created_at,
      repos: repoStatuses
        .filter((r) => r.plan_id === p.id)
        .map((r) => ({
          repository_id: r.repository_id,
          owner: r.owner,
          name: r.name,
          feature_id: r.feature_id,
          feature_status: r.feature_status,
          pr_number: r.pr_number,
        })),
    })),
    repos: groups
      .flatMap((g) => g.repos)
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.id,
        owner: r.owner,
        name: r.name,
        installation_id: r.installation_id,
      })),
  };
}

export async function getTask(user: AuthedUser, taskId: number) {
  const plan = Number.isInteger(taskId) ? await getPlanWithRepoById(taskId) : null;
  if (!plan || !user.installationIds.includes(plan.installation_id)) {
    throw new McpToolError('unknown task');
  }
  const repoStatuses = await getTaskRepoStatuses([plan.id]);
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    error: plan.error,
    created_at: plan.created_at,
    requirements: plan.requirements,
    plan: plan.plan,
    questions: plan.questions ?? [],
    answers: plan.answers ?? [],
    acceptance: plan.acceptance ?? [],
    repos: repoStatuses.map((r) => ({
      repository_id: r.repository_id,
      owner: r.owner,
      name: r.name,
      feature_id: r.feature_id,
      feature_status: r.feature_status,
      feature_error: r.feature_error,
      pr_number: r.pr_number,
      verification: verificationSummary(r.verification_status, r.verification_results),
    })),
  };
}

export async function getFeature(user: AuthedUser, featureId: number) {
  const feature = Number.isInteger(featureId) ? await getFeatureRow(featureId) : null;
  const repo = feature ? await getRepoById(feature.repository_id) : null;
  if (!feature || !repo || !user.installationIds.includes(repo.installation_id)) {
    throw new McpToolError('unknown feature');
  }
  const [verification, messages] = await Promise.all([
    latestVerificationForFeature(feature.id),
    listChatMessages(feature.id),
  ]);
  return {
    id: feature.id,
    title: feature.title,
    status: feature.status,
    error: feature.error,
    pr_number: feature.pr_number,
    repo: `${repo.owner}/${repo.name}`,
    verification: verificationSummary(verification?.status, verification?.results),
    chat: messages.map((m) => ({
      role: m.role,
      body: m.body,
      status: m.status,
      outcome: m.outcome,
      created_at: m.created_at,
    })),
  };
}

async function resolveRef(token: string, repo: RepositoryRow, ref: string | undefined) {
  if (ref !== undefined && ref !== '') {
    if (!isValidRepoRef(ref)) throw new McpToolError('a valid ref is required');
    return ref;
  }
  const { default_branch } = await listBranchesAndDefault(token, repo);
  return default_branch;
}

export async function repoTree(
  user: AuthedUser,
  repositoryId: number,
  path?: string,
  ref?: string,
) {
  const repo = await authorizedRepo(user, repositoryId);
  if (repo.provider !== 'github') throw new McpToolError(CODE_NOT_SUPPORTED);
  const treePath = path ?? '';
  if (!isValidRepoPath(treePath)) throw new McpToolError('invalid path');
  try {
    const token = await installationToken(repo.installation_id);
    return await readTree(token, repo, await resolveRef(token, repo, ref), treePath);
  } catch (err) {
    if (err instanceof RepoBrowserError) throw new McpToolError(err.message);
    throw err;
  }
}

export async function readRepoFile(
  user: AuthedUser,
  repositoryId: number,
  path: string,
  ref?: string,
) {
  const repo = await authorizedRepo(user, repositoryId);
  if (repo.provider !== 'github') throw new McpToolError(CODE_NOT_SUPPORTED);
  if (!path || !isValidRepoPath(path)) throw new McpToolError('invalid path');
  try {
    const token = await installationToken(repo.installation_id);
    return await readFile(token, repo, await resolveRef(token, repo, ref), path);
  } catch (err) {
    if (err instanceof RepoBrowserError) throw new McpToolError(err.message);
    throw err;
  }
}

// Every id must belong to the installation and be enabled — the same
// server-side rule as api.ts's validRepoIds.
async function validRepoIds(installationId: number, repoIds: number[]): Promise<boolean> {
  if (repoIds.length === 0 || repoIds.length > MAX_TASK_REPOS) return false;
  const repos = await Promise.all(repoIds.map((id) => getRepoById(id)));
  return repos.every((r) => r && r.installation_id === installationId && r.enabled);
}

export async function createTodo(
  user: AuthedUser,
  input: { installation_id?: number; title: string; notes?: string; repository_ids?: number[] },
): Promise<{ todo_id: number }> {
  const title = input.title.trim();
  if (!title) throw new McpToolError('title is required');
  const installationId = input.installation_id ?? user.installationIds[0];
  if (installationId === undefined) throw new McpToolError('unknown installation');
  requireInstallation(user, installationId);
  const repoIds = input.repository_ids ?? [];
  if (repoIds.length > MAX_TASK_REPOS) throw new McpToolError('at most 3 repositories');
  if (repoIds.length > 0 && !(await validRepoIds(installationId, repoIds))) {
    throw new McpToolError('unknown or disabled repository');
  }
  const id = await createTodoRow(installationId, title.slice(0, 200), input.notes?.trim() || null, {
    login: user.session.login,
    id: user.session.userId,
  });
  if (repoIds.length > 0) await setTodoRepositories(id, repoIds);
  return { todo_id: id };
}

export async function startTask(
  user: AuthedUser,
  input: { todo_id: number; requirements: string; title?: string },
  enqueue: typeof enqueueFactoryMessage,
): Promise<{ task_id: number }> {
  const todo = Number.isInteger(input.todo_id) ? await getTodo(input.todo_id) : null;
  if (!todo || !user.installationIds.includes(todo.installation_id)) {
    throw new McpToolError('unknown todo');
  }
  if (todo.plan_id !== null) throw new McpToolError('already started');
  const repos = await listReposForTodo(todo.id);
  if (repos.length === 0) throw new McpToolError('select at least one repository first');
  const requirements = input.requirements.trim();
  if (!requirements) throw new McpToolError('requirements are required');
  const started = await createPlanForTodo(
    todo.id,
    repos.map((r) => r.id),
    input.title?.trim() || todo.title,
    requirements,
    { login: user.session.login, id: user.session.userId },
  );
  if (!started) throw new McpToolError('todo could not be started');
  if (!started.created) throw new McpToolError('already started');
  await enqueue({ kind: 'plan_analyze', planId: started.planId });
  return { task_id: started.planId };
}

export async function sendChatMessage(
  user: AuthedUser,
  input: { feature_id: number; message: string },
  enqueue: typeof enqueueFactoryMessage,
): Promise<{ message_id: number }> {
  const feature = Number.isInteger(input.feature_id) ? await getFeatureRow(input.feature_id) : null;
  const repo = feature ? await getRepoById(feature.repository_id) : null;
  if (!feature || !repo || !user.installationIds.includes(repo.installation_id)) {
    throw new McpToolError('unknown feature');
  }
  const body = input.message.trim();
  if (!body) throw new McpToolError('message is required');
  if (!feature.pr_number || feature.status !== 'pr_opened') {
    throw new McpToolError('no open pull request for this feature');
  }
  // Chat turns push commits to the source branch — the same write gate as
  // POST /factory/features/:id/chat: org 'settings' capability for
  // Artifacts-hosted repos, the caller's own GitHub push permission
  // otherwise.
  if (repo.provider === 'artifacts') {
    const denied = await capabilityDenied(
      user,
      repo.installation_id,
      'settings',
      userIsGithubOrgAdmin,
    );
    if (denied) throw new McpToolError(denied);
  } else if (!(await userCanPushToRepo(user, repo.owner, repo.name))) {
    throw new McpToolError('push access to the repository is required for this action');
  }
  // One turn in flight at a time — matches the API route's 409.
  if (await hasPendingChatTurn(feature.id)) {
    throw new McpToolError('a chat turn is already running — wait for the reply');
  }
  const messageId = await createUserChatMessage(
    feature.id,
    body,
    user.session.login,
    user.session.userId,
  );
  await enqueue({ kind: 'chat', featureId: feature.id, chatMessageId: messageId });
  return { message_id: messageId };
}

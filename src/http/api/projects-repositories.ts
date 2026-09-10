import type { Hono } from 'hono';
import { getRepoByFullName, getRepoById, repositoryRef } from '../../data/db.ts';
import {
  createArtifactsProject,
  mintArtifactsCloneToken,
  PROJECT_SEGMENT,
} from '../../services/artifacts.ts';
import { installationToken, sandboxGitToken } from '../../integrations/github/app.ts';
import {
  isValidRepoPath,
  isValidRepoRef,
  listBranchesAndDefault,
  readFile,
  readTree,
  RepoBrowserError,
  saveFile,
} from '../../services/repo-browser.ts';
import {
  listBranchesAndDefaultArtifacts,
  readFileArtifacts,
  readTreeArtifacts,
  saveFileArtifacts,
} from '../../services/repo-browser-artifacts.ts';
import {
  ADOPTABLE_PROCESS_PROFILE_KEYS,
  type AdoptableProcessProfileKey,
} from '../../domain/process-profiles.ts';
import { isString } from '../../shared/json.ts';
import {
  type ApiCreatedProject,
  type ApiFileSave,
  type ApiRepoCode,
} from '../../shared/api-types.ts';
import { authorizedRepo, requireCapability, requireRepoPush, type ApiEnv } from '../api-support.ts';
import { deferredExecution, immutableRepoJson } from './execution.ts';
import type { ResolvedApiRouteDependencies } from './types.ts';

export function registerProjectRepositoryRoutes(
  app: Hono<ApiEnv>,
  dependencies: Pick<ResolvedApiRouteDependencies, 'canPushToRepo' | 'orgAdmin'>,
) {
  const { canPushToRepo, orgAdmin } = dependencies;
  // --- Artifacts-hosted projects (docs/artifacts-provider.md) ---

  // Create a turbodiff-hosted project: Artifacts repo + synthetic tenancy +
  // an organization the creator owns. Access is keyed to the GitHub identity
  // (member rows join on githubId), so a GitHub-connected session is
  // required even though the project itself never touches GitHub.
  app.post('/projects', async (c) => {
    const user = c.get('user');
    if (!user.githubConnected || user.session.userId === 0) {
      return c.json(
        { error: 'connect a GitHub account first — turbodiff access is keyed to it' },
        409,
      );
    }
    const body = await c.req
      .json<{
        owner?: string;
        name?: string;
        description?: string;
        process_profile?: AdoptableProcessProfileKey;
      }>()
      .catch(() => null);
    const owner = body?.owner?.trim().toLowerCase() ?? '';
    const name = body?.name?.trim() ?? '';
    if (!PROJECT_SEGMENT.test(owner) || !PROJECT_SEGMENT.test(name)) {
      return c.json(
        { error: 'owner and name must be 1-80 letters, digits, dots, dashes, or underscores' },
        400,
      );
    }
    if (
      body?.process_profile !== undefined &&
      !ADOPTABLE_PROCESS_PROFILE_KEYS.includes(body.process_profile)
    ) {
      return c.json(
        { error: `process_profile must be ${ADOPTABLE_PROCESS_PROFILE_KEYS.join(', ')}` },
        400,
      );
    }
    if (await getRepoByFullName(owner, name)) {
      return c.json({ error: `${owner}/${name} already exists` }, 409);
    }
    try {
      const project = await createArtifactsProject({
        owner,
        name,
        description: isString(body?.description) ? body.description : undefined,
        creatorGithubId: user.session.userId,
        processProfile: body?.process_profile,
      });
      const response: ApiCreatedProject = {
        ok: true,
        repository_id: project.repo.id,
        repo: `${project.repo.owner}/${project.repo.name}`,
        default_branch: project.repo.default_branch,
        remote: project.remote,
      };
      return c.json(response);
    } catch (err) {
      console.error('turbodiff: project creation failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'project creation failed' }, 502);
    }
  });

  // Clone credential for an Artifacts-hosted repo — lets the user work with
  // plain git. Read tokens for any member; write tokens need 'settings'.
  app.post('/repos/:id/clone-token', async (c) => {
    const repoId = Number(c.req.param('id'));
    const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
    if (!repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown repository' }, 404);
    }
    const body = await c.req.json<{ scope?: string }>().catch(() => null);
    const scope = body?.scope === 'write' ? 'write' : 'read';
    if (scope === 'write') {
      const deniedCapability = await requireCapability(
        c,
        repo.installation_id,
        'settings',
        orgAdmin,
      );
      if (deniedCapability) return deniedCapability;
    }
    try {
      return c.json(await mintArtifactsCloneToken(repo, scope, 24 * 3600));
    } catch (err) {
      console.error('turbodiff: clone-token mint failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'token mint failed' }, 502);
    }
  });

  // --- Repo code browser ---

  // Branches + default branch for the code page header. GitHub answers off
  // the REST API; Artifacts off real git in the per-repo sandbox mirror.
  app.get('/repos/:id/code', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const repoSummary = {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      provider: repo.provider,
    };
    try {
      const { default_branch, branches } =
        repo.provider === 'github'
          ? await listBranchesAndDefault(await installationToken(repo.installation_id), repo)
          : await listBranchesAndDefaultArtifacts(repo);
      return c.json<ApiRepoCode>({
        repo: repoSummary,
        supported: true,
        default_branch,
        branches,
      });
    } catch (err) {
      console.error('turbodiff: code branch listing failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'branch listing failed' }, 502);
    }
  });

  // One directory level of the repo tree at ?ref=&path= (lazy — the client
  // fetches per expanded directory).
  app.get('/repos/:id/tree', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const ref = c.req.query('ref') ?? '';
    const path = c.req.query('path') ?? '';
    if (!isValidRepoRef(ref)) return c.json({ error: 'a valid ref query param is required' }, 400);
    if (!isValidRepoPath(path)) return c.json({ error: 'invalid path' }, 400);
    try {
      if (repo.provider === 'github') {
        const token = await installationToken(repo.installation_id);
        return c.json(await readTree(token, repo, ref, path));
      }
      const recorded = await repositoryRef(repo.id, ref);
      const data = await immutableRepoJson(
        deferredExecution(c),
        recorded
          ? `artifacts/tree/${repo.id}/${recorded.head_sha}/${encodeURIComponent(path)}`
          : null,
        () => readTreeArtifacts(repo, ref, path),
      );
      return c.json(data);
    } catch (err) {
      if (err instanceof RepoBrowserError) return c.json({ error: err.message }, err.status);
      console.error('turbodiff: tree read failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'tree read failed' }, 502);
    }
  });

  app.get('/repos/:id/file', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const ref = c.req.query('ref') ?? '';
    const path = c.req.query('path') ?? '';
    if (!isValidRepoRef(ref)) return c.json({ error: 'a valid ref query param is required' }, 400);
    if (!path || !isValidRepoPath(path)) return c.json({ error: 'invalid path' }, 400);
    try {
      if (repo.provider === 'github') {
        const token = await installationToken(repo.installation_id);
        return c.json(await readFile(token, repo, ref, path));
      }
      const recorded = await repositoryRef(repo.id, ref);
      const data = await immutableRepoJson(
        deferredExecution(c),
        recorded
          ? // v2: the payload gained content_base64 — a fresh key so cached
            // field-less JSON from before the change is never served.
            `artifacts/file/v2/${repo.id}/${recorded.head_sha}/${encodeURIComponent(path)}`
          : null,
        () => readFileArtifacts(repo, ref, path),
      );
      return c.json(data);
    } catch (err) {
      if (err instanceof RepoBrowserError) return c.json({ error: err.message }, err.status);
      console.error('turbodiff: file read failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'file read failed' }, 502);
    }
  });

  // Save one edited file: commit directly to the branch, or branch + PR.
  // base_sha is the optimistic-concurrency token — a stale one maps to 409.
  app.put('/repos/:id/file', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const body = await c.req
      .json<{
        path?: unknown;
        ref?: unknown;
        base_sha?: unknown;
        content?: unknown;
        message?: unknown;
        mode?: unknown;
      }>()
      .catch(() => null);
    const path = isString(body?.path) ? body.path : '';
    const ref = isString(body?.ref) ? body.ref : '';
    const content = body?.content;
    const mode = body?.mode;
    if (!path || !isValidRepoPath(path)) return c.json({ error: 'invalid path' }, 400);
    if (!isValidRepoRef(ref)) return c.json({ error: 'a valid ref is required' }, 400);
    if (!isString(content) || new TextEncoder().encode(content).length > 1024 * 1024) {
      return c.json({ error: 'content must be a string of at most 1 MB' }, 400);
    }
    if (mode !== 'commit' && mode !== 'pr') {
      return c.json({ error: 'mode must be "commit" or "pr"' }, 400);
    }
    if (repo.provider !== 'github' && mode === 'pr') {
      return c.json(
        {
          error:
            'pull-request saves are not available for turbodiff-hosted repositories — commit directly to the branch',
        },
        400,
      );
    }
    const message =
      isString(body?.message) && body.message.trim() ? body.message.trim() : `Update ${path}`;
    // The save pushes a commit to the branch — Artifacts repos gate on the
    // org 'settings' capability (same bar as Merge); GitHub repos on the
    // caller's own push permission, before any write token exists —
    // installation membership alone also covers read-only members.
    if (repo.provider === 'artifacts') {
      const deniedCapability = await requireCapability(
        c,
        repo.installation_id,
        'settings',
        orgAdmin,
      );
      if (deniedCapability) return deniedCapability;
    } else {
      const deniedPush = await requireRepoPush(c, repo, canPushToRepo);
      if (deniedPush) return deniedPush;
    }
    try {
      const login = c.get('user').session.login || 'turbodiff';
      const author = { name: login, email: `${login}@users.noreply.github.com` };
      const base_sha = isString(body?.base_sha) ? body.base_sha : null;
      if (repo.provider === 'github') {
        const writeToken = await sandboxGitToken(repo.installation_id, repo.name, 'write');
        const result = await saveFile(writeToken, repo, {
          path,
          ref,
          base_sha,
          content,
          message,
          mode,
          author,
        });
        return c.json<ApiFileSave>(result);
      }
      const result = await saveFileArtifacts(repo, {
        path,
        ref,
        base_sha,
        content,
        message,
        author,
      });
      return c.json<ApiFileSave>(result);
    } catch (err) {
      if (err instanceof RepoBrowserError) return c.json({ error: err.message }, err.status);
      const detail = err instanceof Error ? err.message : String(err);
      // GitHub answers 409 (or a "does not match" 422) when base_sha is stale.
      if (/GitHub API 409\b/.test(detail) || detail.includes('does not match')) {
        return c.json(
          {
            error: 'file changed on the branch since you opened it — reload and reapply your edit',
          },
          409,
        );
      }
      console.error('turbodiff: file save failed:', err);
      return c.json({ error: detail }, 502);
    }
  });
}

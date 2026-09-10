import type { Hono } from 'hono';
import {
  createSkill,
  deleteSkill,
  getSkillBySlug,
  listSkills,
  updateSkill,
} from '../../data/db.ts';
import { GitHubApiError, githubJson } from '../../integrations/github/client.ts';
import { installationToken } from '../../integrations/github/app.ts';
import {
  SkillsShApiError,
  type CatalogSort,
  type SkillsShClient,
} from '../../integrations/skills-sh/client.ts';
import {
  deriveSkillSlug,
  parseSkillMarkdown,
  parseSkillReference,
  sanitizeSkillFiles,
  type SkillFile,
  type SkillReference,
} from '../../domain/skill-import.ts';
import { isString, type JsonObject } from '../../shared/json.ts';
import {
  type ApiSkillAuditVerdict,
  type ApiSkillCatalog,
  type ApiSkillDetail,
  type ApiSkillImportPreview,
  type ApiSkillsList,
} from '../../shared/api-types.ts';
import {
  authorizedSkill,
  capableInstallationIds,
  preferCapableCopies,
  readSkillPayload,
  validateSkill,
  validateSlug,
  type ApiEnv,
} from '../api-support.ts';
import type { ResolvedApiRouteDependencies } from './types.ts';

// --- Skill import resolution (skills.sh catalog + GitHub-direct) ---

// User-caused import failures (bad folder, missing SKILL.md, no snapshot):
// the routes map these to 400 with the message as-is.
class SkillImportError extends Error {}

interface ResolvedSkillImport {
  name: string;
  suggested_slug: string;
  description: string | null;
  instructions: string;
  files: SkillFile[];
  source: 'skills.sh' | 'github';
  source_ref: string;
  hash: string | null;
  installs: number | null;
  audit: ApiSkillAuditVerdict[] | null;
}

// Size/count-limit violations are user-caused too — re-raise them as
// SkillImportError so the routes answer 400, not 500.
function sanitizedSkillFiles(files: { path: string; contents: string }[]): SkillFile[] {
  try {
    return sanitizeSkillFiles(files);
  } catch (err) {
    throw new SkillImportError(err instanceof Error ? err.message : 'skill files are invalid');
  }
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

// Recursively lists a GitHub folder (contents API, depth-limited) and
// downloads each file. The caller's installation token authenticates the
// reads, so public repos always work and private ones only when the App can
// already see them.
async function fetchGithubSkillFolder(
  token: string,
  reference: SkillReference & { kind: 'github' },
): Promise<{ path: string; contents: string }[]> {
  interface ContentsEntry {
    path: string;
    type: string;
  }
  const refQuery = reference.ref ? `?ref=${encodeURIComponent(reference.ref)}` : '';
  const basePath = reference.path;
  const files: { path: string; contents: string }[] = [];
  const listDir = async (path: string, depth: number): Promise<void> => {
    const listing = await githubJson<ContentsEntry[] | ContentsEntry>(
      token,
      `/repos/${reference.owner}/${reference.repo}/contents/${path}${refQuery}`,
    );
    if (!Array.isArray(listing)) {
      throw new SkillImportError('the GitHub URL must point to a folder containing a SKILL.md');
    }
    for (const entry of listing) {
      if (entry.type === 'dir') {
        if (depth >= 3) continue; // deep trees aren't skills — skip quietly
        await listDir(entry.path, depth + 1);
      } else if (entry.type === 'file') {
        if (files.length >= 30) {
          throw new SkillImportError('the GitHub folder has too many files to import as a skill');
        }
        const file = await githubJson<{ content?: string; encoding?: string }>(
          token,
          `/repos/${reference.owner}/${reference.repo}/contents/${entry.path}${refQuery}`,
        );
        if (!file.content || file.encoding !== 'base64') continue; // e.g. submodule/symlink
        files.push({
          path: entry.path.slice(basePath.length + 1),
          contents: decodeBase64Utf8(file.content),
        });
      }
    }
  };
  await listDir(basePath, 0);
  return files;
}

// Shared by the preview and import routes so both act on the exact same
// server-side resolution of the reference.
async function resolveSkillImport(
  reference: SkillReference,
  rawReference: string,
  installationId: number,
  skillsSh: SkillsShClient,
): Promise<ResolvedSkillImport> {
  if (reference.kind === 'catalog') {
    if (!skillsSh.configured()) {
      throw new SkillImportError(
        'skills.sh access is not configured — import this skill via its GitHub folder URL instead',
      );
    }
    const [detail, audit] = await Promise.all([
      skillsSh.detail(reference.source, reference.slug),
      // An audit failure must never block an import preview.
      skillsSh.audit(reference.source, reference.slug).catch(() => null),
    ]);
    if (!detail.files) {
      throw new SkillImportError(
        'skills.sh has no snapshot for this skill; import it via its GitHub URL instead',
      );
    }
    const skillMd = detail.files.find((f) => f.path === 'SKILL.md');
    if (!skillMd) {
      throw new SkillImportError(
        'the skills.sh snapshot has no SKILL.md; import it via its GitHub URL instead',
      );
    }
    const parsed = parseSkillMarkdown(skillMd.contents);
    return {
      name: parsed.name ?? detail.name,
      suggested_slug: deriveSkillSlug(reference.slug || parsed.name || detail.name),
      description: parsed.description ?? detail.description,
      instructions: parsed.body,
      files: sanitizedSkillFiles(detail.files),
      source: 'skills.sh',
      source_ref: `${reference.source}/${reference.slug}`,
      hash: detail.hash,
      installs: detail.installs,
      audit,
    };
  }

  let folder: { path: string; contents: string }[];
  try {
    folder = await fetchGithubSkillFolder(await installationToken(installationId), reference);
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      throw new SkillImportError(
        'the GitHub folder was not found (check the URL, branch, and path)',
      );
    }
    throw err;
  }
  const skillMd = folder.find((f) => f.path === 'SKILL.md');
  if (!skillMd) {
    throw new SkillImportError('the GitHub folder has no SKILL.md — point at a skill directory');
  }
  const parsed = parseSkillMarkdown(skillMd.contents);
  const fallbackName = reference.path.split('/').pop() ?? reference.repo;
  const name = parsed.name ?? fallbackName;
  return {
    name,
    suggested_slug: deriveSkillSlug(name),
    description: parsed.description,
    instructions: parsed.body,
    files: sanitizedSkillFiles(folder),
    source: 'github',
    source_ref: rawReference.trim(),
    hash: null,
    installs: null,
    audit: null,
  };
}

export function registerSkillRoutes(
  app: Hono<ApiEnv>,
  dependencies: Pick<ResolvedApiRouteDependencies, 'orgAdmin' | 'skillsSh'>,
) {
  const { orgAdmin, skillsSh } = dependencies;
  // --- Skills: list, create, edit, delete ---

  // Same generic-across-installations, fan-out-by-slug behavior as agents:
  // one flat skill list usable on any repo in any of the caller's installations.
  app.get('/skills', async (c) => {
    const { installationIds } = c.get('user');
    const skills = await listSkills(installationIds);
    // Same capable-copy preference as GET /agents.
    const capable = new Set(await capableInstallationIds(c, installationIds, orgAdmin));
    const seen = new Set<string>();
    return c.json<ApiSkillsList>({
      skills: preferCapableCopies(skills, capable)
        .filter((s) => (seen.has(s.slug) ? false : (seen.add(s.slug), true)))
        .map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          description: s.description,
          source: s.source,
        })),
    });
  });

  app.post('/skills', async (c) => {
    const { installationIds } = c.get('user');
    if (installationIds.length === 0) return c.json({ error: 'no installations' }, 404);
    const capableIds = await capableInstallationIds(c, installationIds, orgAdmin);
    if (capableIds.length === 0) {
      return c.json({ error: "'settings' capability required for this action" }, 403);
    }
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const values = readSkillPayload(body);
    let error = validateSkill(values, true);
    if (!error) {
      const existing = await Promise.all(
        installationIds.map((id) => getSkillBySlug(id, values.slug)),
      );
      if (existing.some(Boolean)) error = `a skill with slug "${values.slug}" already exists`;
    }
    if (error) return c.json({ error }, 400);
    await Promise.all(capableIds.map((id) => createSkill(id, values)));
    return c.json({ ok: true });
  });

  // --- skills.sh catalog proxy + import (registered before /skills/:id so
  // the :id param route can't capture /skills/catalog) ---

  app.get('/skills/catalog', async (c) => {
    if (!skillsSh.configured()) {
      return c.json<ApiSkillCatalog>({ configured: false, skills: [] });
    }
    const q = c.req.query('q')?.trim() ?? '';
    const sortParam = c.req.query('sort');
    const sort: CatalogSort =
      sortParam === 'all-time' || sortParam === 'hot' ? sortParam : 'trending';
    try {
      const skills = q ? await skillsSh.search(q, 30) : await skillsSh.leaderboard(sort);
      return c.json<ApiSkillCatalog>({ configured: true, skills });
    } catch (err) {
      // Degrade rather than 502: this query feeds the browse route's loader,
      // and a rejected loader would error-page the whole page — taking the
      // GitHub-direct import form (which doesn't need skills.sh) down with it.
      // Every failure mode counts, not only HTTP errors: a rejected fetch
      // (DNS, reset, TLS) or a non-JSON 2xx body from a CDN error page throws
      // TypeError/SyntaxError and must degrade the same way.
      console.error('turbodiff: skills.sh catalog request failed:', err);
      return c.json<ApiSkillCatalog>({
        configured: true,
        skills: [],
        error: 'skills.sh catalog request failed',
      });
    }
  });

  const importReference = (body: JsonObject | null): SkillReference | null => {
    if (!body || !isString(body.reference)) return null;
    return parseSkillReference(body.reference);
  };

  app.post('/skills/import/preview', async (c) => {
    const { installationIds } = c.get('user');
    if (installationIds.length === 0) return c.json({ error: 'no installations' }, 404);
    const body = await c.req.json<JsonObject>().catch(() => null);
    const reference = importReference(body);
    if (!reference) {
      return c.json(
        {
          error:
            'unrecognized reference — use owner/repo/skill, a skills.sh URL, or a GitHub folder URL',
        },
        400,
      );
    }
    try {
      const resolved = await resolveSkillImport(
        reference,
        isString(body?.reference) ? body.reference : '',
        installationIds[0],
        skillsSh,
      );
      const existing = await Promise.all(
        installationIds.map((id) => getSkillBySlug(id, resolved.suggested_slug)),
      );
      return c.json<ApiSkillImportPreview>({
        name: resolved.name,
        suggested_slug: resolved.suggested_slug,
        slug_taken: existing.some(Boolean),
        description: resolved.description,
        instructions: resolved.instructions,
        files: resolved.files.map((f) => ({ path: f.path })),
        source: resolved.source,
        source_ref: resolved.source_ref,
        hash: resolved.hash,
        installs: resolved.installs,
        audit: resolved.audit,
      });
    } catch (err) {
      if (err instanceof SkillImportError) return c.json({ error: err.message }, 400);
      // Anything else escaping the resolver is an upstream failure (skills.sh
      // or GitHub HTTP errors, rejected fetches, unparseable bodies): answer
      // 502 with the message so the dialog can show it, not an opaque 500.
      if (err instanceof SkillsShApiError) return c.json({ error: err.message }, 502);
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: `skill source request failed: ${detail}`.slice(0, 500) }, 502);
    }
  });

  app.post('/skills/import', async (c) => {
    const { installationIds } = c.get('user');
    if (installationIds.length === 0) return c.json({ error: 'no installations' }, 404);
    const capableIds = await capableInstallationIds(c, installationIds, orgAdmin);
    if (capableIds.length === 0) {
      return c.json({ error: "'settings' capability required for this action" }, 403);
    }
    const body = await c.req.json<JsonObject>().catch(() => null);
    const reference = importReference(body);
    if (!reference) {
      return c.json(
        {
          error:
            'unrecognized reference — use owner/repo/skill, a skills.sh URL, or a GitHub folder URL',
        },
        400,
      );
    }
    let resolved: Awaited<ReturnType<typeof resolveSkillImport>>;
    try {
      resolved = await resolveSkillImport(
        reference,
        isString(body?.reference) ? body.reference : '',
        installationIds[0],
        skillsSh,
      );
    } catch (err) {
      if (err instanceof SkillImportError) return c.json({ error: err.message }, 400);
      // Anything else escaping the resolver is an upstream failure (skills.sh
      // or GitHub HTTP errors, rejected fetches, unparseable bodies): answer
      // 502 with the message so the dialog can show it, not an opaque 500.
      if (err instanceof SkillsShApiError) return c.json({ error: err.message }, 502);
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: `skill source request failed: ${detail}`.slice(0, 500) }, 502);
    }
    const override = body && isString(body.slug) ? body.slug.trim().toLowerCase() : '';
    const slug = override || resolved.suggested_slug;
    const slugError = validateSlug(slug);
    if (slugError) return c.json({ error: slugError }, 400);
    const existing = await Promise.all(installationIds.map((id) => getSkillBySlug(id, slug)));
    if (existing.some(Boolean)) {
      return c.json(
        { error: `a skill with slug "${slug}" already exists — choose another slug` },
        400,
      );
    }
    await Promise.all(
      capableIds.map((id) =>
        createSkill(id, {
          slug,
          name: resolved.name,
          description: resolved.description ?? '',
          instructions: resolved.instructions,
          files: resolved.files,
          source: resolved.source,
          source_ref: resolved.source_ref,
          source_hash: resolved.hash,
          imported_at: true,
        }),
      ),
    );
    const created = await getSkillBySlug(capableIds[0], slug);
    return c.json({ ok: true, id: created?.id ?? null });
  });

  app.get('/skills/:id', async (c) => {
    const skill = await authorizedSkill(c);
    if (!skill) return c.json({ error: 'unknown skill' }, 404);
    return c.json<ApiSkillDetail>({
      skill: {
        id: skill.id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        installation_id: skill.installation_id,
        source: skill.source,
        source_ref: skill.source_ref,
        source_hash: skill.source_hash,
        imported_at: skill.imported_at,
        files: skill.files.map((f) => ({ path: f.path })),
      },
    });
  });

  app.put('/skills/:id', async (c) => {
    const skill = await authorizedSkill(c);
    if (!skill) return c.json({ error: 'unknown skill' }, 404);
    // Capable-set gate, as on PUT /agents/:id.
    const { installationIds } = c.get('user');
    const capableIds = await capableInstallationIds(c, installationIds, orgAdmin);
    if (capableIds.length === 0) {
      return c.json({ error: "'settings' capability required for this action" }, 403);
    }
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const values = readSkillPayload(body);
    const error = validateSkill(values, true);
    if (error) return c.json({ error }, 400);
    // The slug is immutable after creation; the fan-out below always keys off
    // the existing slug regardless of what the request body sent.
    values.slug = skill.slug;
    // Fan out by slug across the capable installations; skills that predate a
    // caller's installation gain their missing per-installation copies.
    const siblings = (await listSkills(capableIds)).filter((s) => s.slug === skill.slug);
    await Promise.all(siblings.map((s) => updateSkill(s.id, values)));
    const covered = new Set(siblings.map((s) => s.installation_id));
    await Promise.all(
      capableIds
        .filter((id) => !covered.has(id))
        .map((id) =>
          // Backfilled copies carry the original's files and provenance so an
          // imported skill doesn't degrade to a single-file custom skill.
          createSkill(id, {
            ...values,
            files: skill.files,
            source: skill.source,
            source_ref: skill.source_ref,
            source_hash: skill.source_hash,
            imported_at: skill.imported_at !== null,
          }),
        ),
    );
    return c.json({ ok: true });
  });

  app.delete('/skills/:id', async (c) => {
    const skill = await authorizedSkill(c);
    if (!skill) return c.json({ error: 'unknown skill' }, 404);
    // Capable-set gate, as on DELETE /agents/:id.
    const capableIds = await capableInstallationIds(c, c.get('user').installationIds, orgAdmin);
    if (capableIds.length === 0) {
      return c.json({ error: "'settings' capability required for this action" }, 403);
    }
    // Fan out by slug: deleting a generic skill removes every capable
    // installation's copy.
    const siblings = (await listSkills(capableIds)).filter((s) => s.slug === skill.slug);
    await Promise.all(siblings.map((s) => deleteSkill(s.id)));
    return c.json({ ok: true });
  });
}

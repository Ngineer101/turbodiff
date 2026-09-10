import type { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import {
  createAgent,
  deleteAgent,
  ensureBuiltinAgents,
  getAgentBySlug,
  listAgents,
  updateAgent,
} from '../../data/db.ts';
import { getModelCatalog, getReviewerModelCatalog } from '../../data/models.ts';
import { type JsonObject } from '../../shared/json.ts';
import { type ApiAgentDetail, type ApiAgentsList, type ApiModels } from '../../shared/api-types.ts';
import {
  authorizedAgent,
  capableInstallationIds,
  preferCapableCopies,
  readAgentPayload,
  validateAgent,
  type ApiEnv,
} from '../api-support.ts';
import { deferredExecution } from './execution.ts';
import type { ResolvedApiRouteDependencies } from './types.ts';

export function registerModelAgentRoutes(
  app: Hono<ApiEnv>,
  dependencies: Pick<ResolvedApiRouteDependencies, 'orgAdmin'>,
) {
  const { orgAdmin } = dependencies;
  // --- Agents: list, create, edit, delete + MCP connections ---

  // The model catalog for both pickers (runner + reviewer). Deployment-wide —
  // no tenant scoping; the router already requires an authenticated user.
  app.get('/models', async (c) => {
    const catalog = await getModelCatalog();
    return c.json<ApiModels>({
      runner: {
        options: catalog.runner.options,
        default_model: catalog.runner.defaultModel,
        fast_model: catalog.runner.fastModel,
      },
      reviewer: {
        options: catalog.reviewer.options,
        default_model: catalog.reviewer.defaultModel,
      },
    });
  });

  // Agents are generic, not per-organization: every installation carries the
  // same set of rows (UNIQUE(installation_id, slug)), and writes fan out by
  // slug, so the list dedupes to one entry per slug and any repo in any
  // installation can enable any agent.
  app.get('/agents', async (c) => {
    const { installationIds } = c.get('user');
    const agents = await listAgents(installationIds);
    // Installation webhooks own normal seeding. Keep this best-effort repair
    // path off the response's critical path for legacy or partially mirrored
    // installations.
    deferredExecution(c).waitUntil(
      Promise.all(
        installationIds.map((id) =>
          ensureBuiltinAgents(id).catch((err) =>
            console.warn(`turbodiff: agent repair failed for installation ${id}:`, err),
          ),
        ),
      ).then(() => undefined),
    );
    // One entry per slug. The copy chosen stands in for the edit page, whose
    // PUT/DELETE then fan out through the caller's capable installations — so
    // prefer a copy from one of those, or an owner of org A editing a shared
    // agent lands on org B's copy (where they are a plain member) and reads
    // stale data back after a save that skipped it.
    const capable = new Set(await capableInstallationIds(c, installationIds, orgAdmin));
    const seen = new Set<string>();
    return c.json<ApiAgentsList>({
      github_app_slug: env.GITHUB_APP_SLUG,
      agents: preferCapableCopies(agents, capable)
        .filter((a) => (seen.has(a.slug) ? false : (seen.add(a.slug), true)))
        .map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          description: a.description,
          model: a.model,
          is_builtin: a.is_builtin,
        })),
    });
  });

  app.post('/agents', async (c) => {
    const { installationIds } = c.get('user');
    if (installationIds.length === 0) return c.json({ error: 'no installations' }, 404);
    const capableIds = await capableInstallationIds(c, installationIds, orgAdmin);
    if (capableIds.length === 0) {
      return c.json({ error: "'settings' capability required for this action" }, 403);
    }
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const catalog = await getReviewerModelCatalog();
    const values = readAgentPayload(body, catalog.defaultModel);
    let error = validateAgent(
      values,
      true,
      catalog.options.map((o) => o.id),
    );
    if (!error) {
      const existing = await Promise.all(
        installationIds.map((id) => getAgentBySlug(id, values.slug)),
      );
      if (existing.some(Boolean)) error = `an agent with slug "${values.slug}" already exists`;
    }
    if (error) return c.json({ error }, 400);
    await Promise.all(capableIds.map((id) => createAgent(id, values)));
    return c.json({ ok: true });
  });

  app.get('/agents/:id', async (c) => {
    const agent = await authorizedAgent(c);
    if (!agent) return c.json({ error: 'unknown agent' }, 404);
    const catalog = await getReviewerModelCatalog();
    return c.json<ApiAgentDetail>({
      agent: {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        model: agent.model,
        is_builtin: agent.is_builtin,
        instructions: agent.instructions,
        installation_id: agent.installation_id,
      },
      default_model: catalog.defaultModel,
    });
  });

  app.put('/agents/:id', async (c) => {
    const agent = await authorizedAgent(c);
    if (!agent) return c.json({ error: 'unknown agent' }, 404);
    // Agents are generic across installations, so the gate is the same as on
    // create: the edit lands wherever the caller holds 'settings', and only a
    // caller who holds it nowhere is refused. Gating on the clicked copy's
    // installation alone denied owners of one org for being plain members of
    // another (the list picks an arbitrary copy per slug).
    const { installationIds } = c.get('user');
    const capableIds = await capableInstallationIds(c, installationIds, orgAdmin);
    if (capableIds.length === 0) {
      return c.json({ error: "'settings' capability required for this action" }, 403);
    }
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const catalog = await getReviewerModelCatalog();
    const values = { ...readAgentPayload(body, catalog.defaultModel), slug: agent.slug };
    const error = validateAgent(
      values,
      false,
      catalog.options.map((o) => o.id),
      agent.model,
    );
    if (error) return c.json({ error }, 400);
    // Fan out by slug across the capable installations; custom agents that
    // predate the generic model gain their missing per-installation copies.
    const siblings = (await listAgents(capableIds)).filter((a) => a.slug === agent.slug);
    await Promise.all(siblings.map((s) => updateAgent(s.id, values)));
    if (!agent.is_builtin) {
      const covered = new Set(siblings.map((s) => s.installation_id));
      await Promise.all(
        capableIds.filter((id) => !covered.has(id)).map((id) => createAgent(id, values)),
      );
    }
    return c.json({ ok: true });
  });

  app.delete('/agents/:id', async (c) => {
    const agent = await authorizedAgent(c);
    if (!agent) return c.json({ error: 'unknown agent' }, 404);
    // Same capable-set gate as PUT above.
    const capableIds = await capableInstallationIds(c, c.get('user').installationIds, orgAdmin);
    if (capableIds.length === 0) {
      return c.json({ error: "'settings' capability required for this action" }, 403);
    }
    if (agent.is_builtin) return c.json({ error: 'built-in agents cannot be deleted' }, 403);
    // Fan out by slug: deleting a generic agent removes every capable
    // installation's copy.
    const siblings = (await listAgents(capableIds)).filter(
      (a) => a.slug === agent.slug && !a.is_builtin,
    );
    await Promise.all(siblings.map((s) => deleteAgent(s.id)));
    return c.json({ ok: true });
  });
}

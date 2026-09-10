import type { Hono, Context } from 'hono';
import { env } from 'cloudflare:workers';
import {
  ensureBuiltinAgents,
  getAgentById,
  getSkillById,
  listAgents,
  listInstallationsWithRepos,
  listRepoAgentOverrides,
  listRepoSkillOverrides,
  listMembersWithGithubLogin,
  listPendingInvitations,
  listSkills,
  resolveAgentEnabled,
  resolveSkillEnabled,
  setRepoAgentEnabled,
  setRepoAutoFix,
  setRepoAutoMerge,
  setRepoAutoResolveConflicts,
  setRepoBlockingReviews,
  setRepoCheckCommand,
  setRepoDemoVideos,
  setRepoEnabled,
  setRepoReviewOnPush,
  setRepoReviewPushDebounceMinutes,
  setRepoReviewIntake,
  setRepoProcessProfile,
  setRepoSkillEnabled,
} from '../../data/db.ts';
import { APIError } from 'better-auth';
import { withAuth } from '../../integrations/auth/better-auth.ts';
import { inviterLabel, memberRole, organizationSummary } from '../../services/access-control.ts';
import { syncInstallationRepos } from '../../services/repository-sync.ts';
import {
  ADOPTABLE_PROCESS_PROFILE_KEYS,
  type AdoptableProcessProfileKey,
} from '../../domain/process-profiles.ts';
import { isBoolean, isJsonObject, isNumber, isString } from '../../shared/json.ts';
import {
  type ApiInvitation,
  type ApiInvitationAccepted,
  type ApiInvitationPreview,
  type ApiMember,
  type ApiOrgMembers,
  type ApiRole,
  type ApiSettings,
} from '../../shared/api-types.ts';
import {
  authorizedOrg,
  authorizedRepo,
  requireCapability,
  requireRepoPush,
  type ApiEnv,
} from '../api-support.ts';
import { deferredExecution } from './execution.ts';
import type { ResolvedApiRouteDependencies } from './types.ts';

export function registerSettingOrganizationRoutes(
  app: Hono<ApiEnv>,
  dependencies: Pick<ResolvedApiRouteDependencies, 'canPushToRepo' | 'orgAdmin'>,
) {
  const { canPushToRepo, orgAdmin } = dependencies;
  // --- Settings: per-repo config, master switch plus per-agent toggles ---

  app.get('/settings', async (c) => {
    const { installationIds } = c.get('user');
    // Self-heal the repo mirror against GitHub — a missed
    // installation_repositories webhook otherwise leaves stale repos here
    // (and on every other page reading the repositories table) forever.
    deferredExecution(c).waitUntil(
      Promise.all(
        installationIds.map((id) =>
          syncInstallationRepos(id).catch((err) =>
            console.warn(`turbodiff: repo sync failed for installation ${id}:`, err),
          ),
        ),
      ).then(() => undefined),
    );
    const [groups, agents, overrides, skills, skillOverrides] = await Promise.all([
      listInstallationsWithRepos(installationIds),
      listAgents(installationIds),
      listRepoAgentOverrides(installationIds),
      listSkills(installationIds),
      listRepoSkillOverrides(installationIds),
    ]);
    deferredExecution(c).waitUntil(
      Promise.all(
        installationIds.map((id) =>
          ensureBuiltinAgents(id).catch((err) =>
            console.warn(`turbodiff: agent repair failed for installation ${id}:`, err),
          ),
        ),
      ).then(() => undefined),
    );
    const overrideMap = new Map(
      overrides.map((o) => [`${o.repository_id}:${o.agent_id}`, o.enabled]),
    );
    const skillOverrideMap = new Map(
      skillOverrides.map((o) => [`${o.repository_id}:${o.skill_id}`, o.enabled]),
    );

    return c.json<ApiSettings>({
      github_app_slug: env.GITHUB_APP_SLUG,
      installations: groups.map(({ installation, repos }) => {
        const instAgents = agents.filter((a) => a.installation_id === installation.id);
        const instSkills = skills.filter((s) => s.installation_id === installation.id);
        return {
          id: installation.id,
          account_login: installation.account_login,
          account_type: installation.account_type,
          suspended: installation.suspended,
          repos: repos.map((r) => ({
            id: r.id,
            owner: r.owner,
            name: r.name,
            provider: r.provider,
            enabled: r.enabled,
            review_on_push: r.review_on_push,
            review_push_debounce_minutes: r.review_push_debounce_minutes,
            review_intake: r.review_intake,
            process_profile: r.process_profile,
            blocking_reviews: r.blocking_reviews,
            auto_fix: r.auto_fix,
            auto_merge: r.auto_merge,
            auto_resolve_conflicts: r.auto_resolve_conflicts,
            demo_videos: r.demo_videos,
            check_command: r.check_command,
            agents: instAgents.map((a) => ({
              id: a.id,
              slug: a.slug,
              name: a.name,
              enabled: resolveAgentEnabled(a, overrideMap.get(`${r.id}:${a.id}`)),
            })),
            skills: instSkills.map((s) => ({
              id: s.id,
              slug: s.slug,
              name: s.name,
              enabled: resolveSkillEnabled(skillOverrideMap.get(`${r.id}:${s.id}`)),
            })),
          })),
        };
      }),
    });
  });

  // --- Organizations: member management for Organization-type installations ---
  // in the auth schema. Reads use plain installation
  // membership (the hybrid model's baseline), but the org row itself is now
  // provisioned lazily on first visit for installations whose webhook was
  // missed, with the first owner bootstrapped from GitHub org-admin status
  // (orgForInstallationWithHeal); writes go through requireCapability
  // then better-auth's own organization endpoints, which double-enforce
  // permission (via the caller's real session) and already implement the
  // "can't remove/demote the org's last owner" guard — see
  // src/services/access-control.ts for why the 'member'/'invitation' resources keep
  // better-auth's own action vocabulary instead of app-specific verbs.

  // better-auth stores roles as free text; the API vocabulary is closed.
  function apiRole(role: string): ApiRole {
    return role === 'owner' || role === 'admin' ? role : 'member';
  }

  function orgApiErrorResponse<T>(c: Context<ApiEnv>, err: T): Response {
    if (!(err instanceof APIError)) throw err;
    const body = err.body;
    const message =
      body !== undefined && isJsonObject(body) && isString(body.message)
        ? body.message
        : err.message;
    switch (err.statusCode) {
      case 401:
        return c.json({ error: message }, 401);
      case 403:
        return c.json({ error: message }, 403);
      case 404:
        return c.json({ error: message }, 404);
      case 409:
        return c.json({ error: message }, 409);
      default:
        return c.json({ error: message }, 400);
    }
  }

  app.get('/organizations/:installationId/members', async (c) => {
    const resolved = await authorizedOrg(c, orgAdmin);
    if (!resolved) return c.json({ error: 'unknown organization' }, 404);
    const [members, invitations, myRole] = await Promise.all([
      listMembersWithGithubLogin(resolved.orgId),
      listPendingInvitations(resolved.orgId),
      memberRole(resolved.orgId, c.get('user').session.userId),
    ]);
    return c.json<ApiOrgMembers>({
      org_id: resolved.orgId,
      members: members.map(
        (m): ApiMember => ({
          id: m.id,
          login: m.login,
          email: m.email,
          role: apiRole(m.role),
          joined_at: m.created_at,
        }),
      ),
      invitations: invitations.map(
        (i): ApiInvitation => ({
          id: i.id,
          email: i.email,
          role: apiRole(i.role),
          status: i.status,
          expires_at: i.expires_at,
        }),
      ),
      my_role: myRole,
    });
  });

  app.post('/organizations/:installationId/invitations', async (c) => {
    const resolved = await authorizedOrg(c, orgAdmin);
    if (!resolved) return c.json({ error: 'unknown organization' }, 404);
    const denied = await requireCapability(c, resolved.installationId, 'member', orgAdmin);
    if (denied) return denied;
    const body = await c.req.json<{ email?: string; role?: string }>().catch(() => null);
    const email = body?.email?.trim();
    const role = body?.role;
    if (!email || (role !== 'owner' && role !== 'admin' && role !== 'member')) {
      return c.json(
        { error: 'body must be {"email": string, "role": "owner"|"admin"|"member"}' },
        400,
      );
    }
    try {
      const invitation = await withAuth((instance) =>
        instance.api.createInvitation({
          headers: c.req.raw.headers,
          body: { email, role, organizationId: resolved.orgId },
        }),
      );
      return c.json<ApiInvitation>({
        id: invitation.id,
        email: invitation.email,
        // SAFETY: this endpoint rejected any role outside
        // owner/admin/member above, before calling better-auth.
        role: invitation.role as ApiRole,
        status: invitation.status,
        expires_at: invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null,
      });
    } catch (err) {
      return orgApiErrorResponse(c, err);
    }
  });

  // Invitation-email landing (/accept-invite): the recipient reads the
  // invitation they were sent, then accepts it. Both run better-auth's own
  // endpoints on the caller's real session, so its recipient check
  // (invitation email = session email), expiry, and membership limit apply
  // unchanged — no installation gate here, because the recipient has no
  // installation access yet; the email match is the whole authorization.
  app.get('/invitations/:id', async (c) => {
    try {
      const invitation = await withAuth((instance) =>
        instance.api.getInvitation({
          headers: c.req.raw.headers,
          query: { id: c.req.param('id') },
        }),
      );
      const [org, invitedBy] = await Promise.all([
        organizationSummary(invitation.organizationId),
        inviterLabel(invitation.inviterId),
      ]);
      return c.json<ApiInvitationPreview>({
        id: invitation.id,
        email: invitation.email,
        role: apiRole(invitation.role),
        org_name: org?.name ?? invitation.organizationName,
        installation_id: org?.installationId ?? null,
        invited_by: invitedBy,
        expires_at: invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null,
      });
    } catch (err) {
      return orgApiErrorResponse(c, err);
    }
  });

  app.post('/invitations/:id/accept', async (c) => {
    try {
      const accepted = await withAuth((instance) =>
        instance.api.acceptInvitation({
          headers: c.req.raw.headers,
          body: { invitationId: c.req.param('id') },
        }),
      );
      const org = await organizationSummary(accepted.invitation.organizationId);
      return c.json<ApiInvitationAccepted>({
        org_name: org?.name ?? '',
        installation_id: org?.installationId ?? null,
      });
    } catch (err) {
      return orgApiErrorResponse(c, err);
    }
  });

  app.delete('/organizations/:installationId/members/:memberId', async (c) => {
    const resolved = await authorizedOrg(c, orgAdmin);
    if (!resolved) return c.json({ error: 'unknown organization' }, 404);
    const denied = await requireCapability(c, resolved.installationId, 'member', orgAdmin);
    if (denied) return denied;
    try {
      await withAuth((instance) =>
        instance.api.removeMember({
          headers: c.req.raw.headers,
          body: { memberIdOrEmail: c.req.param('memberId'), organizationId: resolved.orgId },
        }),
      );
      return c.json({ ok: true });
    } catch (err) {
      return orgApiErrorResponse(c, err);
    }
  });

  app.patch('/organizations/:installationId/members/:memberId', async (c) => {
    const resolved = await authorizedOrg(c, orgAdmin);
    if (!resolved) return c.json({ error: 'unknown organization' }, 404);
    const denied = await requireCapability(c, resolved.installationId, 'member', orgAdmin);
    if (denied) return denied;
    const body = await c.req.json<{ role?: string }>().catch(() => null);
    const role = body?.role;
    if (role !== 'owner' && role !== 'admin' && role !== 'member') {
      return c.json({ error: 'body must be {"role": "owner"|"admin"|"member"}' }, 400);
    }
    try {
      await withAuth((instance) =>
        instance.api.updateMemberRole({
          headers: c.req.raw.headers,
          body: { memberId: c.req.param('memberId'), role, organizationId: resolved.orgId },
        }),
      );
      return c.json({ ok: true });
    } catch (err) {
      return orgApiErrorResponse(c, err);
    }
  });

  // One PATCH for every repo toggle plus the check command. These flip the
  // repo's security posture (blocking reviews, auto-fix, auto-merge) and
  // check_command is shell that later runs in the fix sandbox — so beyond
  // installation membership this demands verified push permission, the same
  // bar as the merge these toggles can automate.
  // The queue delays a push review by at most 12 hours (the repositories
  // CHECK constraint mirrors this bound).
  const MAX_PUSH_DEBOUNCE_MINUTES = 720;
  const isValidPushDebounceMinutes = (minutes: number): boolean =>
    Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_PUSH_DEBOUNCE_MINUTES;
  app.patch('/repos/:id', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    // GitHub repos additionally demand verified push permission (these
    // toggles automate pushes and merges). Artifacts repos have no GitHub
    // side to ask — the org 'settings' capability above IS the authority,
    // same bar as the native merge.
    if (repo.provider !== 'artifacts') {
      const denied = await requireRepoPush(c, repo, canPushToRepo);
      if (denied) return denied;
    }
    const body = await c.req
      .json<{
        enabled?: boolean;
        review_on_push?: boolean;
        review_push_debounce_minutes?: number;
        review_intake?: 'factory_only' | 'on_demand' | 'all_changes';
        process_profile?: AdoptableProcessProfileKey;
        blocking_reviews?: boolean;
        auto_fix?: boolean;
        auto_merge?: boolean;
        auto_resolve_conflicts?: boolean;
        demo_videos?: boolean;
        check_command?: string;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    if (
      body.review_intake !== undefined &&
      body.review_intake !== 'factory_only' &&
      body.review_intake !== 'on_demand' &&
      body.review_intake !== 'all_changes'
    ) {
      return c.json(
        { error: 'review_intake must be factory_only, on_demand, or all_changes' },
        400,
      );
    }
    if (
      body.process_profile !== undefined &&
      !ADOPTABLE_PROCESS_PROFILE_KEYS.includes(body.process_profile)
    ) {
      return c.json(
        { error: `process_profile must be ${ADOPTABLE_PROCESS_PROFILE_KEYS.join(', ')}` },
        400,
      );
    }
    if (
      body.review_push_debounce_minutes !== undefined &&
      !(
        isNumber(body.review_push_debounce_minutes) &&
        isValidPushDebounceMinutes(body.review_push_debounce_minutes)
      )
    ) {
      return c.json(
        {
          error: `review_push_debounce_minutes must be an integer between 0 and ${MAX_PUSH_DEBOUNCE_MINUTES}`,
        },
        400,
      );
    }
    if (isBoolean(body.enabled)) await setRepoEnabled(repo.id, body.enabled);
    if (isBoolean(body.review_on_push)) await setRepoReviewOnPush(repo.id, body.review_on_push);
    if (isNumber(body.review_push_debounce_minutes)) {
      await setRepoReviewPushDebounceMinutes(repo.id, body.review_push_debounce_minutes);
    }
    if (body.review_intake) await setRepoReviewIntake(repo.id, body.review_intake);
    if (body.process_profile) await setRepoProcessProfile(repo.id, body.process_profile);
    if (isBoolean(body.blocking_reviews))
      await setRepoBlockingReviews(repo.id, body.blocking_reviews);
    if (isBoolean(body.auto_fix)) await setRepoAutoFix(repo.id, body.auto_fix);
    if (isBoolean(body.auto_merge)) await setRepoAutoMerge(repo.id, body.auto_merge);
    if (isBoolean(body.auto_resolve_conflicts))
      await setRepoAutoResolveConflicts(repo.id, body.auto_resolve_conflicts);
    if (isBoolean(body.demo_videos)) await setRepoDemoVideos(repo.id, body.demo_videos);
    if (isString(body.check_command)) await setRepoCheckCommand(repo.id, body.check_command);
    return c.json({ ok: true });
  });

  app.put('/repos/:id/agents/:agentId', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    // GitHub repos additionally demand verified push permission (these
    // toggles automate pushes and merges). Artifacts repos have no GitHub
    // side to ask — the org 'settings' capability above IS the authority,
    // same bar as the native merge.
    if (repo.provider !== 'artifacts') {
      const denied = await requireRepoPush(c, repo, canPushToRepo);
      if (denied) return denied;
    }
    const agentId = Number(c.req.param('agentId'));
    const agent = Number.isInteger(agentId) ? await getAgentById(agentId) : null;
    if (!agent || agent.installation_id !== repo.installation_id) {
      return c.json({ error: 'unknown agent' }, 404);
    }
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => null);
    const enabled = body?.enabled;
    if (!isBoolean(enabled)) {
      return c.json({ error: 'body must be {"enabled": true|false}' }, 400);
    }
    await setRepoAgentEnabled(repo.id, agent.id, enabled);
    return c.json({ ok: true });
  });

  app.put('/repos/:id/skills/:skillId', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    // GitHub repos additionally demand verified push permission (these
    // toggles automate pushes and merges). Artifacts repos have no GitHub
    // side to ask — the org 'settings' capability above IS the authority,
    // same bar as the native merge.
    if (repo.provider !== 'artifacts') {
      const denied = await requireRepoPush(c, repo, canPushToRepo);
      if (denied) return denied;
    }
    const skillId = Number(c.req.param('skillId'));
    const skill = Number.isInteger(skillId) ? await getSkillById(skillId) : null;
    if (!skill || skill.installation_id !== repo.installation_id) {
      return c.json({ error: 'unknown skill' }, 404);
    }
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => null);
    const enabled = body?.enabled;
    if (!isBoolean(enabled)) {
      return c.json({ error: 'body must be {"enabled": true|false}' }, 400);
    }
    await setRepoSkillEnabled(repo.id, skill.id, enabled);
    return c.json({ ok: true });
  });
}

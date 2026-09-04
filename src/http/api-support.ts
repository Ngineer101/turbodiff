import type { Context } from 'hono';
import {
  getAgentById,
  getAutomationById,
  getPlan,
  getRepoById,
  getSkillById,
  type AgentRow,
  type AgentRunRow,
  type AutomationFields,
  type AutomationRow,
  type ChatMessageRow,
  type CockpitCommentRow,
  type FeatureUsageRow,
  type FixAttemptRow,
  type PlanRow,
  type PlanWithRepo,
  type RepositoryRow,
  type ReviewActivityRow,
  type SkillRow,
  type TaskRepoStatusRow,
  type VerificationRow,
} from '../data/db.ts';
import { RESERVED_AGENT_SLUGS } from '../domain/personas.ts';
import { certificateUrl } from '../services/certificates.ts';
import { capabilityDenied, orgForInstallationWithHeal } from '../services/access-control.ts';
import { userCanPushToRepo, type AuthedUser, type userIsGithubOrgAdmin } from '../services/auth.ts';
import { DEFAULT_RUNNER_MODEL } from '../shared/runner-models.ts';
import { isNumber, isString, type JsonObject } from '../shared/json.ts';
import { parseUtc, STALL_AFTER_MS, VERIFY_STALL_AFTER_MS } from '../shared/time.ts';
import type {
  ApiAgentRun,
  ApiAutomationSummary,
  ApiChatMessage,
  ApiCockpitComment,
  ApiFeatureUsage,
  ApiFeatureUsageSession,
  ApiPlan,
  ApiPlanQuestion,
  ApiReview,
  ApiVerificationSummary,
} from '../shared/api-types.ts';

// HTTP presentation, payload validation, and resource authorization helpers.

export function reviewState(r: ReviewActivityRow): ApiReview['state'] {
  if (r.status === 'failed') return 'failed';
  if (r.status !== 'running') return 'completed';
  return Date.now() - parseUtc(r.created_at) > STALL_AFTER_MS ? 'stalled' : 'running';
}

// Shared by every usage-cost row shape (reviews, fix attempts, verifications,
// features' own generation row) — they all carry the same 4 token columns.
export function totalTokens(row: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}): number {
  return row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens;
}

export function serializeReview(r: ReviewActivityRow): ApiReview {
  const repo = r.repo_owner && r.repo_name ? `${r.repo_owner}/${r.repo_name}` : null;
  return {
    id: r.id,
    repo,
    pr_number: r.pr_number,
    pr_url: repo ? `https://github.com/${repo}/pull/${r.pr_number}` : null,
    agent_slug: r.agent_slug,
    trigger_event: r.trigger_event,
    risk_tier: r.risk_tier,
    findings_count: r.findings_count,
    state: reviewState(r),
    error: r.error,
    review_url: r.review_url,
    total_tokens: totalTokens(r),
    cost_usd: r.cost_usd,
    duration_s:
      r.completed_at === null ? null : (parseUtc(r.completed_at) - parseUtc(r.created_at)) / 1000,
    created_at: r.created_at,
  };
}

// A generation attempt actually ran only when its usage columns hold real
// data — a still-queued (or never-metered) feature keeps its all-zero
// defaults, and the accordion shows no "generate" session for it rather than
// a misleading all-dashes row.
export function hasUsage(row: { cost_usd: number; model: string | null }): boolean {
  return row.cost_usd > 0 || row.model !== null;
}

// Every session belonging to one shipped feature, chronological. Reuses
// totalTokens/reviewState for the review sessions; fix/verify/generate rows
// sum their own 4 token columns the same way.
export async function serializeFeatureUsage(
  f: FeatureUsageRow,
  reviews: ReviewActivityRow[],
  fixes: FixAttemptRow[],
  verifications: VerificationRow[],
): Promise<ApiFeatureUsage> {
  const repo = `${f.repo_owner}/${f.repo_name}`;
  const prUrl = f.pr_number !== null ? `https://github.com/${repo}/pull/${f.pr_number}` : null;

  const sessions: ApiFeatureUsageSession[] = [];
  if (hasUsage(f)) {
    sessions.push({
      kind: 'generate',
      label: 'generate',
      status: f.status,
      cost_usd: f.cost_usd,
      total_tokens: totalTokens(f),
      duration_s: null,
      created_at: f.created_at,
      url: prUrl,
    });
  }
  for (const r of reviews) {
    sessions.push({
      kind: 'review',
      label: r.agent_slug ?? 'review',
      status: reviewState(r),
      cost_usd: r.cost_usd,
      total_tokens: totalTokens(r),
      duration_s:
        r.completed_at === null ? null : (parseUtc(r.completed_at) - parseUtc(r.created_at)) / 1000,
      created_at: r.created_at,
      url: r.review_url,
    });
  }
  for (const fx of fixes) {
    sessions.push({
      kind: 'fix',
      label: fx.trigger,
      status: fx.status,
      cost_usd: fx.cost_usd,
      total_tokens: totalTokens(fx),
      duration_s: null, // fix_attempts has no completion timestamp
      created_at: fx.created_at,
      url: prUrl,
    });
  }
  for (const v of verifications) {
    // The shareable "Proof of Build" certificate only exists once
    // verification has actually passed (mirrors postReport's cert gate).
    const url = v.status === 'passed' ? await certificateUrl(f.id) : null;
    sessions.push({
      kind: 'verify',
      label: 'verify',
      status: v.status,
      cost_usd: v.cost_usd,
      total_tokens: totalTokens(v),
      duration_s: null, // verifications has no completion timestamp
      created_at: v.created_at,
      url,
    });
  }
  sessions.sort((a, b) => parseUtc(a.created_at) - parseUtc(b.created_at));

  return {
    id: f.id,
    title: f.title,
    repo,
    status: f.status,
    pr_number: f.pr_number,
    pr_url: prUrl,
    created_at: f.created_at,
    total_cost_usd: sessions.reduce((sum, s) => sum + s.cost_usd, 0),
    total_tokens: sessions.reduce((sum, s) => sum + s.total_tokens, 0),
    sessions,
  };
}

// Groups the exact review/fix-attempt tuple query results for presentation.
export function groupByRepoPr<T extends { repository_id: number; pr_number: number }>(
  rows: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.repository_id}:${row.pr_number}`;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

export function verificationSummary(
  status: string | null,
  results: { verdict: string }[] | null,
  createdAt: string | null,
): ApiVerificationSummary | null {
  if (!status) return null;
  const rows = results ?? [];
  // Display-only, mirroring reviewState: the DB row stays 'running' until the
  // cron sweep (failStrandedVerifications) resolves it to 'error'.
  const stalled =
    status === 'running' &&
    createdAt !== null &&
    Date.now() - parseUtc(createdAt) > VERIFY_STALL_AFTER_MS;
  return {
    status: stalled ? 'stalled' : status,
    total: rows.length,
    failed: rows.filter((r) => r.verdict === 'fail').length,
  };
}

export function serializeAgentRun(r: AgentRunRow): ApiAgentRun {
  return { id: r.id, kind: r.kind, success: r.success, created_at: r.created_at };
}

type CockpitFixStatus = NonNullable<ApiCockpitComment['fix_status']>;
const COCKPIT_FIX_STATUSES = new Set<string>([
  'running',
  'fixed',
  'no_changes',
  'tests_failed',
  'failed',
] satisfies CockpitFixStatus[]);

export function isCockpitFixStatus<T extends string>(value: T): value is T & CockpitFixStatus {
  return COCKPIT_FIX_STATUSES.has(value);
}

export function serializeCockpitComment(r: CockpitCommentRow): ApiCockpitComment {
  const fixStatus = r.fix_status && isCockpitFixStatus(r.fix_status) ? r.fix_status : null;
  return {
    id: r.id,
    path: r.path,
    line: r.line,
    side: r.side,
    body: r.body,
    author: r.author,
    status: r.status,
    created_at: r.created_at,
    fix_status: fixStatus,
  };
}

export function serializeChatMessage(r: ChatMessageRow): ApiChatMessage {
  return {
    id: r.id,
    // SAFETY: chat_messages.role is written only by createUserChatMessage
    // ('user') and addAssistantChatMessage ('assistant').
    role: r.role as ApiChatMessage['role'],
    body: r.body,
    author: r.author,
    status: r.status,
    // SAFETY: chat_messages.outcome is written only by the chat runner via
    // addAssistantChatMessage with a ChatOutcome value; null on user rows.
    outcome: r.outcome as ApiChatMessage['outcome'],
    commit_sha: r.commit_sha,
    error: r.error,
    created_at: r.created_at,
  };
}

export function serializeTask(
  p: PlanWithRepo,
  repoStatuses: TaskRepoStatusRow[],
  // The board renders cards, never the plan body — omitting it keeps the
  // full plan markdown of up to 50 tasks out of every board response. The
  // task page passes true.
  opts: { includePlan: boolean } = { includePlan: true },
): ApiPlan {
  const questions: ApiPlanQuestion[] = p.questions ?? [];
  const acceptance = p.acceptance ?? [];
  const attachments = p.attachments ?? [];
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    error: p.error,
    created_at: p.created_at,
    questions,
    acceptance,
    plan: opts.includePlan ? p.plan : null,
    archived: p.archived,
    model: p.runner_model ?? DEFAULT_RUNNER_MODEL,
    attachments: attachments.map((a) => ({ name: a.name })),
    repos: repoStatuses
      .filter((r) => r.plan_id === p.id)
      .map((r) => ({
        repository_id: r.repository_id,
        owner: r.owner,
        name: r.name,
        provider: r.provider,
        feature_id: r.feature_id,
        pr_number: r.pr_number,
        feature_status: r.feature_status,
        feature_error: r.feature_error,
        verification: verificationSummary(
          r.verification_status,
          r.verification_results,
          r.verification_created_at,
        ),
      })),
  };
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface AgentFormValues {
  name: string;
  slug: string;
  description: string;
  instructions: string;
  model: string;
}

export function readAgentPayload(body: JsonObject, defaultModel: string): AgentFormValues {
  const get = (k: string) => {
    const v = body[k];
    return isString(v) ? v.trim() : '';
  };
  return {
    name: get('name'),
    slug: get('slug').toLowerCase(),
    description: get('description'),
    instructions: get('instructions'),
    model: get('model') || defaultModel,
  };
}

export function validateAgent(
  v: AgentFormValues,
  checkSlug: boolean,
  allowedModels: readonly string[],
  currentModel?: string,
): string | null {
  if (!v.name) return 'name is required';
  if (checkSlug && (v.slug.length < 2 || v.slug.length > 31 || !SLUG_RE.test(v.slug)))
    return 'slug must be 2-31 chars: lowercase letters and digits separated by single dashes';
  if (checkSlug && RESERVED_AGENT_SLUGS.has(v.slug)) return `"${v.slug}" is a reserved word`;
  if (!v.instructions) return 'instructions are required';
  // currentModel lets an agent whose stored model predates the catalog be
  // re-saved unchanged; any other out-of-catalog value fails.
  if (!allowedModels.includes(v.model) && v.model !== currentModel)
    return 'model must be one of the configured models';
  return null;
}

export interface SkillFormValues {
  name: string;
  slug: string;
  description: string;
  instructions: string;
}

export function readSkillPayload(body: JsonObject): SkillFormValues {
  const get = (k: string) => {
    const v = body[k];
    return isString(v) ? v.trim() : '';
  };
  return {
    name: get('name'),
    slug: get('slug').toLowerCase(),
    description: get('description'),
    instructions: get('instructions'),
  };
}

export function validateSkill(v: SkillFormValues, checkSlug: boolean): string | null {
  if (!v.name) return 'name is required';
  if (checkSlug && (v.slug.length < 2 || v.slug.length > 31 || !SLUG_RE.test(v.slug)))
    return 'slug must be 2-31 chars: lowercase letters and digits separated by single dashes';
  if (!v.instructions) return 'instructions are required';
  return null;
}

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SCHEDULE_KINDS = new Set(['hourly', 'daily', 'weekly']);

export function readAutomationPayload(body: JsonObject): AutomationFields {
  const get = (k: string) => {
    const v = body[k];
    return isString(v) ? v.trim() : '';
  };
  const timeOfDay = get('time_of_day');
  const dayOfWeek = body.day_of_week;
  return {
    name: get('name'),
    prompt: get('prompt'),
    schedule_kind: get('schedule_kind'),
    time_of_day: timeOfDay || null,
    day_of_week: isNumber(dayOfWeek) && Number.isInteger(dayOfWeek) ? dayOfWeek : null,
  };
}

export function validateAutomation(v: AutomationFields): string | null {
  if (!v.name) return 'name is required';
  if (!v.prompt) return 'prompt is required';
  if (!SCHEDULE_KINDS.has(v.schedule_kind)) {
    return 'schedule_kind must be hourly, daily, or weekly';
  }
  if (v.schedule_kind === 'hourly') {
    if (v.time_of_day !== null) return 'hourly automations cannot set a time of day';
  } else if (!v.time_of_day || !TIME_OF_DAY_RE.test(v.time_of_day)) {
    return 'time_of_day is required (HH:MM, 24h UTC)';
  }
  if (v.schedule_kind === 'weekly') {
    if (v.day_of_week === null || v.day_of_week < 0 || v.day_of_week > 6) {
      return 'day_of_week is required for weekly automations (0-6)';
    }
  } else if (v.day_of_week !== null) {
    return 'day_of_week is only valid for weekly automations';
  }
  return null;
}

export function serializeAutomation(
  a: AutomationRow,
  repo: { id: number; owner: string; name: string },
  lastRun: { id: number; status: string; created_at: string } | null,
): ApiAutomationSummary {
  return {
    id: a.id,
    name: a.name,
    repository: { id: repo.id, owner: repo.owner, name: repo.name },
    // SAFETY: automations.schedule_kind passes validateAutomation's SCHEDULE_KINDS
    // ('hourly' | 'daily' | 'weekly') membership check before every insert/update.
    schedule_kind: a.schedule_kind as ApiAutomationSummary['schedule_kind'],
    time_of_day: a.time_of_day,
    day_of_week: a.day_of_week,
    enabled: a.enabled,
    next_run_at: a.next_run_at,
    last_run: lastRun,
  };
}

export const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export function validConnectionUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    // Plain http only for local development targets.
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export type ApiEnv = { Variables: { user: AuthedUser } };

// Load the plan named by the :id param only if the caller may manage the repo
// it belongs to (its installation is in the user's set). Null otherwise.
export async function authorizedPlan(c: Context<ApiEnv>): Promise<PlanRow | null> {
  const id = Number(c.req.param('id'));
  const plan = Number.isInteger(id) ? await getPlan(id) : null;
  if (!plan) return null;
  const repo = await getRepoById(plan.repository_id);
  if (!repo || !c.get('user').installationIds.includes(repo.installation_id)) return null;
  return plan;
}

export async function authorizedAgent(c: Context<ApiEnv>): Promise<AgentRow | null> {
  const id = Number(c.req.param('id'));
  const agent = Number.isInteger(id) ? await getAgentById(id) : null;
  if (!agent || !c.get('user').installationIds.includes(agent.installation_id)) return null;
  return agent;
}

export async function authorizedSkill(c: Context<ApiEnv>): Promise<SkillRow | null> {
  const id = Number(c.req.param('id'));
  const skill = Number.isInteger(id) ? await getSkillById(id) : null;
  if (!skill || !c.get('user').installationIds.includes(skill.installation_id)) return null;
  return skill;
}

export async function authorizedRepo(c: Context<ApiEnv>): Promise<RepositoryRow | null> {
  const id = Number(c.req.param('id'));
  const repo = Number.isInteger(id) ? await getRepoById(id) : null;
  if (!repo || !c.get('user').installationIds.includes(repo.installation_id)) return null;
  return repo;
}

// Ownership runs through the automation's fixed repository_id — an
// automation has no installation_id of its own.
export async function authorizedAutomation(c: Context<ApiEnv>): Promise<AutomationRow | null> {
  const id = Number(c.req.param('id'));
  const automation = Number.isInteger(id) ? await getAutomationById(id) : null;
  if (!automation) return null;
  const repo = await getRepoById(automation.repository_id);
  if (!repo || !c.get('user').installationIds.includes(repo.installation_id)) return null;
  return automation;
}

// Resolves the :installationId param to its linked organization, only when
// the caller's installationIds already covers it (the same GitHub-derived
// baseline every other authorizedX helper checks). Personal installations
// and unknown ids still 404 (not 403: there's nothing here to manage
// regardless of role); an Organization-type installation with a missing org
// row is provisioned on first visit, and a GitHub org admin is bootstrapped
// as the first owner (orgForInstallationWithHeal).
export async function authorizedOrg(
  c: Context<ApiEnv>,
  isOrgAdmin: typeof userIsGithubOrgAdmin,
): Promise<{ installationId: number; orgId: string } | null> {
  const installationId = Number(c.req.param('installationId'));
  if (
    !Number.isInteger(installationId) ||
    !c.get('user').installationIds.includes(installationId)
  ) {
    return null;
  }
  const org = await orgForInstallationWithHeal(c.get('user'), installationId, isOrgAdmin);
  if (!org) return null;
  return { installationId, orgId: org.id };
}

// Agents/skills are generic across installations (one create/edit fans out
// to every installation the caller belongs to) — so unlike the single-repo
// routes above, gating "settings" capability here means narrowing the fan-out
// target list rather than a single allow/deny. An installation drops out of
// the result if the caller's role there doesn't carry 'settings' (e.g. a
// 'member' on that installation's organization), even though installationIds
// itself already includes it.
export async function capableInstallationIds(
  c: Context<ApiEnv>,
  installationIds: number[],
  isOrgAdmin: typeof userIsGithubOrgAdmin,
): Promise<number[]> {
  const user = c.get('user');
  const checked = await Promise.all(
    installationIds.map(async (id) =>
      (await capabilityDenied(user, id, 'settings', isOrgAdmin)) ? null : id,
    ),
  );
  return checked.filter((id): id is number => id !== null);
}

// The per-slug lists (agents, skills) show one copy per slug and the edit
// page mutates through that copy's id. Stable-partition the rows so copies
// from capable installations come first: the dedupe then picks an editable
// copy whenever one exists, and the post-save refetch reads the updated row.
export function preferCapableCopies<Row extends { installation_id: number }>(
  rows: Row[],
  capable: ReadonlySet<number>,
): Row[] {
  return [
    ...rows.filter((row) => capable.has(row.installation_id)),
    ...rows.filter((row) => !capable.has(row.installation_id)),
  ];
}

// HTTP mapping for the capability gate: null means allowed, a ready-to-return
// 403 otherwise — the same null-means-allowed contract as requireRepoPush.
export async function requireCapability(
  c: Context<ApiEnv>,
  installationId: number,
  action: 'member' | 'settings',
  isOrgAdmin: typeof userIsGithubOrgAdmin,
): Promise<Response | null> {
  const denied = await capabilityDenied(c.get('user'), installationId, action, isOrgAdmin);
  return denied ? c.json({ error: denied }, 403) : null;
}

// Push (write) permission on the repo, verified against GitHub with the
// caller's own token. Installation membership (the read gate on every route)
// is deliberately weaker: GitHub reports an org installation to read-only
// members too, and the write routes below act with the App installation
// token — which carries the App's permissions, not the caller's. Anything
// that writes to the repo or changes how code reaches it re-checks the
// caller's real GitHub permission first. Null when allowed; the 403 to
// return otherwise.
export async function requireRepoPush(
  c: Context<ApiEnv>,
  repo: { owner: string; name: string },
  canPush: typeof userCanPushToRepo,
): Promise<Response | null> {
  if (await canPush(c.get('user'), repo.owner, repo.name)) return null;
  return c.json({ error: 'push access to the repository is required for this action' }, 403);
}

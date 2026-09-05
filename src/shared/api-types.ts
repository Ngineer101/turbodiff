// The JSON contract between the Worker's /api routes (src/http/api.ts) and
// the SPA (src/client). Keep this file dependency-free: it is type-checked in
// both the worker and client TypeScript programs.

export type ReviewState = 'running' | 'completed' | 'stalled' | 'failed';

export type ApiProcessProfile =
  | 'review_on_demand'
  | 'automatic_review'
  | 'review_and_repair'
  | 'idea_to_pr'
  | 'assisted_delivery'
  | 'full_delivery'
  | 'native_turnkey'
  | 'legacy_factory';

// One review row, pre-digested for display: the worker computes state (which
// needs the stall clock) and totals; the client only formats.
export interface ApiReview {
  id: number;
  repo: string | null; // "owner/name", null if the repo was removed
  pr_number: number;
  pr_url: string | null;
  agent_slug: string | null;
  trigger_event: string;
  risk_tier: string | null;
  findings_count: number | null;
  state: ReviewState;
  error: string | null; // why a failed review failed
  review_url: string | null;
  total_tokens: number;
  cost_usd: number;
  duration_s: number | null;
  created_at: string; // ISO-8601 timestamptz
}

// One session (generation, review, fix, or verify run) inside a shipped
// feature's usage accordion.
export interface ApiFeatureUsageSession {
  kind: 'generate' | 'review' | 'fix' | 'verify';
  label: string; // agent slug for review, trigger for fix, etc.
  status: string;
  cost_usd: number;
  total_tokens: number;
  duration_s: number | null;
  created_at: string;
  url: string | null; // review_url / PR url / certificate url
}

// A shipped feature and every session (generation, reviews, fix attempts,
// verifications) that belongs to it — the usage page's "Features shipped"
// accordion. Legacy reviews with no matching feature never surface here.
export interface ApiFeatureUsage {
  id: number;
  title: string;
  repo: string | null;
  status: string; // features.status
  pr_number: number | null;
  pr_url: string | null;
  created_at: string;
  total_cost_usd: number;
  total_tokens: number;
  sessions: ApiFeatureUsageSession[];
}

// Usage page payload (the pre-board dashboard metrics).
export interface ApiUsage {
  month: string; // 'YYYY-MM'
  stats: {
    month_reviews: number;
    // Review-stage cost only, same value as before this field was renamed.
    month_review_cost_usd: number;
    // Review + generation + fix + verification + automation for the month.
    // Plan-stage spend is not metered, so this is not a total-spend figure.
    month_pipeline_cost_usd: number;
    month_tokens: number;
    avg_duration_s: number | null;
    avg_findings: number | null;
    running: number;
  };
  // Pipeline cost by month (all metered stages) so the current-month row
  // reconciles with stats.month_pipeline_cost_usd. `reviews` and
  // `total_tokens` remain review-stage figures.
  months: { month: string; reviews: number; total_tokens: number; pipeline_cost_usd: number }[];
  agent_usage: { agent_slug: string | null; reviews: number; cost_usd: number }[];
  repo_count: number;
  enabled_count: number;
  recent_repos: {
    id: number;
    owner: string;
    name: string;
    enabled: boolean;
    suspended: boolean;
    reviews: number;
    cost_usd: number;
  }[];
  features: ApiFeatureUsage[];
  automation_usage: {
    automation_id: number;
    name: string;
    repo: string;
    runs: number;
    cost_usd: number;
  }[];
}

export interface ApiReviewsPage {
  total: number;
  page: number;
  pages: number;
  reviews: ApiReview[];
}

export type PlanStatus =
  | 'analyzing'
  | 'awaiting_answers'
  | 'refining'
  | 'plan_ready'
  | 'approved'
  | 'failed';

export interface ApiVerificationSummary {
  status: string; // running | stalled | passed | failed | error
  total: number;
  failed: number;
}

// One repo attached to a task, with its independent feature/PR/verification
// status — a multi-repo task carries one of these per repo, each generated
// and retryable independently of the others.
export interface ApiTaskRepo {
  repository_id: number;
  owner: string;
  name: string;
  provider: string; // 'github' | 'artifacts'
  feature_id: number | null;
  pr_number: number | null;
  feature_status: string | null;
  feature_error: string | null;
  verification: ApiVerificationSummary | null;
}

export interface ApiPlanQuestion {
  text: string;
  // Present only when the model returned 2+ usable options; absent means
  // render as a free-text-only question (legacy-equivalent fallback).
  options?: string[];
  // Always present when `options` is present — the option text to submit
  // by default if the user advances without answering.
  recommended?: string;
}

export interface ApiPlan {
  id: number;
  title: string;
  // Known statuses plus forward-compat for values newer than this client.
  status: PlanStatus | (string & {});
  error: string | null;
  created_at: string;
  questions: ApiPlanQuestion[];
  acceptance: string[];
  plan: string | null;
  archived: boolean;
  // The model this task's sandboxed runs use (see src/shared/runner-models.ts).
  model: string;
  attachments: { name: string }[];
  repos: ApiTaskRepo[];
}

// One agent-session run (plan analyze/refine, generate, verify, fix,
// automation) — a pointer to its full stdout+stderr transcript, fetched on
// demand via GET /api/factory/runs/:id/log.
export interface ApiAgentRun {
  id: number;
  kind:
    | 'plan_analyze'
    | 'plan_refine'
    | 'generate'
    | 'verify'
    | 'fix'
    | 'chat'
    | 'automation'
    | 'resolve_conflict';
  success: boolean;
  created_at: string;
}

// GET /api/tasks/:id — the board card's plan detail plus its plan_analyze /
// plan_refine session logs. Kept separate from ApiPlan (rather than adding
// runs there) since ApiPlan is also every board card's shape (ApiBoard.tasks),
// and the board never renders runs — folding it in would cost an extra query
// per card.
export interface ApiTaskDetail extends ApiPlan {
  runs: ApiAgentRun[];
}

export interface ApiCockpitComment {
  id: number;
  path: string;
  line: number;
  side: string;
  body: string;
  author: string;
  status: string;
  created_at: string;
  // The linked fix run's status: null before any batch submit; 'running'
  // while it's in flight; a terminal outcome once it resolves.
  fix_status: 'running' | 'fixed' | 'no_changes' | 'tests_failed' | 'failed' | null;
}

// One cockpit chat message — a user's instruction to the chat agent or the
// agent's reply for that turn.
export interface ApiChatMessage {
  id: number;
  role: 'user' | 'assistant';
  body: string;
  author: string | null; // login for user messages
  // Turn lifecycle for user messages ('queued' | 'running' | 'done' |
  // 'failed'); assistant messages are always 'done'.
  status: string;
  // Assistant messages: what the turn did to the branch.
  outcome: 'changed' | 'no_changes' | 'tests_failed' | null;
  commit_sha: string | null;
  error: string | null;
  created_at: string;
}

export interface ApiChatList {
  messages: ApiChatMessage[];
}

export interface ApiLifecycleRun {
  id: number;
  profile: ApiProcessProfile;
  status: 'active' | 'awaiting_human' | 'handed_off' | 'completed' | 'failed' | 'cancelled';
  start_stage: string;
  stop_after_stage: string;
  handoff_reason: string | null;
  created_at: string;
  completed_at: string | null;
  stages: {
    id: number;
    stage: string;
    attempt: number;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    // Verify stages: the verification's own status ('passed' | 'failed' |
    // 'error'); a completed stage with a failed verdict is not green.
    verdict: string | null;
    error: string | null;
    started_at: string | null;
    completed_at: string | null;
  }[];
  events: {
    key: string;
    kind: string;
    decision: string | null;
    reason: string | null;
    created_at: string;
  }[];
}

export interface ApiFeatureDetail {
  feature: {
    id: number;
    title: string;
    status: string;
    error: string | null;
    pr_number: number | null;
    // Awaiting a human decision: a cockpit-comment fix diverged from the
    // approved acceptance criteria (update criteria vs restore behavior).
    criteria_conflict: boolean;
    // Machine-drafted criteria rewrite awaiting approval (prefills the
    // decision card); null when drafting failed or no conflict.
    proposed_criteria: string[] | null;
  };
  repo: string; // "owner/name"
  provider: string; // 'github' | 'artifacts'
  // Source-branch head for the immutable diff snapshot. A new commit changes
  // the query key; comments/status-only updates keep the existing patch data.
  diff_version: string | null;
  // Native change-request number for Artifacts repos ("CR #3").
  cr_number: number | null;
  // Native check runs (Artifacts repos): repo check, review verdict, verify.
  checks: { name: string; status: string; summary: string | null }[];
  plan: string | null;
  // Null while generation hasn't opened a PR yet.
  pr: {
    state: 'open' | 'merged' | 'closed' | (string & {});
    // Null for native change requests — they have no external page.
    html_url: string | null;
    additions: number;
    deletions: number;
    changed_files: number;
    // GitHub's mergeable_state ('dirty' means a conflict with the base
    // branch); null while GitHub hasn't finished computing it.
    mergeable_state: string | null;
  } | null;
  // Pseudo-patch (git-style header prepended) ready for @pierre/diffs; null
  // when the file is binary/renamed/too large.
  files: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
  }[];
  more_files: number; // count beyond the render cap
  reviews: { state: string; body: string; author: string | null }[];
  comments: ApiCockpitComment[];
  demo: { url: string; caption: string | null } | null;
  // Public shareable "Proof of Build" page; null until a PR exists.
  certificate_url: string | null;
  criteria: {
    text: string;
    verdict: string | null;
    note: string | null;
    screenshot_url: string | null;
  }[];
  verification: ApiVerificationSummary | null;
  // Every generate/verify/fix run recorded for this feature, chronological.
  runs: ApiAgentRun[];
  // Coordinator-owned lifecycle history, including handoffs and stage retries.
  lifecycle_runs: ApiLifecycleRun[];
}

// The cockpit paints its controls, status, evidence, and conversations from
// the summary response. Large patch strings arrive independently so they do
// not block the first useful frame or get re-downloaded on every live update.
export interface ApiFeatureDiff {
  version: string | null;
  files: ApiFeatureDetail['files'];
  more_files: number;
}

// The Explain tab's document (src/domain/explain.ts owns the validating
// schema; these are the wire shapes it produces). A ref points into the Diff
// tab: a changed file and, optionally, a new-file line range.
export interface ExplanationRef {
  path: string;
  start?: number;
  end?: number;
}
export interface ExplanationSketchLine {
  text: string;
  change?: '+' | '-';
}
export type ExplanationSketchKind = 'call_tree' | 'pseudocode' | 'file_tree' | 'component_tree';
export interface ExplanationSummaryBlock {
  kind: 'summary';
  text: string;
}
export interface ExplanationSketchBlock {
  kind: ExplanationSketchKind;
  title: string;
  text: string;
  lines: ExplanationSketchLine[];
  refs: ExplanationRef[];
}
export interface ExplanationSequenceMessage {
  from: string;
  to: string;
  label: string;
  style: 'call' | 'reply' | 'error';
}
export interface ExplanationSequenceBlock {
  kind: 'sequence';
  title: string;
  text: string;
  participants: string[];
  messages: ExplanationSequenceMessage[];
  // Inclusive 0-based message indexes bracketed by the loop.
  loop?: { label: string; from: number; to: number };
  refs: ExplanationRef[];
}
export type ExplanationBlock =
  | ExplanationSummaryBlock
  | ExplanationSketchBlock
  | ExplanationSequenceBlock;
export interface ExplanationDocument {
  blocks: ExplanationBlock[];
}

// The Explain tab's document for one diff version.
// 'none' means no row exists for this head yet — the tab requests one.
export interface ApiFeatureExplanation {
  version: string | null;
  status: 'none' | 'running' | 'ready' | 'failed' | (string & {});
  document: ExplanationDocument | null;
  model: string | null;
  error: string | null;
  created_at: string | null;
  completed_at: string | null;
  // Newest finished document for an earlier head, shown (marked stale) while
  // the current head's explanation is running or absent; null when current
  // is ready.
  previous: { version: string; document: ExplanationDocument; completed_at: string } | null;
}

export interface ApiAgentSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  model: string;
  is_builtin: boolean;
}

// Agents are generic (one entry per slug, deduped across installations);
// writes fan out server-side so every installation stays in step.
export interface ApiAgentsList {
  github_app_slug: string;
  agents: ApiAgentSummary[];
}

export interface ApiModelOption {
  id: string;
  label: string;
}

// GET /api/models — the model catalog for both pickers. Runner ids are bare
// Anthropic ids; reviewer ids are gateway-prefixed (cloudflare/<provider>/<id>).
export interface ApiModels {
  runner: { options: ApiModelOption[]; default_model: string };
  reviewer: { options: ApiModelOption[]; default_model: string };
}

export interface ApiAgentDetail {
  agent: ApiAgentSummary & { instructions: string; installation_id: number };
  default_model: string;
}

export interface ApiSkillSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  // Import provenance: 'skills.sh' | 'github' | null for hand-written skills.
  source: string | null;
}

export interface ApiSkillsList {
  skills: ApiSkillSummary[];
}

export interface ApiSkillDetail {
  skill: ApiSkillSummary & {
    instructions: string;
    installation_id: number;
    source_ref: string | null;
    source_hash: string | null;
    imported_at: string | null;
    // Extra file paths only — the edit page never needs contents.
    files: { path: string }[];
  };
}

// GET /api/skills/catalog — the server-side skills.sh proxy. configured is
// false (with an empty list) when no SKILLS_SH_API_TOKEN secret is set.
export interface ApiSkillCatalogEntry {
  source: string; // "owner/repo"
  slug: string;
  name: string;
  description: string | null;
  installs: number | null;
}

export interface ApiSkillCatalog {
  configured: boolean;
  skills: ApiSkillCatalogEntry[];
  // Set when the configured skills.sh client failed (outage, bad token, rate
  // limit). Still a 200 so the browse page renders its GitHub-direct import
  // form instead of an error page.
  error?: string;
}

export interface ApiSkillAuditVerdict {
  auditor: string;
  verdict: string;
}

// POST /api/skills/import/preview — the mandatory look-before-import view.
export interface ApiSkillImportPreview {
  name: string;
  suggested_slug: string;
  slug_taken: boolean;
  description: string | null;
  instructions: string; // SKILL.md body, rendered client-side with <Markdown>
  files: { path: string }[];
  source: 'skills.sh' | 'github';
  source_ref: string; // "owner/repo/slug" or the GitHub folder URL
  hash: string | null;
  installs: number | null;
  audit: ApiSkillAuditVerdict[] | null; // null = no audit yet / unavailable
}

export interface ApiConnectionTest {
  ok: boolean;
  detail: string;
  tools: string[];
}

export interface ApiRepoSettings {
  id: number;
  owner: string;
  name: string;
  provider: string; // 'github' | 'artifacts'
  enabled: boolean;
  review_on_push: boolean;
  // Trailing window (minutes) a push waits before its re-review runs; a newer
  // push in the window supersedes it. 0 reviews immediately.
  review_push_debounce_minutes: number;
  review_intake: 'factory_only' | 'on_demand' | 'all_changes';
  process_profile: ApiProcessProfile;
  blocking_reviews: boolean;
  auto_fix: boolean;
  auto_merge: boolean;
  auto_resolve_conflicts: boolean;
  demo_videos: boolean;
  check_command: string | null;
  agents: { id: number; slug: string; name: string; enabled: boolean }[];
  skills: { id: number; slug: string; name: string; enabled: boolean }[];
}

export interface ApiSettings {
  github_app_slug: string;
  installations: {
    id: number;
    account_login: string;
    account_type: string; // 'Organization' | 'User' — only orgs get a Members page
    suspended: boolean;
    repos: ApiRepoSettings[];
  }[];
}

export interface ApiMe {
  // GitHub login when a GitHub account is connected, null for a password
  // account that hasn't linked one yet (name carries the display identity).
  login: string | null;
  name: string;
  github_connected: boolean;
  // Recovery-oriented account state. `github_connected` remains the stable
  // identity/link flag; this tells the UI which useful next action to show.
  github_status:
    | 'not_connected'
    | 'reauthorization_required'
    | 'temporarily_unavailable'
    | 'app_not_installed'
    | 'syncing'
    | 'ready';
  github_app_slug: string;
  vapid_public_key: string;
  installation_ids: number[];
}

// Native organization roles, scoped per
// installation rather than global — an ApiMe.role would be meaningless
// across installations, so the members page fetches role via ApiOrgMembers
// for the one installation it's showing.
export type ApiRole = 'owner' | 'admin' | 'member';

export interface ApiMember {
  id: string;
  login: string | null;
  email: string;
  role: ApiRole;
  joined_at: string;
}

export interface ApiInvitation {
  id: string;
  email: string;
  role: ApiRole;
  status: string;
  expires_at: string | null;
}

export interface ApiOrgMembers {
  org_id: string;
  members: ApiMember[];
  invitations: ApiInvitation[];
  my_role: ApiRole;
}

// A pending invitation as seen by its recipient on /accept-invite. Only the
// signed-in user whose email matches the invitation can read it.
export interface ApiInvitationPreview {
  id: string;
  email: string;
  role: ApiRole;
  org_name: string;
  // The GitHub installation behind the organization — the members page the
  // recipient lands on after accepting, if GitHub also lists them on it.
  installation_id: number | null;
  // "@login" for a GitHub inviter, their display name for a password
  // account, null when the inviter's account no longer exists.
  invited_by: string | null;
  expires_at: string | null;
}

export interface ApiInvitationAccepted {
  org_name: string;
  installation_id: number | null;
}

export interface ApiError {
  error: string;
}

export interface ApiTodo {
  id: number;
  installation_id: number;
  title: string;
  notes: string | null;
  created_at: string;
  repos: { id: number; owner: string; name: string }[];
}

// The kanban home: unstarted todos + started tasks (plans). Columns are
// derived client-side — done = feature_status 'merged', everything else
// started is in progress.
export interface ApiBoard {
  // Same pipeline-wide figure the usage page shows (renamed from
  // month_cost_usd, which was review-stage cost only and did not match /usage).
  stats: { month_pipeline_cost_usd: number; running: number };
  todos: ApiTodo[];
  tasks: ApiPlan[]; // non-archived
  installations: { id: number; account_login: string }[];
  repos: { id: number; owner: string; name: string; installation_id: number }[]; // factory-enabled
}

export interface ApiIntegration {
  id: number;
  installation_id: number;
  name: string;
  kind: string; // 'mcp' | 'api'
  url: string;
  tools: string[] | null;
  has_auth: boolean;
  auth_type: string; // 'none' | 'bearer' | 'api_key' | 'client_credentials' | 'oauth'
  oauth_status: 'not_connected' | 'connected' | 'expired' | 'needs_reauth' | null;
  repo_links: ApiRepoConnectionLink[]; // repos this MCP connection is attached to
}

// One repo attachment of an MCP connection, with its per-context mount
// toggles: reviews = hosted PR reviews, automations = sandbox automation runs.
export interface ApiRepoConnectionLink {
  repository_id: number;
  reviews: boolean;
  automations: boolean;
}

// A connection belongs to one installation and only attaches to that
// installation's own repos — the client filters on installation_id.
export interface ApiIntegrationRepo {
  id: number;
  installation_id: number;
  owner: string;
  name: string;
}

export interface ApiIntegrations {
  encryption_configured: boolean;
  installations: { id: number; account_login: string }[];
  repos: ApiIntegrationRepo[];
  connections: ApiIntegration[];
}

export interface ApiAutomationSummary {
  id: number;
  name: string;
  repository: { id: number; owner: string; name: string };
  schedule_kind: 'hourly' | 'daily' | 'weekly';
  time_of_day: string | null;
  day_of_week: number | null;
  enabled: boolean;
  next_run_at: string;
  last_run: { id: number; status: string; created_at: string } | null;
}

export interface ApiAutomationsList {
  automations: ApiAutomationSummary[];
  // Factory-enabled repos, for the new-automation repo picker — mirrors ApiBoard.repos.
  repos: { id: number; owner: string; name: string; installation_id: number }[];
}

export interface ApiAutomationDetail {
  automation: ApiAutomationSummary & { prompt: string };
}

export interface ApiAutomationRunSummary {
  id: number;
  status: 'running' | 'pr_opened' | 'no_changes' | 'checks_failed' | 'failed';
  pr_number: number | null;
  error: string | null;
  created_at: string;
}

export interface ApiAutomationRunsList {
  automation: { id: number; name: string };
  runs: ApiAutomationRunSummary[];
}

export interface ApiAutomationRunDetail {
  run: ApiAutomationRunSummary;
  automation: { id: number; name: string; repo: string };
  runs: ApiAgentRun[]; // reuse <AgentRunLog> as-is
}

// --- Artifacts-hosted projects (docs/artifacts-provider.md) ---

export interface ApiCreatedProject {
  ok: boolean;
  repository_id: number;
  repo: string; // "owner/name"
  default_branch: string | null;
  remote: string;
}

export interface ApiCloneCredential {
  remote: string;
  token: string;
  scope: 'read' | 'write';
  expiresAt: string;
}

// --- Repo code browser ---

export interface ApiRepoCode {
  repo: { id: number; owner: string; name: string; provider: string };
  supported: boolean; // always true today (both providers); kept for forward compat
  default_branch: string | null; // null only when the repo has no branches yet
  branches: string[];
}

export interface ApiTreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'symlink' | 'submodule';
  size: number | null; // null for dirs
  sha: string;
}

export interface ApiRepoTree {
  path: string;
  entries: ApiTreeEntry[]; // dirs first, then files, each name-sorted
}

export interface ApiRepoFile {
  path: string;
  ref: string;
  sha: string; // blob sha — the optimistic-concurrency token for saves
  size: number;
  text: string | null; // null when binary or too_large
  binary: boolean;
  too_large: boolean; // > 1 MB (both providers) — viewer shows a notice
  // Base64 blob bytes, set only for previewable binary types (see
  // shared/binary-preview.ts) under the 1 MB cap — null otherwise.
  content_base64: string | null;
}

export interface ApiFileSave {
  ok: boolean;
  content_sha: string; // new blob sha (feeds the next save's base_sha)
  commit_sha: string;
  branch: string; // branch the commit landed on
  pr: { number: number; url: string } | null; // set in 'pr' mode; null in commit mode (Artifacts repos are always commit mode)
}

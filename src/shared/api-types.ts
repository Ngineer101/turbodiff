// The JSON contract between the Worker's /api routes (src/routes/api.ts) and
// the SPA (src/client). Keep this file dependency-free: it is type-checked in
// both the worker and client TypeScript programs.

export type ReviewState = 'running' | 'completed' | 'stalled' | 'failed';

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
  review_url: string | null;
  total_tokens: number;
  cost_usd: number;
  duration_s: number | null;
  created_at: string; // D1 UTC 'YYYY-MM-DD HH:MM:SS'
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
    month_pipeline_cost_usd: number;
    month_tokens: number;
    avg_duration_s: number | null;
    avg_findings: number | null;
    running: number;
  };
  // Review-only cost by month — this table stays scoped to review-stage cost.
  months: { month: string; reviews: number; total_tokens: number; review_cost_usd: number }[];
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
  status: string; // running | passed | failed | error
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

export interface ApiFactoryLegacy_unused {
  repos: { id: number; owner: string; name: string }[]; // enabled repos, plan targets
  plans: ApiPlan[];
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

export interface ApiFeatureDetail {
  feature: {
    id: number;
    title: string;
    status: string;
    error: string | null;
    pr_number: number | null;
  };
  repo: string; // "owner/name"
  plan: string | null;
  // Null while generation hasn't opened a PR yet.
  pr: {
    state: 'open' | 'merged' | 'closed' | (string & {});
    html_url: string;
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

export interface ApiConnection {
  id: number;
  name: string;
  url: string;
  tools: string[] | null; // null = all tools
  has_auth: boolean;
}

export interface ApiAgentDetail {
  agent: ApiAgentSummary & { instructions: string; installation_id: number };
  connections: ApiConnection[];
  encryption_configured: boolean;
  default_model: string;
}

export interface ApiSkillSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
}

export interface ApiSkillsList {
  skills: ApiSkillSummary[];
}

export interface ApiSkillDetail {
  skill: ApiSkillSummary & { instructions: string; installation_id: number };
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
  enabled: boolean;
  review_on_push: boolean;
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
    suspended: boolean;
    repos: ApiRepoSettings[];
  }[];
}

export interface ApiMe {
  login: string;
  github_app_slug: string;
  vapid_public_key: string;
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
  stats: { month_cost_usd: number; running: number };
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
  agent_ids: number[]; // agents this MCP connection is attached to
}

export interface ApiIntegrations {
  encryption_configured: boolean;
  installations: { id: number; account_login: string }[];
  agents: ApiAgentSummary[];
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

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

// Usage page payload (the pre-board dashboard metrics).
export interface ApiUsage {
  month: string; // 'YYYY-MM'
  stats: {
    month_reviews: number;
    month_cost_usd: number;
    month_tokens: number;
    avg_duration_s: number | null;
    avg_findings: number | null;
    running: number;
  };
  months: { month: string; reviews: number; total_tokens: number; cost_usd: number }[];
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
  recent_reviews: ApiReview[];
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

export interface ApiPlan {
  id: number;
  title: string;
  repo: string; // "owner/name"
  status: PlanStatus | string;
  error: string | null;
  created_at: string;
  questions: string[];
  acceptance: string[];
  plan: string | null;
  feature_id: number | null;
  pr_number: number | null;
  // Lifecycle of the linked feature once the plan is approved: generating /
  // pr_opened / checks_failed / no_changes / failed (+ its error detail).
  feature_status: string | null;
  feature_error: string | null;
  archived: boolean;
  attachments: { name: string }[];
  verification: ApiVerificationSummary | null;
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
    state: 'open' | 'merged' | 'closed' | string;
    html_url: string;
    additions: number;
    deletions: number;
    changed_files: number;
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
  criteria: {
    text: string;
    verdict: string | null;
    note: string | null;
    screenshot_url: string | null;
  }[];
  verification: ApiVerificationSummary | null;
}

export interface ApiAgentSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  model: string;
  is_builtin: boolean;
}

export interface ApiAgentsList {
  github_app_slug: string;
  installations: {
    id: number;
    account_login: string;
    suspended: boolean;
    agents: ApiAgentSummary[];
  }[];
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
  demo_videos: boolean;
  check_command: string | null;
  agents: { id: number; slug: string; name: string; enabled: boolean }[];
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
  agent_ids: number[]; // agents this MCP connection is attached to
}

export interface ApiIntegrations {
  encryption_configured: boolean;
  installations: { id: number; account_login: string }[];
  agents: ApiAgentSummary[];
  connections: ApiIntegration[];
}

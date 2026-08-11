import { env } from 'cloudflare:workers';
import { openToken } from './crypto.ts';
import { BUILTIN_PERSONAS, DEFAULT_AGENT_SLUG, DEFAULT_MODEL } from './personas.ts';

// Thin typed layer over the D1 config store (schema in migrations/).

export interface InstallationRow {
  id: number;
  account_login: string;
  account_id: number;
  account_type: string;
  suspended: number;
}

export interface RepositoryRow {
  id: number;
  installation_id: number;
  owner: string;
  name: string;
  enabled: number;
  review_on_push: number; // re-dispatch tiered agents on pushes to open PRs
  blocking_reviews: number; // P1 → REQUEST_CHANGES, clean → APPROVE
  auto_fix: number; // dispatch the fix agent when a blocking review lands
  auto_merge: number; // merge factory PRs when verification + review are clean
  demo_videos: number; // record a verification demo video (runtime auto-detected)
  launchable: number | null; // cached detection: null unknown, 1 yes, 0 no
  check_command: string | null; // sandbox verification gate before factory pushes
  run_command: string | null; // how to launch the app for runtime verification
  app_port: number | null; // port the launched app listens on
  model: string | null;
  created_at: string; // when the repo was connected (mirrored into D1)
}

interface WebhookAccount {
  login: string;
  id: number;
  type: string;
}

interface WebhookRepo {
  id: number;
  name: string;
  full_name: string;
}

export async function upsertInstallation(id: number, account: WebhookAccount): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO installations (id, account_login, account_id, account_type, suspended)
		 VALUES (?1, ?2, ?3, ?4, 0)
		 ON CONFLICT(id) DO UPDATE SET account_login = ?2, account_id = ?3, account_type = ?4, suspended = 0`,
  )
    .bind(id, account.login, account.id, account.type)
    .run();
}

export async function deleteInstallation(id: number): Promise<void> {
  // D1 doesn't enforce foreign keys by default, so cascade by hand.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM repositories WHERE installation_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM installations WHERE id = ?1').bind(id),
  ]);
}

export async function setInstallationSuspended(id: number, suspended: boolean): Promise<void> {
  await env.DB.prepare('UPDATE installations SET suspended = ?2 WHERE id = ?1')
    .bind(id, suspended ? 1 : 0)
    .run();
}

export async function addRepositories(installationId: number, repos: WebhookRepo[]): Promise<void> {
  if (repos.length === 0) return;
  await env.DB.batch(
    repos.map((r) => {
      const [owner, name] = r.full_name.split('/');
      return env.DB.prepare(
        `INSERT INTO repositories (id, installation_id, owner, name)
				 VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(id) DO UPDATE SET installation_id = ?2, owner = ?3, name = ?4`,
      ).bind(r.id, installationId, owner, name);
    }),
  );
}

export async function listRepositoryIdsForInstallation(installationId: number): Promise<number[]> {
  const rows = await env.DB.prepare('SELECT id FROM repositories WHERE installation_id = ?1')
    .bind(installationId)
    .all<{ id: number }>();
  return rows.results.map((r) => r.id);
}

export async function removeRepositories(repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return;
  await env.DB.batch(
    repoIds.map((id) => env.DB.prepare('DELETE FROM repositories WHERE id = ?1').bind(id)),
  );
}

export async function getRepoByFullName(
  owner: string,
  name: string,
): Promise<RepositoryRow | null> {
  return env.DB.prepare('SELECT * FROM repositories WHERE owner = ?1 AND name = ?2')
    .bind(owner, name)
    .first<RepositoryRow>();
}

export async function getInstallation(id: number): Promise<InstallationRow | null> {
  return env.DB.prepare('SELECT * FROM installations WHERE id = ?1')
    .bind(id)
    .first<InstallationRow>();
}

export async function listInstallationsWithRepos(
  installationIds: number[],
): Promise<{ installation: InstallationRow; repos: RepositoryRow[] }[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const [installations, repos] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM installations WHERE id IN (${placeholders}) ORDER BY account_login`,
    )
      .bind(...installationIds)
      .all<InstallationRow>(),
    env.DB.prepare(
      `SELECT * FROM repositories WHERE installation_id IN (${placeholders}) ORDER BY owner, name`,
    )
      .bind(...installationIds)
      .all<RepositoryRow>(),
  ]);
  return installations.results.map((installation) => ({
    installation,
    repos: repos.results.filter((r) => r.installation_id === installation.id),
  }));
}

export async function getRepoById(id: number): Promise<RepositoryRow | null> {
  return env.DB.prepare('SELECT * FROM repositories WHERE id = ?1').bind(id).first<RepositoryRow>();
}

export async function setRepoEnabled(id: number, enabled: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET enabled = ?2 WHERE id = ?1')
    .bind(id, enabled ? 1 : 0)
    .run();
}

export async function setRepoReviewOnPush(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET review_on_push = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

export async function setRepoBlockingReviews(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET blocking_reviews = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

export async function setRepoAutoFix(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET auto_fix = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

export async function setRepoAutoMerge(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET auto_merge = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

// The sandbox verification gate for factory pushes. Empty string clears it.
export async function setRepoLaunchable(id: number, launchable: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET launchable = ?2 WHERE id = ?1')
    .bind(id, launchable ? 1 : 0)
    .run();
}

export async function setRepoDemoVideos(id: number, on: boolean): Promise<void> {
  await env.DB.prepare('UPDATE repositories SET demo_videos = ?2 WHERE id = ?1')
    .bind(id, on ? 1 : 0)
    .run();
}

export async function setRepoCheckCommand(id: number, command: string): Promise<void> {
  const trimmed = command.trim();
  await env.DB.prepare('UPDATE repositories SET check_command = ?2 WHERE id = ?1')
    .bind(id, trimmed || null)
    .run();
}

// How the verify step launches the repo's app for runtime/visual checks.
// Empty command clears both fields (static verification only).
export async function setRepoRunCommand(
  id: number,
  command: string,
  port: number | null,
): Promise<void> {
  const trimmed = command.trim();
  await env.DB.prepare('UPDATE repositories SET run_command = ?2, app_port = ?3 WHERE id = ?1')
    .bind(id, trimmed || null, trimmed ? port : null)
    .run();
}

// --- verifications (Phase 4: empirical acceptance-criteria checks) ---

export interface VerificationRow {
  id: number;
  feature_id: number;
  status: string;
  results: string | null;
  summary: string | null;
  demo: string | null; // JSON {"video": r2Key, "caption": string}
  error: string | null;
  created_at: string;
}

export interface CockpitCommentRow {
  id: number;
  feature_id: number;
  path: string;
  line: number;
  side: string;
  body: string;
  author: string;
  author_id: number | null; // null on rows predating attribution
  status: string;
  created_at: string;
}

export async function createCockpitComment(
  featureId: number,
  path: string,
  line: number,
  side: string,
  body: string,
  author: string,
  // GitHub user id completing the commenter's noreply identity, so the fix
  // commit this comment dispatches can carry them as git author.
  authorId?: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO cockpit_comments (feature_id, path, line, side, body, author, author_id)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
  )
    .bind(featureId, path, line, side, body, author, authorId ?? null)
    .first<{ id: number }>();
  return row!.id;
}

export async function markCockpitCommentDispatched(id: number): Promise<void> {
  await env.DB.prepare("UPDATE cockpit_comments SET status = 'dispatched' WHERE id = ?1")
    .bind(id)
    .run();
}

export async function listCockpitComments(featureId: number): Promise<CockpitCommentRow[]> {
  const res = await env.DB.prepare(
    'SELECT * FROM cockpit_comments WHERE feature_id = ?1 ORDER BY id',
  )
    .bind(featureId)
    .all<CockpitCommentRow>();
  return res.results;
}

// --- multi-repo task/plan repo lists (migration 0024) ---

// Replaces a todo's repo list wholesale (delete-then-insert), so repeated
// calls with a different array simply replace the prior selection.
export async function setTodoRepositories(todoId: number, repositoryIds: number[]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM todo_repositories WHERE todo_id = ?1').bind(todoId),
    ...repositoryIds.map((repoId, i) =>
      env.DB.prepare(
        'INSERT INTO todo_repositories (todo_id, repository_id, position) VALUES (?1, ?2, ?3)',
      ).bind(todoId, repoId, i),
    ),
  ]);
}

export async function listReposForTodo(todoId: number): Promise<RepositoryRow[]> {
  const res = await env.DB.prepare(
    `SELECT r.* FROM todo_repositories tr
		 JOIN repositories r ON r.id = tr.repository_id
		 WHERE tr.todo_id = ?1
		 ORDER BY tr.position`,
  )
    .bind(todoId)
    .all<RepositoryRow>();
  return res.results;
}

export interface TodoRepoRow {
  todo_id: number;
  repository_id: number;
  owner: string;
  name: string;
}

// Batched repo lists for the board's todo cards — one query for every todo
// instead of one per row.
export async function todoRepositoriesForTodos(todoIds: number[]): Promise<TodoRepoRow[]> {
  if (todoIds.length === 0) return [];
  const placeholders = todoIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT tr.todo_id, tr.repository_id, r.owner, r.name
		 FROM todo_repositories tr
		 JOIN repositories r ON r.id = tr.repository_id
		 WHERE tr.todo_id IN (${placeholders})
		 ORDER BY tr.todo_id, tr.position`,
  )
    .bind(...todoIds)
    .all<TodoRepoRow>();
  return res.results;
}

export async function listReposForPlan(planId: number): Promise<RepositoryRow[]> {
  const res = await env.DB.prepare(
    `SELECT r.* FROM plan_repositories pr
		 JOIN repositories r ON r.id = pr.repository_id
		 WHERE pr.plan_id = ?1
		 ORDER BY pr.position`,
  )
    .bind(planId)
    .all<RepositoryRow>();
  return res.results;
}

export interface TaskRepoStatusRow {
  plan_id: number;
  repository_id: number;
  owner: string;
  name: string;
  feature_id: number | null;
  feature_status: string | null;
  feature_error: string | null;
  pr_number: number | null;
  verification_status: string | null;
  verification_results: string | null;
}

// One row per repo attached to each of the given plans — the board/task
// routes' per-repo status array. Independent of listPlansForInstallations /
// getPlanWithRepoById, which stay keyed to the primary repo only.
export async function getTaskRepoStatuses(planIds: number[]): Promise<TaskRepoStatusRow[]> {
  if (planIds.length === 0) return [];
  const placeholders = planIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT pr.plan_id, pr.repository_id, r.owner, r.name,
		        f.id AS feature_id, f.status AS feature_status, f.error AS feature_error,
		        f.pr_number AS pr_number,
		        v.status AS verification_status, v.results AS verification_results
		 FROM plan_repositories pr
		 JOIN repositories r ON r.id = pr.repository_id
		 LEFT JOIN features f ON f.plan_id = pr.plan_id AND f.repository_id = pr.repository_id
		 LEFT JOIN verifications v ON v.id = (SELECT MAX(id) FROM verifications WHERE feature_id = f.id)
		 WHERE pr.plan_id IN (${placeholders})
		 ORDER BY pr.plan_id, pr.position`,
  )
    .bind(...planIds)
    .all<TaskRepoStatusRow>();
  return res.results;
}

// The feature a factory PR belongs to (null for human-authored PRs).
export async function getFeatureByRepoPr(
  repositoryId: number,
  prNumber: number,
): Promise<FeatureRow | null> {
  return env.DB.prepare(
    'SELECT * FROM features WHERE repository_id = ?1 AND pr_number = ?2 ORDER BY id DESC LIMIT 1',
  )
    .bind(repositoryId, prNumber)
    .first<FeatureRow>();
}

export async function latestVerificationForFeature(
  featureId: number,
): Promise<VerificationRow | null> {
  return env.DB.prepare(
    'SELECT * FROM verifications WHERE feature_id = ?1 ORDER BY id DESC LIMIT 1',
  )
    .bind(featureId)
    .first<VerificationRow>();
}

// Verification runs killed mid-flight (isolate death) never reach their
// error handler, stranding rows in 'running' and the UI in an endless poll.
// Lazy sweep from the read paths, like failStrandedGeneration.
const VERIFICATION_STRAND_MINUTES = 45;

export async function failStrandedVerifications(): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE verifications SET status = 'error',
		   error = 'verification run was killed before finishing — re-run it from the PR or wait for the next push'
		 WHERE status = 'running'
		   AND created_at < datetime('now', '-${VERIFICATION_STRAND_MINUTES} minutes')`,
  ).run();
  return res.meta.changes ?? 0;
}

export async function createVerification(featureId: number): Promise<number> {
  const row = await env.DB.prepare(
    'INSERT INTO verifications (feature_id) VALUES (?1) RETURNING id',
  )
    .bind(featureId)
    .first<{ id: number }>();
  return row!.id;
}

export async function finishVerification(
  id: number,
  status: string,
  fields: { results?: string; summary?: string; error?: string; demo?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    'UPDATE verifications SET status = ?2, results = ?3, summary = ?4, error = ?5, demo = ?6 WHERE id = ?1',
  )
    .bind(
      id,
      status,
      fields.results ?? null,
      fields.summary ?? null,
      fields.error ?? null,
      fields.demo ?? null,
    )
    .run();
}

// The plan a factory feature came from (null for direct /internal/generate).
// Every plan-originated feature sets features.plan_id at creation, so this
// resolves correctly for every repo's feature in a multi-repo task — not
// just the primary repo's via the legacy plans.feature_id pointer.
export async function getPlanByFeatureId(featureId: number): Promise<PlanRow | null> {
  return env.DB.prepare(
    `SELECT p.* FROM plans p JOIN features f ON f.plan_id = p.id WHERE f.id = ?1`,
  )
    .bind(featureId)
    .first<PlanRow>();
}

// --- fix attempts (auto-fix loop bookkeeping + iteration cap) ---

// Every attempt counts toward the cap regardless of outcome, so even a
// persistently failing fixer terminates after the cap.
export async function countFixAttempts(repositoryId: number, prNumber: number): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM fix_attempts WHERE repository_id = ?1 AND pr_number = ?2',
  )
    .bind(repositoryId, prNumber)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Records an attempt only while under the cap, in a single statement so two
// concurrent consumers can't both slip past the count check. Returns null when
// the cap is reached. Sweeps zombie rows first: a consumer killed at the
// platform's wall clock never finishes its row, so old 'running' rows are
// closed as failed rather than lying on the dashboard forever.
export async function tryRecordFixAttempt(
  repositoryId: number,
  prNumber: number,
  trigger: string,
  cap: number,
): Promise<number | null> {
  await env.DB.prepare(
    `UPDATE fix_attempts SET status = 'failed', error = 'stale: consumer killed before completion'
		 WHERE repository_id = ?1 AND pr_number = ?2 AND status = 'running'
		 AND created_at < datetime('now', '-20 minutes')`,
  )
    .bind(repositoryId, prNumber)
    .run();
  const row = await env.DB.prepare(
    `INSERT INTO fix_attempts (repository_id, pr_number, "trigger")
		 SELECT ?1, ?2, ?3
		 WHERE (SELECT COUNT(*) FROM fix_attempts WHERE repository_id = ?1 AND pr_number = ?2) < ?4
		 RETURNING id`,
  )
    .bind(repositoryId, prNumber, trigger, cap)
    .first<{ id: number }>();
  return row?.id ?? null;
}

// --- features (Phase 2: spec → generated branch + PR) ---

export interface FeatureRow {
  id: number;
  repository_id: number;
  title: string;
  spec: string;
  acceptance: string | null; // JSON array of acceptance criteria strings
  branch: string | null;
  pr_number: number | null;
  status: string;
  error: string | null;
  created_at: string;
  run_started_at: string | null; // start of the current generation attempt
  tier: string | null; // trivial | standard; scales the agent budget
  author_login: string | null; // instructing user (plan approver); null = bot
  author_id: number | null;
  coauthor_login: string | null; // plan creator when different from author
  coauthor_id: number | null;
}

export async function createFeature(
  repositoryId: number,
  title: string,
  spec: string,
  // JSON array of acceptance criteria strings; the verify step checks these
  // empirically against the generated branch.
  acceptance?: string,
  // Commit attribution (src/lib/attribution.ts): author = the instructing
  // user (plan approver), coauthor = the plan creator when they differ.
  // Null for operator/API intakes — the generator commits as the bot.
  author?: { login: string; id: number },
  coauthor?: { login: string; id: number },
  // trivial | standard — scales the generation agent's budget and prompt.
  tier?: string,
  // The plan this feature was approved from, when any (null for direct
  // /internal/generate intakes).
  planId?: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO features
     (repository_id, title, spec, acceptance, author_login, author_id, coauthor_login, coauthor_id, tier, plan_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`,
  )
    .bind(
      repositoryId,
      title,
      spec,
      acceptance ?? null,
      author?.login ?? null,
      author?.id ?? null,
      coauthor?.login ?? null,
      coauthor?.id ?? null,
      tier ?? null,
      planId ?? null,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function getFeature(id: number): Promise<FeatureRow | null> {
  return env.DB.prepare('SELECT * FROM features WHERE id = ?1').bind(id).first<FeatureRow>();
}

// Generation runs as a durable Workflow whose steps heartbeat run_started_at,
// so a stranded 'generating' row should be near-impossible — this lazy sweep
// (called from the factory read paths) is the last-resort backstop for an
// engine-level failure. The threshold must exceed the longest heartbeat gap
// (the 25-minute agent step) plus retry delays. Legacy rows without
// run_started_at fall back to created_at.
const GENERATION_STRAND_MINUTES = 45;

export async function failStrandedGeneration(): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE features SET status = 'failed',
		   error = 'generation run was killed before finishing (platform wall clock or runtime interruption) — retry'
		 WHERE status = 'generating'
		   AND COALESCE(run_started_at, created_at) < datetime('now', '-${GENERATION_STRAND_MINUTES} minutes')`,
  ).run();
  return res.meta.changes ?? 0;
}

export async function updateFeature(
  id: number,
  fields: {
    status?: string;
    branch?: string;
    prNumber?: number;
    error?: string;
    // 'now' stamps the start of a generation attempt (strand detection).
    runStartedAt?: 'now';
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE features SET
		 status = COALESCE(?2, status),
		 branch = COALESCE(?3, branch),
		 pr_number = COALESCE(?4, pr_number),
		 error = COALESCE(?5, error),
		 run_started_at = CASE WHEN ?6 THEN datetime('now') ELSE run_started_at END
		 WHERE id = ?1`,
  )
    .bind(
      id,
      fields.status ?? null,
      fields.branch ?? null,
      fields.prNumber ?? null,
      fields.error ?? null,
      fields.runStartedAt === 'now' ? 1 : 0,
    )
    .run();
}

// --- plans (Phase 3: requirements → questions → plan → approve → feature) ---

export interface PlanRow {
  id: number;
  repository_id: number;
  title: string;
  requirements: string;
  analysis: string | null;
  questions: string | null; // JSON array of strings
  answers: string | null; // JSON array of strings
  plan: string | null;
  acceptance: string | null; // JSON array of strings
  feature_id: number | null;
  status: string;
  error: string | null;
  created_at: string;
  created_by_login: string | null; // signed-in submitter; null = operator/API
  created_by_id: number | null;
  tier: string | null; // trivial | standard; null = pre-tiering (standard)
  archived: number; // started tasks are never deleted, only hidden
  feedback: string | null; // JSON [{snippet, comment}] awaiting a revise run
  attachments: string | null; // JSON [{key, name, content_type}] in R2
}

// repositoryIds[0] becomes plans.repository_id (the "primary" repo — every
// existing single-repo read path keeps working unchanged); the full ordered
// list is snapshotted into plan_repositories for the multi-repo fan-out at
// approval.
export async function createPlan(
  repositoryIds: number[],
  title: string,
  requirements: string,
  // The signed-in user who submitted the requirements; null for operator/API
  // intakes. Carried onto the feature at approval for commit attribution.
  createdBy?: { login: string; id: number },
  // JSON [{key, name, content_type}] of user-uploaded context files.
  attachments?: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO plans (repository_id, title, requirements, created_by_login, created_by_id, attachments)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
  )
    .bind(
      repositoryIds[0],
      title,
      requirements,
      createdBy?.login ?? null,
      createdBy?.id ?? null,
      attachments ?? null,
    )
    .first<{ id: number }>();
  const planId = row!.id;
  await env.DB.batch(
    repositoryIds.map((repoId, i) =>
      env.DB.prepare(
        'INSERT INTO plan_repositories (plan_id, repository_id, position) VALUES (?1, ?2, ?3)',
      ).bind(planId, repoId, i),
    ),
  );
  return planId;
}

export async function getPlan(id: number): Promise<PlanRow | null> {
  return env.DB.prepare('SELECT * FROM plans WHERE id = ?1').bind(id).first<PlanRow>();
}

export interface PlanWithRepo extends PlanRow {
  owner: string;
  name: string;
  installation_id: number;
  pr_number: number | null; // from the linked feature, if generation started
  feature_status: string | null; // the linked feature's lifecycle status
  feature_error: string | null; // its failure detail, when generation failed
  verification_status: string | null; // latest verification for the feature
  verification_results: string | null; // its per-criterion results JSON
  verification_demo: string | null; // its demo JSON {"video": r2Key}
}

// Plans across the given installations, newest first, with repo + generated-PR
// context for the dashboard.
export async function listPlansForInstallations(
  installationIds: number[],
  limit = 50,
): Promise<PlanWithRepo[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 2}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT p.*, r.owner, r.name, r.installation_id, f.pr_number AS pr_number,
		        f.status AS feature_status, f.error AS feature_error,
		        v.status AS verification_status, v.results AS verification_results,
		        v.demo AS verification_demo
		 FROM plans p
		 JOIN repositories r ON r.id = p.repository_id
		 LEFT JOIN features f ON f.id = p.feature_id
		 LEFT JOIN verifications v ON v.id =
		   (SELECT MAX(id) FROM verifications WHERE feature_id = p.feature_id)
		 WHERE r.installation_id IN (${placeholders})
		 ORDER BY p.id DESC
		 LIMIT ?1`,
  )
    .bind(limit, ...installationIds)
    .all<PlanWithRepo>();
  return res.results;
}

// One plan with the same repo/feature/verification context as the list query
// (the board's task-detail view).
export async function getPlanWithRepoById(id: number): Promise<PlanWithRepo | null> {
  return env.DB.prepare(
    `SELECT p.*, r.owner, r.name, r.installation_id, f.pr_number AS pr_number,
		        f.status AS feature_status, f.error AS feature_error,
		        v.status AS verification_status, v.results AS verification_results,
		        v.demo AS verification_demo
		 FROM plans p
		 JOIN repositories r ON r.id = p.repository_id
		 LEFT JOIN features f ON f.id = p.feature_id
		 LEFT JOIN verifications v ON v.id =
		   (SELECT MAX(id) FROM verifications WHERE feature_id = p.feature_id)
		 WHERE p.id = ?1`,
  )
    .bind(id)
    .first<PlanWithRepo>();
}

export async function updatePlan(
  id: number,
  fields: {
    status?: string;
    analysis?: string;
    questions?: string;
    answers?: string;
    plan?: string;
    acceptance?: string;
    featureId?: number;
    error?: string;
    tier?: string;
    feedback?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE plans SET
		 status = COALESCE(?2, status),
		 analysis = COALESCE(?3, analysis),
		 questions = COALESCE(?4, questions),
		 answers = COALESCE(?5, answers),
		 plan = COALESCE(?6, plan),
		 acceptance = COALESCE(?7, acceptance),
		 feature_id = COALESCE(?8, feature_id),
		 error = COALESCE(?9, error),
		 tier = COALESCE(?10, tier),
		 feedback = COALESCE(?11, feedback)
		 WHERE id = ?1`,
  )
    .bind(
      id,
      fields.status ?? null,
      fields.analysis ?? null,
      fields.questions ?? null,
      fields.answers ?? null,
      fields.plan ?? null,
      fields.acceptance ?? null,
      fields.featureId ?? null,
      fields.error ?? null,
      fields.tier ?? null,
      fields.feedback ?? null,
    )
    .run();
}

export async function finishFixAttempt(
  id: number,
  status: string,
  commitSha?: string,
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE fix_attempts SET status = ?2, commit_sha = ?3, error = ?4 WHERE id = ?1',
  )
    .bind(id, status, commitSha ?? null, error ?? null)
    .run();
}

export async function recordReview(
  repositoryId: number,
  installationId: number,
  prNumber: number,
  trigger: string,
  agentSlug: string,
  agentInstanceId: string,
  riskTier: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO reviews (repository_id, installation_id, pr_number, trigger_event, status, agent_slug, agent_instance_id, risk_tier)
		 VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7)`,
  )
    .bind(repositoryId, installationId, prNumber, trigger, agentSlug, agentInstanceId, riskTier)
    .run();
}

// Called by the post_review tool once the agent has published to GitHub.
// Keyed by the exact agent instance so concurrent agents reviewing the same
// PR can never complete each other's rows.
export async function completeReview(
  agentInstanceId: string,
  reviewUrl: string | null,
  findingsCount: number | null = null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE reviews
		 SET status = 'completed', completed_at = datetime('now'), review_url = ?2, findings_count = ?3
		 WHERE id = (
			SELECT id FROM reviews
			WHERE agent_instance_id = ?1 AND status = 'running'
			ORDER BY id DESC LIMIT 1
		 )`,
  )
    .bind(agentInstanceId, reviewUrl, findingsCount)
    .run();
}

// Accumulates one model turn's usage onto the latest review row for an agent
// instance. Fired from the observe() metering subscriber.
export async function addReviewUsage(
  agentInstanceId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    model: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE reviews SET
			input_tokens = input_tokens + ?2,
			output_tokens = output_tokens + ?3,
			cache_read_tokens = cache_read_tokens + ?4,
			cache_write_tokens = cache_write_tokens + ?5,
			cost_usd = cost_usd + ?6,
			model = ?7
		 WHERE id = (
			SELECT id FROM reviews WHERE agent_instance_id = ?1
			ORDER BY id DESC LIMIT 1
		 )`,
  )
    .bind(
      agentInstanceId,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.costUsd,
      usage.model,
    )
    .run();
}

// --- Custom agents (migration 0004; design in docs/custom-agents-design.md) ---

export interface AgentRow {
  id: number;
  installation_id: number;
  slug: string;
  name: string;
  description: string | null;
  instructions: string;
  model: string;
  is_builtin: number;
  created_at: string;
}

// Lazily seeds the built-in personas for an installation. Idempotent: the
// UNIQUE(installation_id, slug) constraint makes re-runs no-ops, and users'
// edits to seeded rows are never overwritten.
export async function ensureBuiltinAgents(installationId: number): Promise<void> {
  await env.DB.batch(
    BUILTIN_PERSONAS.map((p) =>
      env.DB.prepare(
        `INSERT INTO agents (installation_id, slug, name, description, instructions, model, is_builtin)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
				 ON CONFLICT(installation_id, slug) DO NOTHING`,
      ).bind(installationId, p.slug, p.name, p.description, p.instructions, DEFAULT_MODEL),
    ),
  );
}

export async function listAgents(installationIds: number[]): Promise<AgentRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT * FROM agents WHERE installation_id IN (${placeholders})
		 ORDER BY is_builtin DESC, name`,
  )
    .bind(...installationIds)
    .all<AgentRow>();
  return res.results;
}

export async function getAgentById(id: number): Promise<AgentRow | null> {
  return env.DB.prepare('SELECT * FROM agents WHERE id = ?1').bind(id).first<AgentRow>();
}

export async function getAgentBySlug(
  installationId: number,
  slug: string,
): Promise<AgentRow | null> {
  return env.DB.prepare('SELECT * FROM agents WHERE installation_id = ?1 AND slug = ?2')
    .bind(installationId, slug)
    .first<AgentRow>();
}

export async function createAgent(
  installationId: number,
  fields: { slug: string; name: string; description: string; instructions: string; model: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agents (installation_id, slug, name, description, instructions, model, is_builtin)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)`,
  )
    .bind(
      installationId,
      fields.slug,
      fields.name,
      fields.description,
      fields.instructions,
      fields.model,
    )
    .run();
}

export async function updateAgent(
  id: number,
  fields: { name: string; description: string; instructions: string; model: string },
): Promise<void> {
  await env.DB.prepare(
    'UPDATE agents SET name = ?2, description = ?3, instructions = ?4, model = ?5 WHERE id = ?1',
  )
    .bind(id, fields.name, fields.description, fields.instructions, fields.model)
    .run();
}

// Custom agents only — built-ins are permanent (they re-seed anyway).
export async function deleteAgent(id: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM repo_agents WHERE agent_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM agent_connections WHERE agent_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM agents WHERE id = ?1 AND is_builtin = 0').bind(id),
  ]);
}

// Enablement semantics: an explicit repo_agents row wins; with no row, the
// built-in 'review' agent defaults on (preserving single-agent behavior) and
// everything else defaults off.
export function resolveAgentEnabled(agent: AgentRow, override: number | null | undefined): boolean {
  if (override !== null && override !== undefined) return override === 1;
  return agent.is_builtin === 1 && agent.slug === DEFAULT_AGENT_SLUG;
}

export interface RepoAgentOverride {
  repository_id: number;
  agent_id: number;
  enabled: number;
}

// All explicit repo × agent overrides for these installations, for UIs that
// render many repos at once without a per-repo query.
export async function listRepoAgentOverrides(
  installationIds: number[],
): Promise<RepoAgentOverride[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT ra.repository_id, ra.agent_id, ra.enabled
		 FROM repo_agents ra
		 JOIN repositories r ON r.id = ra.repository_id
		 WHERE r.installation_id IN (${placeholders})`,
  )
    .bind(...installationIds)
    .all<RepoAgentOverride>();
  return res.results;
}

export interface RepoAgentRow extends AgentRow {
  repo_enabled: number | null; // raw repo_agents.enabled; null = no row
  enabled: boolean; // resolved per agentEnabledForRepo
}

export async function listAgentsForRepo(repo: RepositoryRow): Promise<RepoAgentRow[]> {
  await ensureBuiltinAgents(repo.installation_id);
  const res = await env.DB.prepare(
    `SELECT a.*, ra.enabled AS repo_enabled
		 FROM agents a
		 LEFT JOIN repo_agents ra ON ra.agent_id = a.id AND ra.repository_id = ?2
		 WHERE a.installation_id = ?1
		 ORDER BY a.is_builtin DESC, a.name`,
  )
    .bind(repo.installation_id, repo.id)
    .all<AgentRow & { repo_enabled: number | null }>();
  return res.results.map((a) => ({ ...a, enabled: resolveAgentEnabled(a, a.repo_enabled) }));
}

export async function setRepoAgentEnabled(
  repositoryId: number,
  agentId: number,
  enabled: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repo_agents (repository_id, agent_id, enabled) VALUES (?1, ?2, ?3)
		 ON CONFLICT(repository_id, agent_id) DO UPDATE SET enabled = ?3`,
  )
    .bind(repositoryId, agentId, enabled ? 1 : 0)
    .run();
}

// --- External MCP tool connections per agent (migration 0005) ---

// Installation-level integrations registry (kanban-era model): connections
// are added once per installation on the integrations page; MCP-kind
// connections are attached to agents via agent_connection_links.
export interface ConnectionRow {
  id: number;
  installation_id: number;
  name: string;
  kind: string; // 'mcp' (agent-mountable) | 'api' (stored bearer integration)
  url: string;
  tool_allowlist: string | null; // JSON string array; null = all tools
  auth_ciphertext: string | null;
  optional: number;
  created_at: string;
}

// The non-secret snapshot that rides the review.request signal so the agent
// render can mount connections. The bearer token never leaves D1: the auth
// resolver fetches and decrypts it by connection id at request time.
export interface ConnectionSnapshot {
  id: number;
  name: string;
  url: string;
  tools?: string[];
  hasAuth: boolean;
  optional: boolean;
}

export function connectionSnapshot(row: ConnectionRow): ConnectionSnapshot {
  let tools: string[] | undefined;
  if (row.tool_allowlist) {
    try {
      const parsed = JSON.parse(row.tool_allowlist);
      if (Array.isArray(parsed) && parsed.length > 0) tools = parsed.map(String);
    } catch {
      // Malformed allowlist behaves as "all tools" rather than failing runs.
    }
  }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    ...(tools ? { tools } : {}),
    hasAuth: row.auth_ciphertext !== null,
    optional: row.optional === 1,
  };
}

// MCP connections attached to one agent, via the registry links.
export async function listAgentConnections(agentId: number): Promise<ConnectionRow[]> {
  const res = await env.DB.prepare(
    `SELECT c.* FROM connections c
		 JOIN agent_connection_links l ON l.connection_id = c.id
		 WHERE l.agent_id = ?1 AND c.kind = 'mcp'
		 ORDER BY c.name`,
  )
    .bind(agentId)
    .all<ConnectionRow>();
  return res.results;
}

export async function listConnections(installationIds: number[]): Promise<ConnectionRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT * FROM connections WHERE installation_id IN (${placeholders}) ORDER BY name`,
  )
    .bind(...installationIds)
    .all<ConnectionRow>();
  return res.results;
}

export async function getConnection(id: number): Promise<ConnectionRow | null> {
  return env.DB.prepare('SELECT * FROM connections WHERE id = ?1').bind(id).first<ConnectionRow>();
}

export async function createConnection(fields: {
  installationId: number;
  name: string;
  kind: string;
  url: string;
  toolAllowlist: string[] | null;
  authCiphertext: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO connections (installation_id, name, kind, url, tool_allowlist, auth_ciphertext, optional)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)`,
  )
    .bind(
      fields.installationId,
      fields.name,
      fields.kind,
      fields.url,
      fields.toolAllowlist ? JSON.stringify(fields.toolAllowlist) : null,
      fields.authCiphertext,
    )
    .run();
}

export async function deleteConnection(id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM agent_connection_links WHERE connection_id = ?1')
    .bind(id)
    .run();
  await env.DB.prepare('DELETE FROM connections WHERE id = ?1').bind(id).run();
}

export interface AgentConnectionLink {
  agent_id: number;
  connection_id: number;
}

export async function listConnectionLinks(
  installationIds: number[],
): Promise<AgentConnectionLink[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT l.agent_id, l.connection_id FROM agent_connection_links l
		 JOIN connections c ON c.id = l.connection_id
		 WHERE c.installation_id IN (${placeholders})`,
  )
    .bind(...installationIds)
    .all<AgentConnectionLink>();
  return res.results;
}

export async function setAgentConnectionLink(
  agentId: number,
  connectionId: number,
  attached: boolean,
): Promise<void> {
  if (attached) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO agent_connection_links (agent_id, connection_id) VALUES (?1, ?2)',
    )
      .bind(agentId, connectionId)
      .run();
  } else {
    await env.DB.prepare(
      'DELETE FROM agent_connection_links WHERE agent_id = ?1 AND connection_id = ?2',
    )
      .bind(agentId, connectionId)
      .run();
  }
}

// The MCP auth resolver: called by the Flue transport on every request to an
// authenticated server. Fetches and unseals the token on demand — it never
// lands in the conversation, the signal, or the UI.
export async function getConnectionAuthToken(connectionId: number): Promise<string> {
  const row = await getConnection(connectionId);
  if (!row?.auth_ciphertext) {
    throw new Error(`turbodiff: connection ${connectionId} has no stored token`);
  }
  return openToken(row.auth_ciphertext);
}

export interface AgentUsageRow {
  agent_slug: string | null;
  reviews: number;
  cost_usd: number;
}

// Cost per agent for one 'YYYY-MM' month, costliest first. NULL slug groups
// reviews recorded before multi-agent support.
export async function agentUsageForMonth(
  installationIds: number[],
  month: string,
): Promise<AgentUsageRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT agent_slug, COUNT(*) AS reviews, SUM(cost_usd) AS cost_usd
		 FROM reviews
		 WHERE installation_id IN (${placeholders})
			AND strftime('%Y-%m', created_at) = ?${installationIds.length + 1}
		 GROUP BY agent_slug
		 ORDER BY cost_usd DESC`,
  )
    .bind(...installationIds, month)
    .all<AgentUsageRow>();
  return res.results;
}

export interface ReviewActivityRow {
  id: number;
  repository_id: number;
  installation_id: number;
  pr_number: number;
  trigger_event: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  review_url: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  model: string | null;
  agent_slug: string | null; // null on rows predating multi-agent support
  agent_instance_id: string | null;
  risk_tier: string | null; // null before tiering, and on mention/manual dispatch
  findings_count: number | null; // null until post_review completes the row
  repo_owner: string | null; // null if the repo was since removed
  repo_name: string | null;
}

export async function listRecentReviews(
  installationIds: number[],
  limit = 50,
  offset = 0,
): Promise<ReviewActivityRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT r.*, repo.owner AS repo_owner, repo.name AS repo_name
		 FROM reviews r
		 LEFT JOIN repositories repo ON repo.id = r.repository_id
		 WHERE r.installation_id IN (${placeholders})
		 ORDER BY r.id DESC
		 LIMIT ${limit} OFFSET ${offset}`,
  )
    .bind(...installationIds)
    .all<ReviewActivityRow>();
  return res.results;
}

export async function countReviews(installationIds: number[]): Promise<number> {
  if (installationIds.length === 0) return 0;
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM reviews WHERE installation_id IN (${placeholders})`,
  )
    .bind(...installationIds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface MonthlyUsageRow {
  month: string; // 'YYYY-MM' (UTC)
  reviews: number;
  completed: number;
  total_tokens: number;
  cost_usd: number;
}

export async function monthlyUsage(
  installationIds: number[],
  months = 6,
): Promise<MonthlyUsageRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT strftime('%Y-%m', created_at) AS month,
			COUNT(*) AS reviews,
			SUM(status = 'completed') AS completed,
			SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
			SUM(cost_usd) AS cost_usd
		 FROM reviews
		 WHERE installation_id IN (${placeholders})
		 GROUP BY month
		 ORDER BY month DESC
		 LIMIT ${months}`,
  )
    .bind(...installationIds)
    .all<MonthlyUsageRow>();
  return res.results;
}

export interface RepoUsageRow {
  repository_id: number;
  repo_owner: string | null;
  repo_name: string | null;
  reviews: number;
  total_tokens: number;
  cost_usd: number;
}

// Per-repo usage for one 'YYYY-MM' month, costliest first.
export async function repoUsageForMonth(
  installationIds: number[],
  month: string,
): Promise<RepoUsageRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT r.repository_id,
			repo.owner AS repo_owner, repo.name AS repo_name,
			COUNT(*) AS reviews,
			SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens) AS total_tokens,
			SUM(r.cost_usd) AS cost_usd
		 FROM reviews r
		 LEFT JOIN repositories repo ON repo.id = r.repository_id
		 WHERE r.installation_id IN (${placeholders})
			AND strftime('%Y-%m', r.created_at) = ?${installationIds.length + 1}
		 GROUP BY r.repository_id
		 ORDER BY cost_usd DESC`,
  )
    .bind(...installationIds, month)
    .all<RepoUsageRow>();
  return res.results;
}

export interface DashboardStats {
  month_reviews: number;
  month_cost_usd: number;
  month_tokens: number;
  avg_duration_s: number | null; // completed reviews this month
  avg_findings: number | null; // findings per completed review this month
  running: number;
}

export async function dashboardStats(installationIds: number[]): Promise<DashboardStats> {
  const empty: DashboardStats = {
    month_reviews: 0,
    month_cost_usd: 0,
    month_tokens: 0,
    avg_duration_s: null,
    avg_findings: null,
    running: 0,
  };
  if (installationIds.length === 0) return empty;
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const row = await env.DB.prepare(
    `SELECT
			COALESCE(SUM(strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')), 0) AS month_reviews,
			COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN cost_usd ELSE 0 END), 0) AS month_cost_usd,
			COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
				THEN input_tokens + output_tokens + cache_read_tokens + cache_write_tokens ELSE 0 END), 0) AS month_tokens,
			AVG(CASE WHEN status = 'completed' AND completed_at IS NOT NULL
				AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
				THEN (julianday(completed_at) - julianday(created_at)) * 86400 END) AS avg_duration_s,
			AVG(CASE WHEN status = 'completed' AND findings_count IS NOT NULL
				AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
				THEN findings_count END) AS avg_findings,
			COALESCE(SUM(status = 'running'), 0) AS running
		 FROM reviews
		 WHERE installation_id IN (${placeholders})`,
  )
    .bind(...installationIds)
    .first<DashboardStats>();
  return row ?? empty;
}

// Marks the latest still-running review for an agent instance as failed.
// Fired from the metering subscriber when the agent's submission settles
// without post_review having completed the row (agent error, abort, or a run
// that never posted). No-op when the row is already completed.
export async function markReviewFailed(agentInstanceId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE reviews SET status = 'failed', completed_at = datetime('now')
		 WHERE id = (
			SELECT id FROM reviews WHERE agent_instance_id = ?1 AND status = 'running'
			ORDER BY id DESC LIMIT 1
		 )`,
  )
    .bind(agentInstanceId)
    .run();
}

// True when this agent's review of this PR is running and young enough to
// still be live (older running rows are presumed dead — the /reviews stall
// rule). Backs mention-trigger dedupe so a re-tag can't double-dispatch.
export async function hasActiveReview(
  repositoryId: number,
  prNumber: number,
  agentSlug: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM reviews
		 WHERE repository_id = ?1 AND pr_number = ?2 AND agent_slug = ?3
			AND status = 'running' AND created_at > datetime('now', '-20 minutes')
		 LIMIT 1`,
  )
    .bind(repositoryId, prNumber, agentSlug)
    .first<{ id: number }>();
  return row !== null;
}

// True when this agent reviewed (or started reviewing) this PR within the
// window, regardless of outcome. Backs the push-trigger debounce: a burst of
// pushes re-dispatches at most once per window per agent.
export async function reviewedRecently(
  repositoryId: number,
  prNumber: number,
  agentSlug: string,
  windowMinutes: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM reviews
		 WHERE repository_id = ?1 AND pr_number = ?2 AND agent_slug = ?3
			AND created_at > datetime('now', '-' || ?4 || ' minutes')
		 LIMIT 1`,
  )
    .bind(repositoryId, prNumber, agentSlug, windowMinutes)
    .first<{ id: number }>();
  return row !== null;
}

// Reviews dispatched for this installation in the last 24h (backs the daily cap).
export async function reviewCountLastDay(installationId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM reviews
		 WHERE installation_id = ?1 AND created_at > datetime('now', '-1 day')`,
  )
    .bind(installationId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- durable user OAuth credentials (PR-opener attribution) ---

export interface UserTokenRow {
  user_id: number;
  login: string;
  refresh_ciphertext: string;
  updated_at: string;
}

export async function saveUserRefreshToken(
  userId: number,
  login: string,
  refreshCiphertext: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_tokens (user_id, login, refresh_ciphertext, updated_at)
		 VALUES (?1, ?2, ?3, datetime('now'))
		 ON CONFLICT(user_id) DO UPDATE SET
		   login = excluded.login,
		   refresh_ciphertext = excluded.refresh_ciphertext,
		   updated_at = excluded.updated_at`,
  )
    .bind(userId, login, refreshCiphertext)
    .run();
}

export async function getUserRefreshToken(userId: number): Promise<UserTokenRow | null> {
  return env.DB.prepare('SELECT * FROM user_tokens WHERE user_id = ?1')
    .bind(userId)
    .first<UserTokenRow>();
}

export async function deleteUserRefreshToken(userId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM user_tokens WHERE user_id = ?1').bind(userId).run();
}

// --- kanban board: todos (unstarted backlog cards) + task archiving ---

export interface TodoRow {
  id: number;
  installation_id: number;
  title: string;
  notes: string | null;
  created_by_login: string | null;
  created_by_id: number | null;
  plan_id: number | null; // set once started; the board then shows the plan
  created_at: string;
}

export async function listTodos(installationIds: number[]): Promise<TodoRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT * FROM todos
		 WHERE installation_id IN (${placeholders}) AND plan_id IS NULL
		 ORDER BY id DESC`,
  )
    .bind(...installationIds)
    .all<TodoRow>();
  return res.results;
}

export async function createTodo(
  installationId: number,
  title: string,
  notes: string | null,
  createdBy?: { login: string; id: number },
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO todos (installation_id, title, notes, created_by_login, created_by_id)
		 VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
  )
    .bind(installationId, title, notes, createdBy?.login ?? null, createdBy?.id ?? null)
    .first<{ id: number }>();
  return row!.id;
}

export async function getTodo(id: number): Promise<TodoRow | null> {
  return env.DB.prepare('SELECT * FROM todos WHERE id = ?1').bind(id).first<TodoRow>();
}

export async function deleteTodo(id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM todos WHERE id = ?1').bind(id).run();
}

export async function linkTodoToPlan(id: number, planId: number): Promise<void> {
  await env.DB.prepare('UPDATE todos SET plan_id = ?2 WHERE id = ?1').bind(id, planId).run();
}

export async function setPlanArchived(id: number, archived: boolean): Promise<void> {
  await env.DB.prepare('UPDATE plans SET archived = ?2 WHERE id = ?1')
    .bind(id, archived ? 1 : 0)
    .run();
}

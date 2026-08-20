import { env } from 'cloudflare:workers';
import { placeholderList } from './sql.ts';
import { STALL_CUTOFF_MODIFIER } from '../shared/time.ts';
import type { CliUsage } from '../shared/usage.ts';
import type { AgentRunRow } from './factory.ts';

// --- Automations (migration 0028): recurring per-repo prompt runs ---

export interface AutomationRow {
  id: number;
  repository_id: number;
  name: string;
  prompt: string;
  schedule_kind: string; // 'hourly' | 'daily' | 'weekly'
  time_of_day: string | null; // 'HH:MM' UTC
  day_of_week: number | null; // 0 (Sun) - 6 (Sat)
  enabled: number;
  next_run_at: string;
  created_at: string;
}

export interface AutomationRunRow {
  id: number;
  automation_id: number;
  status: string; // running | pr_opened | no_changes | checks_failed | failed
  pr_number: number | null;
  commit_sha: string | null;
  error: string | null;
  created_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  model: string | null;
}

export interface AutomationFields {
  name: string;
  prompt: string;
  schedule_kind: string;
  time_of_day: string | null;
  day_of_week: number | null;
}

export interface AutomationWithRepo extends AutomationRow {
  owner: string;
  name_repo: string;
  last_run: { id: number; status: string; created_at: string } | null;
}

// Flat automation list across the caller's installations, with repo context
// and the latest run's status — the automations page's one query.
export async function listAutomationsForInstallations(
  installationIds: number[],
): Promise<AutomationWithRepo[]> {
  if (installationIds.length === 0) return [];
  const placeholders = placeholderList(installationIds.length);
  const res = await env.DB.prepare(
    `SELECT a.*, r.owner, r.name AS name_repo,
		        lr.id AS last_run_id, lr.status AS last_run_status, lr.created_at AS last_run_created_at
		 FROM automations a
		 JOIN repositories r ON r.id = a.repository_id
		 LEFT JOIN automation_runs lr ON lr.id = (
		   SELECT id FROM automation_runs WHERE automation_id = a.id ORDER BY id DESC LIMIT 1
		 )
		 WHERE r.installation_id IN (${placeholders})
		 ORDER BY r.owner, r.name, a.name`,
  )
    .bind(...installationIds)
    .all<
      AutomationRow & {
        owner: string;
        name_repo: string;
        last_run_id: number | null;
        last_run_status: string | null;
        last_run_created_at: string | null;
      }
    >();
  return res.results.map((r) => ({
    ...r,
    last_run:
      r.last_run_id === null
        ? null
        : { id: r.last_run_id, status: r.last_run_status!, created_at: r.last_run_created_at! },
  }));
}

export async function getAutomationById(id: number): Promise<AutomationRow | null> {
  return env.DB.prepare('SELECT * FROM automations WHERE id = ?1').bind(id).first<AutomationRow>();
}

export async function createAutomation(
  repositoryId: number,
  fields: AutomationFields,
  nextRunAt: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO automations (repository_id, name, prompt, schedule_kind, time_of_day, day_of_week, next_run_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
  )
    .bind(
      repositoryId,
      fields.name,
      fields.prompt,
      fields.schedule_kind,
      fields.time_of_day,
      fields.day_of_week,
      nextRunAt,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function updateAutomation(
  id: number,
  fields: AutomationFields & { enabled: boolean },
  nextRunAt: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE automations SET
		 name = ?2, prompt = ?3, schedule_kind = ?4, time_of_day = ?5, day_of_week = ?6,
		 enabled = ?7, next_run_at = ?8
		 WHERE id = ?1`,
  )
    .bind(
      id,
      fields.name,
      fields.prompt,
      fields.schedule_kind,
      fields.time_of_day,
      fields.day_of_week,
      fields.enabled ? 1 : 0,
      nextRunAt,
    )
    .run();
}

// automation_runs rows (and, transitively, their agent_runs) cascade via FK.
export async function deleteAutomation(id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM automations WHERE id = ?1').bind(id).run();
}

export async function listDueAutomations(nowIso: string): Promise<AutomationRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM automations WHERE enabled = 1 AND next_run_at <= ?1`,
  )
    .bind(nowIso)
    .all<AutomationRow>();
  return res.results;
}

// Atomically claims and reschedules one due automation in a single
// statement, so a redelivered/overlapping poll can never double-fire it.
export async function claimAutomation(
  id: number,
  nextRunAt: string,
  nowIso: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `UPDATE automations SET next_run_at = ?2
		 WHERE id = ?1 AND enabled = 1 AND next_run_at <= ?3
		 RETURNING id`,
  )
    .bind(id, nextRunAt, nowIso)
    .first<{ id: number }>();
  return row !== null;
}

// Single-flight guard: records a run only when no run is already in flight
// for this automation, so an automation whose runs outlast its own interval
// skips a beat instead of piling up runs. Sweeps stale 'running' rows first
// (a consumer killed mid-run never finishes its row), mirroring
// tryRecordFixAttempt minus the attempt cap — the schedule itself throttles.
export async function tryRecordAutomationRun(automationId: number): Promise<number | null> {
  await env.DB.prepare(
    `UPDATE automation_runs SET status = 'failed', error = 'stale: consumer killed before completion'
		 WHERE automation_id = ?1 AND status = 'running'
		 AND created_at < datetime('now', '${STALL_CUTOFF_MODIFIER}')`,
  )
    .bind(automationId)
    .run();
  const row = await env.DB.prepare(
    `INSERT INTO automation_runs (automation_id)
		 SELECT ?1
		 WHERE NOT EXISTS (
		   SELECT 1 FROM automation_runs WHERE automation_id = ?1 AND status = 'running'
		 )
		 RETURNING id`,
  )
    .bind(automationId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function finishAutomationRun(
  runId: number,
  status: string,
  prNumber?: number,
  commitSha?: string,
  error?: string,
  usage?: CliUsage,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE automation_runs SET
		 status = ?2, pr_number = ?3, commit_sha = ?4, error = ?5,
		 input_tokens = ?6, output_tokens = ?7, cache_read_tokens = ?8, cache_write_tokens = ?9,
		 cost_usd = ?10, model = ?11
		 WHERE id = ?1`,
  )
    .bind(
      runId,
      status,
      prNumber ?? null,
      commitSha ?? null,
      error ?? null,
      usage?.inputTokens ?? 0,
      usage?.outputTokens ?? 0,
      usage?.cacheReadTokens ?? 0,
      usage?.cacheWriteTokens ?? 0,
      usage?.costUsd ?? 0,
      usage?.model ?? null,
    )
    .run();
}

export async function listAutomationRuns(automationId: number): Promise<AutomationRunRow[]> {
  const res = await env.DB.prepare(
    'SELECT * FROM automation_runs WHERE automation_id = ?1 ORDER BY id DESC',
  )
    .bind(automationId)
    .all<AutomationRunRow>();
  return res.results;
}

export interface AutomationRunDetail {
  run: AutomationRunRow;
  automation: { id: number; name: string; installation_id: number; owner: string; repo: string };
}

// The run detail page's ownership chain (installation_id, for the auth
// check) plus repo context, in one query — the run page is reachable
// standalone (GET /automations/runs/:id), not only nested in a list.
export async function getAutomationRunDetail(runId: number): Promise<AutomationRunDetail | null> {
  const row = await env.DB.prepare(
    `SELECT ar.*, a.name AS automation_name, r.installation_id, r.owner, r.name AS repo_name
		 FROM automation_runs ar
		 JOIN automations a ON a.id = ar.automation_id
		 JOIN repositories r ON r.id = a.repository_id
		 WHERE ar.id = ?1`,
  )
    .bind(runId)
    .first<
      AutomationRunRow & {
        automation_name: string;
        installation_id: number;
        owner: string;
        repo_name: string;
      }
    >();
  if (!row) return null;
  return {
    run: {
      id: row.id,
      automation_id: row.automation_id,
      status: row.status,
      pr_number: row.pr_number,
      commit_sha: row.commit_sha,
      error: row.error,
      created_at: row.created_at,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
      cost_usd: row.cost_usd,
      model: row.model,
    },
    automation: {
      id: row.automation_id,
      name: row.automation_name,
      installation_id: row.installation_id,
      owner: row.owner,
      repo: row.repo_name,
    },
  };
}

export async function listAgentRunsForAutomationRun(
  automationRunId: number,
): Promise<AgentRunRow[]> {
  const res = await env.DB.prepare(
    'SELECT id, kind, success, created_at FROM agent_runs WHERE automation_run_id = ?1 ORDER BY id',
  )
    .bind(automationRunId)
    .all<AgentRunRow>();
  return res.results;
}

import { sql } from 'drizzle-orm';
import { STALL_CUTOFF_MODIFIER } from '../shared/time.ts';
import type { CliUsage } from '../shared/usage.ts';
import { execute, queryOne, queryRows, withDatabase } from './database.ts';
import type { AgentRunRow } from './factory.ts';

// --- Automations: recurring per-repo prompt runs ---

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
  const rows = await queryRows<
    AutomationRow & {
      owner: string;
      name_repo: string;
      last_run_id: number | null;
      last_run_status: string | null;
      last_run_created_at: string | null;
    }
  >(sql`
    SELECT a.*, r.owner, r.name AS name_repo,
      lr.id AS last_run_id, lr.status AS last_run_status,
      lr.created_at AS last_run_created_at
    FROM app.automations a
    JOIN app.repositories r ON r.id = a.repository_id
    LEFT JOIN app.automation_runs lr ON lr.id = (
      SELECT id FROM app.automation_runs
      WHERE automation_id = a.id ORDER BY id DESC LIMIT 1
    )
    WHERE r.installation_id IN (
      ${sql.join(
        installationIds.map((id) => sql`${id}`),
        sql`, `,
      )}
    )
    ORDER BY r.owner, r.name, a.name
  `);
  return rows.map((row) => ({
    ...row,
    last_run:
      row.last_run_id === null
        ? null
        : {
            id: row.last_run_id,
            status: row.last_run_status!,
            created_at: row.last_run_created_at!,
          },
  }));
}

export async function getAutomationById(id: number): Promise<AutomationRow | null> {
  return queryOne<AutomationRow>(sql`SELECT * FROM app.automations WHERE id = ${id}`);
}

export async function createAutomation(
  repositoryId: number,
  fields: AutomationFields,
  nextRunAt: string,
): Promise<number> {
  const row = await queryOne<{ id: number }>(sql`
    INSERT INTO app.automations
      (repository_id, name, prompt, schedule_kind, time_of_day, day_of_week, next_run_at)
    VALUES (
      ${repositoryId}, ${fields.name}, ${fields.prompt}, ${fields.schedule_kind},
      ${fields.time_of_day}, ${fields.day_of_week}, ${nextRunAt}
    )
    RETURNING id
  `);
  return row!.id;
}

export async function updateAutomation(
  id: number,
  fields: AutomationFields & { enabled: boolean },
  nextRunAt: string,
): Promise<void> {
  await execute(sql`
    UPDATE app.automations SET
      name = ${fields.name}, prompt = ${fields.prompt},
      schedule_kind = ${fields.schedule_kind}, time_of_day = ${fields.time_of_day},
      day_of_week = ${fields.day_of_week}, enabled = ${fields.enabled ? 1 : 0},
      next_run_at = ${nextRunAt}
    WHERE id = ${id}
  `);
}

// automation_runs rows (and, transitively, their agent_runs) cascade via FK.
export async function deleteAutomation(id: number): Promise<void> {
  await execute(sql`DELETE FROM app.automations WHERE id = ${id}`);
}

export async function listDueAutomations(nowIso: string): Promise<AutomationRow[]> {
  return queryRows<AutomationRow>(sql`
    SELECT * FROM app.automations WHERE enabled = 1 AND next_run_at <= ${nowIso}
  `);
}

// Atomically claims and reschedules one due automation in a single
// statement, so a redelivered/overlapping poll can never double-fire it.
export async function claimAutomation(
  id: number,
  nextRunAt: string,
  nowIso: string,
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    UPDATE app.automations SET next_run_at = ${nextRunAt}
    WHERE id = ${id} AND enabled = 1 AND next_run_at <= ${nowIso}
    RETURNING id
  `);
  return row !== null;
}

// Single-flight guard: records a run only when no run is already in flight
// for this automation, so an automation whose runs outlast its own interval
// skips a beat instead of piling up runs. Sweeps stale 'running' rows first
// (a consumer killed mid-run never finishes its row), mirroring
// tryRecordFixAttempt minus the attempt cap — the schedule itself throttles.
// The partial unique index arbitrates concurrent claims after the stale sweep.
export async function tryRecordAutomationRun(automationId: number): Promise<number | null> {
  return withDatabase((database) =>
    database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE app.automation_runs
        SET status = 'failed', error = 'stale: consumer killed before completion'
        WHERE automation_id = ${automationId} AND status = 'running'
          AND created_at < CURRENT_TIMESTAMP + ${STALL_CUTOFF_MODIFIER}::interval
      `);
      const result = await transaction.execute<{ id: number }>(sql`
        INSERT INTO app.automation_runs (automation_id)
        VALUES (${automationId})
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      return result.rows[0]?.id ?? null;
    }),
  );
}

export async function finishAutomationRun(
  runId: number,
  status: string,
  prNumber?: number,
  commitSha?: string,
  error?: string,
  usage?: CliUsage,
): Promise<void> {
  await execute(sql`
    UPDATE app.automation_runs SET
      status = ${status}, pr_number = ${prNumber ?? null},
      commit_sha = ${commitSha ?? null}, error = ${error ?? null},
      input_tokens = ${usage?.inputTokens ?? 0}, output_tokens = ${usage?.outputTokens ?? 0},
      cache_read_tokens = ${usage?.cacheReadTokens ?? 0},
      cache_write_tokens = ${usage?.cacheWriteTokens ?? 0},
      cost_usd = ${usage?.costUsd ?? 0}, model = ${usage?.model ?? null}
    WHERE id = ${runId}
  `);
}

export async function listAutomationRuns(automationId: number): Promise<AutomationRunRow[]> {
  return queryRows<AutomationRunRow>(sql`
    SELECT * FROM app.automation_runs WHERE automation_id = ${automationId} ORDER BY id DESC
  `);
}

export interface AutomationRunDetail {
  run: AutomationRunRow;
  automation: { id: number; name: string; installation_id: number; owner: string; repo: string };
}

// The run detail page's ownership chain (installation_id, for the auth
// check) plus repo context, in one query — the run page is reachable
// standalone (GET /automations/runs/:id), not only nested in a list.
export async function getAutomationRunDetail(runId: number): Promise<AutomationRunDetail | null> {
  const row = await queryOne<
    AutomationRunRow & {
      automation_name: string;
      installation_id: number;
      owner: string;
      repo_name: string;
    }
  >(sql`
    SELECT ar.*, a.name AS automation_name, r.installation_id, r.owner,
      r.name AS repo_name
    FROM app.automation_runs ar
    JOIN app.automations a ON a.id = ar.automation_id
    JOIN app.repositories r ON r.id = a.repository_id
    WHERE ar.id = ${runId}
  `);
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
  return queryRows<AgentRunRow>(sql`
    SELECT id, kind, success, created_at FROM app.agent_runs
    WHERE automation_run_id = ${automationRunId} ORDER BY id
  `);
}

import { sql } from 'drizzle-orm';
import { DEFAULT_MODEL } from '../domain/personas.ts';
import { DEFAULT_RUNNER_MODEL, RUNNER_MODELS } from '../shared/runner-models.ts';
import { queryRows } from './database.ts';

// --- Model catalog (deployment-wide, operator-managed via SQL) ---
//
// One app.models table drives both pickers: the runner surface (bare ids that
// land in the sandbox as ANTHROPIC_MODEL) and the reviewer surface (AI Gateway
// ids). When a surface has no enabled rows, the code constants take over.

export interface ModelRow {
  id: number;
  model_id: string;
  provider: string;
  label: string;
  for_runner: boolean;
  for_reviewer: boolean;
  runner_default: boolean;
  reviewer_default: boolean;
  enabled: boolean;
  sort_order: number;
  created_at: string;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface SurfaceCatalog {
  options: ModelOption[];
  defaultModel: string;
}

export interface ModelCatalog {
  runner: SurfaceCatalog;
  reviewer: SurfaceCatalog;
}

// Reviewer calls go through the AI Gateway, so the stored bare id is exposed
// in its prefixed gateway form on that surface.
function gatewayId(row: ModelRow): string {
  return `cloudflare/${row.provider}/${row.model_id}`;
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  const rows = await queryRows<ModelRow>(sql`
    SELECT * FROM app.models WHERE enabled ORDER BY sort_order, label
  `);

  const runnerRows = rows.filter((r) => r.for_runner);
  const runner: SurfaceCatalog =
    runnerRows.length > 0
      ? {
          options: runnerRows.map((r) => ({ id: r.model_id, label: r.label })),
          defaultModel: (runnerRows.find((r) => r.runner_default) ?? runnerRows[0]).model_id,
        }
      : {
          options: RUNNER_MODELS.map((m) => ({ id: m.id, label: m.label })),
          defaultModel: DEFAULT_RUNNER_MODEL,
        };

  const reviewerRows = rows.filter((r) => r.for_reviewer);
  const reviewer: SurfaceCatalog =
    reviewerRows.length > 0
      ? {
          options: reviewerRows.map((r) => ({ id: gatewayId(r), label: r.label })),
          defaultModel: gatewayId(reviewerRows.find((r) => r.reviewer_default) ?? reviewerRows[0]),
        }
      : {
          options: [{ id: DEFAULT_MODEL, label: 'Sonnet 5' }],
          defaultModel: DEFAULT_MODEL,
        };

  return { runner, reviewer };
}

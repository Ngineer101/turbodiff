import { sql } from 'drizzle-orm';
import { DEFAULT_MODEL } from '../domain/personas.ts';
import { weightedReviewModel } from '../domain/review-experiment.ts';
import { queryRows } from './database.ts';

// --- Model catalog (deployment-wide, operator-managed via SQL) ---
//
// One app.models table drives both pickers. Stored ids stay provider-local;
// each surface derives the model syntax understood by its runtime.

export interface ModelRow {
  id: number;
  model_id: string;
  provider: string;
  label: string;
  for_runner: boolean;
  for_reviewer: boolean;
  runner_default: boolean;
  runner_fast_default: boolean;
  reviewer_default: boolean;
  reviewer_experiment_weight: number;
  verifier_experiment_weight: number;
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

export interface RunnerSurfaceCatalog extends SurfaceCatalog {
  fastModel: string;
}

export interface ModelCatalog {
  runner: RunnerSurfaceCatalog;
  reviewer: SurfaceCatalog;
}

export class ModelCatalogConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCatalogConfigurationError';
  }
}

// Reviewer calls go through the Cloudflare AI binding. Third-party models use
// provider/model while Workers AI models retain their canonical @cf id.
function gatewayId(row: ModelRow): string {
  return row.model_id.startsWith('@cf/')
    ? `cloudflare/${row.model_id}`
    : `cloudflare/${row.provider}/${row.model_id}`;
}

function runnerId(row: ModelRow): string {
  // Workers AI is the one catalog namespace whose canonical REST id already
  // contains its author prefix (`@cf/author/model`).
  return row.model_id.startsWith('@cf/') ? row.model_id : `${row.provider}/${row.model_id}`;
}

function runnerCatalog(rows: ModelRow[]): RunnerSurfaceCatalog {
  const runnerRows = rows.filter((row) => row.for_runner);
  if (runnerRows.length === 0) {
    throw new ModelCatalogConfigurationError(
      'runner model catalog is empty; enable at least one app.models row with for_runner = true',
    );
  }
  const defaultRow = runnerRows.find((row) => row.runner_default);
  if (!defaultRow) {
    throw new ModelCatalogConfigurationError(
      'runner model catalog has no default; mark one enabled runner row runner_default = true',
    );
  }
  const fastRow = runnerRows.find((row) => row.runner_fast_default);
  if (!fastRow) {
    throw new ModelCatalogConfigurationError(
      'runner model catalog has no fast default; mark one enabled runner row runner_fast_default = true',
    );
  }
  return {
    options: runnerRows.map((row) => ({ id: runnerId(row), label: row.label })),
    defaultModel: runnerId(defaultRow),
    fastModel: runnerId(fastRow),
  };
}

function reviewerCatalog(rows: ModelRow[]): SurfaceCatalog {
  const reviewerRows = rows.filter((row) => row.for_reviewer);
  return reviewerRows.length > 0
    ? {
        options: reviewerRows.map((row) => ({ id: gatewayId(row), label: row.label })),
        defaultModel: gatewayId(
          reviewerRows.find((row) => row.reviewer_default) ?? reviewerRows[0],
        ),
      }
    : {
        options: [{ id: DEFAULT_MODEL, label: 'Sonnet 5' }],
        defaultModel: DEFAULT_MODEL,
      };
}

async function enabledModelRows(): Promise<ModelRow[]> {
  return queryRows<ModelRow>(sql`
    SELECT * FROM app.models WHERE enabled ORDER BY sort_order, label
  `);
}

export async function getRunnerModelCatalog(): Promise<RunnerSurfaceCatalog> {
  return runnerCatalog(await enabledModelRows());
}

export async function getReviewerModelCatalog(): Promise<SurfaceCatalog> {
  return reviewerCatalog(await enabledModelRows());
}

export async function assignReviewModels(
  key: string,
  scoutFallback: string,
): Promise<{ scout: string; verifier: string; experimentKey: string | null }> {
  const rows = (await enabledModelRows()).filter((row) => row.for_reviewer);
  const fallbackVerifier = reviewerCatalog(rows).defaultModel;
  const scout = weightedReviewModel(
    key,
    'scout',
    rows.map((row) => ({ model: gatewayId(row), weight: row.reviewer_experiment_weight })),
    scoutFallback,
  );
  const verifier = weightedReviewModel(
    key,
    'verifier',
    rows.map((row) => ({ model: gatewayId(row), weight: row.verifier_experiment_weight })),
    fallbackVerifier,
  );
  const experimentKey =
    scout.experimental || verifier.experimental
      ? `weighted-v1:scout=${scout.model}:verifier=${verifier.model}`
      : null;
  return { scout: scout.model, verifier: verifier.model, experimentKey };
}

export async function resolveRunnerModel(
  requested?: string | null,
  role: 'default' | 'fast' = 'default',
): Promise<string> {
  const catalog = await getRunnerModelCatalog();
  const selected = requested?.trim();
  if (!selected) return role === 'fast' ? catalog.fastModel : catalog.defaultModel;
  if (!catalog.options.some((option) => option.id === selected)) {
    throw new ModelCatalogConfigurationError(
      `runner model "${selected}" is not enabled in app.models`,
    );
  }
  return selected;
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  const rows = await enabledModelRows();
  return { runner: runnerCatalog(rows), reviewer: reviewerCatalog(rows) };
}

import { sql } from 'drizzle-orm';
import { queryOne, queryRows, sqlValueList } from './postgres.ts';

export interface ModelRow {
  id: number;
  provider: string;
  model_id: string;
  label: string;
  capabilities: string[];
  enabled: boolean;
  is_default: boolean;
  is_fast_default: boolean;
  created_at: string;
}

export interface ModelOption {
  id: string;
  label: string;
  capabilities: string[];
}

export interface ModelCatalog {
  options: ModelOption[];
  defaultModel: string;
  fastModel: string;
}

export class ModelCatalogConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCatalogConfigurationError';
  }
}

export function canonicalModelId(row: ModelRow): string {
  return row.model_id.startsWith('@cf/') ? row.model_id : `${row.provider}/${row.model_id}`;
}

export async function listEnabledModels(): Promise<ModelRow[]> {
  return queryRows<ModelRow>(sql`
    SELECT * FROM app.models WHERE enabled ORDER BY label, id
  `);
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  const rows = await listEnabledModels();
  const defaultModel = rows.find((row) => row.is_default);
  const fastModel = rows.find((row) => row.is_fast_default);
  if (!defaultModel || !fastModel) {
    throw new ModelCatalogConfigurationError(
      'model catalog requires one enabled default and one enabled fast default',
    );
  }
  return {
    options: rows.map((row) => ({
      id: canonicalModelId(row),
      label: row.label,
      capabilities: row.capabilities,
    })),
    defaultModel: canonicalModelId(defaultModel),
    fastModel: canonicalModelId(fastModel),
  };
}

export async function resolveModel(
  requested?: string | null,
  role: 'default' | 'fast' = 'default',
): Promise<ModelRow> {
  const rows = await listEnabledModels();
  const requestedId = requested?.trim();
  const selected = requestedId
    ? rows.find((row) => canonicalModelId(row) === requestedId)
    : rows.find((row) => (role === 'fast' ? row.is_fast_default : row.is_default));
  if (!selected) {
    throw new ModelCatalogConfigurationError(
      requestedId
        ? `model "${requestedId}" is not enabled`
        : `model catalog has no ${role} default`,
    );
  }
  return selected;
}

export async function getModel(id: number): Promise<ModelRow | null> {
  return queryOne<ModelRow>(sql`SELECT * FROM app.models WHERE id = ${id}`);
}

export async function listModelsForFactoryRuns(
  factoryRunIds: readonly number[],
): Promise<ModelRow[]> {
  if (factoryRunIds.length === 0) return [];
  return queryRows<ModelRow>(sql`
    SELECT DISTINCT model.*
    FROM app.models model
    JOIN app.factory_runs factory_run ON factory_run.model_id = model.id
    WHERE factory_run.id IN (${sqlValueList(factoryRunIds)})
  `);
}

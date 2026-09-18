import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

const database = new PGlite();
const directory = path.resolve('db/migrations');
const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
const journal = JSON.parse(await readFile(path.join(directory, 'meta', '_journal.json'), 'utf8'));

if (files.length !== 2 || journal.entries.length !== 2) {
  throw new Error(
    `Expected the baseline and model catalog migrations, found ${files.length} files and ${journal.entries.length} journal entries`,
  );
}

try {
  await migrate(drizzle(database), {
    migrationsFolder: directory,
    migrationsSchema: 'public',
    migrationsTable: 'schema_migrations',
  });
} catch (error) {
  throw new Error('Fresh migration chain failed', { cause: error });
}

const requiredTables = await database.query(`
  SELECT table_schema || '.' || table_name AS name
  FROM information_schema.tables
  WHERE table_schema IN ('app', 'auth') AND table_type = 'BASE TABLE'
`);
const tableNames = new Set(requiredTables.rows.map((row) => row.name));
for (const name of [
  'auth.user',
  'auth.organization',
  'auth.member',
  'app.integrations',
  'app.repositories',
  'app.models',
  'app.agents',
  'app.skills',
  'app.automations',
  'app.artifacts',
  'app.work_items',
  'app.work_item_targets',
  'app.deliveries',
  'app.acceptance_contracts',
  'app.changes',
  'app.change_revisions',
  'app.factory_runs',
  'app.stage_runs',
  'app.agent_runs',
  'app.lifecycle_events',
  'app.review_outcomes',
]) {
  if (!tableNames.has(name)) throw new Error(`Required primitive table is missing: ${name}`);
}

const legacyTables = await database.query(`
  SELECT table_schema, table_name
  FROM information_schema.tables
  WHERE table_schema IN ('app', 'auth')
    AND table_name = ANY(ARRAY[
      'installations', 'plans', 'todos', 'features', 'reviews', 'review_intake',
      'fix_attempts', 'verifications', 'feature_explanations', 'automation_runs',
      'change_requests', 'performance_samples', 'quality_feedback'
    ])
`);
if (legacyTables.rows.length > 0) {
  throw new Error(`Legacy tables survived the baseline: ${JSON.stringify(legacyTables.rows)}`);
}

const defaults = await database.query(`
  SELECT
    COUNT(*) FILTER (WHERE enabled AND is_default)::int AS defaults,
    COUNT(*) FILTER (WHERE enabled AND is_fast_default)::int AS fast_defaults,
    MAX(provider || '/' || model_id) FILTER (WHERE is_default) AS default_model,
    MAX(provider || '/' || model_id) FILTER (WHERE is_fast_default) AS fast_model
  FROM app.models
`);
const modelDefaults = defaults.rows[0];
if (
  modelDefaults?.defaults !== 1 ||
  modelDefaults?.fast_defaults !== 1 ||
  modelDefaults?.default_model !== 'openai/gpt-5.6-sol' ||
  modelDefaults?.fast_model !== 'anthropic/claude-opus-4.8'
) {
  throw new Error(`Invalid model defaults: ${JSON.stringify(modelDefaults)}`);
}

const expectedModels = new Set([
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-5.3',
  '@cf/zai-org/glm-5.3-flash',
  'alibaba/qwen3-max',
  'alibaba/qwen3.5-397b-a17b',
  'alibaba/qwen3.7-max',
  'alibaba/qwen3.7-plus',
  'alibaba/qwen3.8-max',
  'anthropic/claude-fable-5',
  'anthropic/claude-fable-5.1',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4.5',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-5',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-sonnet-5',
  'google/gemini-3.6-flash',
  'google/gemini-3.7-flash',
  'google/gemini-3.8-flash',
  'moonshotai/kimi-k3',
  'openai/gpt-4.1',
  'openai/gpt-5',
  'openai/gpt-5.1',
  'openai/gpt-5.4',
  'openai/gpt-5.4-pro',
  'openai/gpt-5.5',
  'openai/gpt-5.5-pro',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-6-astra',
  'openai/o3',
  'stealth/union-alpha',
  'thinkingmachines/inkling',
  'thinkingmachines/inkling-256k',
  'unbiased/pareto',
  'xai/grok-4.20-0309-non-reasoning',
  'xai/grok-4.20-0309-reasoning',
  'xai/grok-4.3',
]);
const catalogRows = await database.query(`
  SELECT CASE
    WHEN model_id LIKE '@cf/%' THEN model_id
    ELSE provider || '/' || model_id
  END AS id
  FROM app.models
  WHERE enabled
`);
const catalogModels = new Set(catalogRows.rows.map((row) => row.id));
const missingModels = [...expectedModels].filter((id) => !catalogModels.has(id));
const unexpectedModels = [...catalogModels].filter((id) => !expectedModels.has(id));
if (missingModels.length > 0 || unexpectedModels.length > 0) {
  throw new Error(`Invalid model catalog: ${JSON.stringify({ missingModels, unexpectedModels })}`);
}

const missingForeignKeyIndexes = await database.query(`
  SELECT c.conrelid::regclass::text AS table_name, c.conname
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.connamespace IN ('app'::regnamespace, 'auth'::regnamespace)
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND (i.indkey::smallint[])[0] = c.conkey[1]
    )
`);
if (missingForeignKeyIndexes.rows.length > 0) {
  throw new Error(
    `Foreign keys without supporting indexes: ${JSON.stringify(missingForeignKeyIndexes.rows)}`,
  );
}

await database.exec(`
  INSERT INTO auth."user" (id, name, email, "createdAt", "updatedAt") VALUES
    ('user-a', 'A', 'a@example.test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('user-b', 'B', 'b@example.test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  INSERT INTO auth."organization" (id, name, slug, "createdAt") VALUES
    ('org-a', 'A', 'a', CURRENT_TIMESTAMP),
    ('org-b', 'B', 'b', CURRENT_TIMESTAMP);
  INSERT INTO app.integrations (id, organization_id, kind, provider, name, external_account_id) VALUES
    (1, 'org-a', 'scm', 'github', 'GitHub A', '101'),
    (2, 'org-b', 'scm', 'github', 'GitHub B', '202');
  INSERT INTO app.repositories (id, organization_id, source_integration_id, external_id, owner, name) VALUES
    (1, 'org-a', 1, '1001', 'a', 'api'),
    (2, 'org-b', 2, '2002', 'b', 'api'),
    (3, 'org-a', 1, '1003', 'a', 'worker');
  INSERT INTO app.agents (id, organization_id, definition_key, slug, name) VALUES
    (1, 'org-a', 'reviewer', 'reviewer', 'Reviewer A'),
    (2, 'org-b', 'reviewer', 'reviewer', 'Reviewer B');
  INSERT INTO app.skills (id, organization_id, slug, name, content, content_hash) VALUES
    (1, 'org-a', 'policy-a', 'Policy A', 'A', 'aaa'),
    (2, 'org-b', 'policy-b', 'Policy B', 'B', 'bbb');
  INSERT INTO app.work_items (id, organization_id, origin, title, description, created_by_user_id) VALUES
    (1, 'org-a', 'idea', 'Ship', 'Ship it', 'user-a'),
    (2, 'org-b', 'idea', 'Other', 'Other work', 'user-b');
  INSERT INTO app.work_item_targets (work_item_id, repository_id, organization_id, position)
    VALUES (1, 1, 'org-a', 0);
  INSERT INTO app.automations
    (id, organization_id, agent_id, repository_id, name, schedule, input_template, created_by_user_id)
  VALUES (1, 'org-a', 1, 1, 'Automation A', 'hourly', '{}', 'user-a');
`);

async function mustReject(name, sql) {
  try {
    await database.exec(sql);
  } catch {
    return;
  }
  throw new Error(`${name} was not rejected`);
}

await mustReject(
  'cross-tenant work-item target',
  `
  INSERT INTO app.work_item_targets (work_item_id, repository_id, organization_id, position)
  VALUES (1, 2, 'org-a', 1)
`,
);
await mustReject(
  'factory run without exactly one scope',
  `
  INSERT INTO app.factory_runs (organization_id, flow_key, flow_version, trigger, idempotency_key)
  VALUES ('org-a', 'delivery', 1, 'manual', 'unscoped')
`,
);
await mustReject(
  'delivery outside work-item targets',
  `
  INSERT INTO app.deliveries (organization_id, work_item_id, repository_id)
  VALUES ('org-a', 1, 3)
`,
);
await mustReject(
  'cross-tenant automation integration',
  `
  INSERT INTO app.automation_integrations (automation_id, integration_id, organization_id)
  VALUES (1, 2, 'org-a')
`,
);
await mustReject(
  'cross-tenant automation skill',
  `
  INSERT INTO app.automation_skills (automation_id, skill_id, organization_id)
  VALUES (1, 2, 'org-a')
`,
);

await database.exec(`
  INSERT INTO app.factory_runs
    (id, organization_id, flow_key, flow_version, work_item_id, trigger, idempotency_key)
  VALUES (1, 'org-a', 'delivery', 1, 1, 'manual', 'run-a');
  INSERT INTO app.factory_runs
    (id, organization_id, flow_key, flow_version, work_item_id, trigger, idempotency_key)
  VALUES (2, 'org-b', 'delivery', 1, 2, 'manual', 'run-b');
  INSERT INTO app.stage_runs
    (id, organization_id, factory_run_id, stage_key, idempotency_key)
  VALUES (1, 'org-a', 1, 'plan', 'stage-a');
  INSERT INTO app.artifacts
    (id, organization_id, kind, schema_version, storage_key, content_hash, size_bytes)
  VALUES
    (1, 'org-a', 'agent-input', 1, 'org-a/input.json', 'aaa', 2),
    (2, 'org-b', 'agent-input', 1, 'org-b/input.json', 'bbb', 2);
`);
await mustReject(
  'cross-tenant parent factory run',
  `
  INSERT INTO app.factory_runs
    (organization_id, flow_key, flow_version, work_item_id, parent_run_id, trigger, idempotency_key)
  VALUES ('org-a', 'delivery', 1, 1, 2, 'manual', 'cross-tenant-parent')
`,
);
await mustReject(
  'cross-tenant agent run',
  `
  INSERT INTO app.agent_runs
    (organization_id, stage_run_id, agent_id, model_id, input_artifact_id, idempotency_key)
  VALUES ('org-b', 1, 2, 1, 2, 'cross-tenant-agent-run')
`,
);

await database.exec(`
  INSERT INTO app.deliveries (id, organization_id, work_item_id, repository_id)
  VALUES (1, 'org-a', 1, 1);
  INSERT INTO app.acceptance_contracts
    (organization_id, delivery_id, version, artifact_id, status)
  VALUES ('org-a', 1, 1, 1, 'active');
`);
await mustReject(
  'multiple active acceptance contracts',
  `
  INSERT INTO app.acceptance_contracts
    (organization_id, delivery_id, version, artifact_id, status)
  VALUES ('org-a', 1, 2, 1, 'active')
`,
);

await database.close();
console.log(`Fresh primitive-first PostgreSQL baseline passed (${files.length} migrations)`);

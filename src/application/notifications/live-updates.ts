import { env } from 'cloudflare:workers';
import { sql, type SQL } from 'drizzle-orm';
import { queryRows } from '../../data/database.ts';
import type { LiveUpdates } from '../../live-updates.ts';

export async function notifyInstallationsLive(installationIds: number[]): Promise<void> {
  const uniqueIds = [...new Set(installationIds)];
  if (uniqueIds.length === 0) return;
  // SAFETY: Wrangler cannot infer the LiveUpdates RPC methods across Flue's entrypoint.
  const namespace = env.LIVE_UPDATES as DurableObjectNamespace<LiveUpdates>;
  await Promise.all(
    uniqueIds.map((installationId) => namespace.getByName(String(installationId)).broadcast()),
  );
}

async function notifyQueryLive(query: SQL): Promise<void> {
  try {
    const rows = await queryRows<{ installation_id: number }>(query);
    await notifyInstallationsLive(rows.map((row) => row.installation_id));
  } catch (err) {
    // Live invalidation is best-effort; polling recovers missed updates.
    console.warn('turbodiff: live invalidation failed', err);
  }
}

export async function notifyFeatureLive(featureId: number): Promise<void> {
  await notifyQueryLive(sql`
    SELECT DISTINCT r.installation_id
    FROM app.features f JOIN app.repositories r ON r.id = f.repository_id
    WHERE f.id = ${featureId}
  `);
}

export async function notifyPlanLive(planId: number): Promise<void> {
  await notifyQueryLive(sql`
    SELECT DISTINCT r.installation_id
    FROM app.repositories r
    WHERE r.id IN (
      SELECT repository_id FROM app.plan_repositories WHERE plan_id = ${planId}
      UNION SELECT repository_id FROM app.plans WHERE id = ${planId}
    )
  `);
}

export async function notifyRepositoryLive(repositoryId: number): Promise<void> {
  await notifyQueryLive(sql`
    SELECT installation_id FROM app.repositories WHERE id = ${repositoryId}
  `);
}

export async function notifyAutomationLive(automationId: number): Promise<void> {
  await notifyQueryLive(sql`
    SELECT r.installation_id
    FROM app.automations a JOIN app.repositories r ON r.id = a.repository_id
    WHERE a.id = ${automationId}
  `);
}

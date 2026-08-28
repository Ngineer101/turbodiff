import { env } from 'cloudflare:workers';
import { database, type PreparedQuery } from '../data/postgres.ts';
import type { LiveUpdates } from '../live-updates.ts';

// One hibernating Durable Object per GitHub installation. Invalidations carry
// no application data; they only tell active clients to refresh the queries
// they already have permission to read.
export async function notifyInstallationsLive(installationIds: number[]): Promise<void> {
  const uniqueIds = [...new Set(installationIds)];
  if (uniqueIds.length === 0) return;
  // SAFETY: wrangler.jsonc binds LIVE_UPDATES to the exported LiveUpdates
  // class; Wrangler cannot currently infer RPC methods across Flue's
  // generated Cloudflare entrypoint, so its generated namespace is untyped.
  const namespace = env.LIVE_UPDATES as DurableObjectNamespace<LiveUpdates>;
  await Promise.all(
    uniqueIds.map((installationId) => namespace.getByName(String(installationId)).broadcast()),
  );
}

async function notifyQueryLive(query: PreparedQuery): Promise<void> {
  try {
    const rows = await query.all<{ installation_id: number }>();
    await notifyInstallationsLive(rows.results.map((row) => row.installation_id));
  } catch (err) {
    // UI invalidation is an acceleration layer. Durable work and mutations
    // must remain successful when the hub is temporarily unavailable; the
    // client's low-frequency poll is the recovery path.
    console.warn('turbodiff: live invalidation failed', err);
  }
}

export async function notifyFeatureLive(featureId: number): Promise<void> {
  await notifyQueryLive(
    database()
      .prepare(
        `SELECT DISTINCT r.installation_id
		 FROM features f JOIN repositories r ON r.id = f.repository_id
		 WHERE f.id = ?1`,
      )
      .bind(featureId),
  );
}

export async function notifyPlanLive(planId: number): Promise<void> {
  await notifyQueryLive(
    database()
      .prepare(
        `SELECT DISTINCT r.installation_id
		 FROM repositories r
		 WHERE r.id IN (
		   SELECT repository_id FROM plan_repositories WHERE plan_id = ?1
		   UNION SELECT repository_id FROM plans WHERE id = ?1
		 )`,
      )
      .bind(planId),
  );
}

export async function notifyRepositoryLive(repositoryId: number): Promise<void> {
  await notifyQueryLive(
    database().prepare('SELECT installation_id FROM repositories WHERE id = ?1').bind(repositoryId),
  );
}

export async function notifyAutomationLive(automationId: number): Promise<void> {
  await notifyQueryLive(
    database()
      .prepare(
        `SELECT r.installation_id
		 FROM automations a JOIN repositories r ON r.id = a.repository_id
		 WHERE a.id = ?1`,
      )
      .bind(automationId),
  );
}

import {
  addRepositories,
  listRepositoryIdsForInstallation,
  removeRepositories,
} from '../data/db.ts';
import { installationToken } from '../integrations/github/app.ts';
import { githubPaginate } from '../integrations/github/client.ts';

// Webhooks keep the D1 repository mirror current, but a missed
// `installation_repositories` delivery (downtime, webhook URL change) leaves
// the mirror stale forever. This reconciles one installation's rows against
// GitHub's actual repo list — the same adds/removes the webhook would have
// applied. Callers treat failures as non-fatal: the mirror stays as-is.

// Per-isolate throttle so a burst of settings loads doesn't hammer GitHub.
const SYNC_INTERVAL_MS = 60_000;
const lastSyncAt = new Map<number, number>();

export async function syncInstallationRepos(installationId: number): Promise<void> {
  const last = lastSyncAt.get(installationId) ?? 0;
  if (Date.now() - last < SYNC_INTERVAL_MS) return;
  lastSyncAt.set(installationId, Date.now());

  const token = await installationToken(installationId);
  const live = await githubPaginate<
    { repositories: { id: number; name: string; full_name: string }[] },
    { id: number; name: string; full_name: string }
  >(token, '/installation/repositories?per_page=100', (page) => page.repositories, {
    // Reconciliation must see the complete repo list: a capped listing would
    // permanently wedge large installations (the throw is caught upstream and
    // the 60s throttle would retry-and-fail forever).
    maxPages: Infinity,
  });

  await addRepositories(installationId, live);
  const liveIds = new Set(live.map((r) => r.id));
  const stale = (await listRepositoryIdsForInstallation(installationId)).filter(
    (id) => !liveIds.has(id),
  );
  if (stale.length > 0) {
    console.log(
      `turbodiff: repo sync removed ${stale.length} stale repos for installation ${installationId}`,
    );
    await removeRepositories(stale);
  }
}

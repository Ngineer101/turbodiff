import {
  addRepositories,
  claimInstallationRepoSync,
  finishInstallationRepoSync,
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

export async function syncInstallationRepos(installationId: number): Promise<void> {
  // Synthetic Artifacts installations (negative ids, docs/artifacts-provider.md)
  // have no GitHub side to reconcile against — asking GitHub about them would
  // 404 and, worse, delete every repo row as "stale".
  if (installationId < 0) return;
  if (!(await claimInstallationRepoSync(installationId))) return;

  try {
    const token = await installationToken(installationId);
    const live = await githubPaginate<
      { repositories: { id: number; name: string; full_name: string }[] },
      { id: number; name: string; full_name: string }
    >(token, '/installation/repositories?per_page=100', (page) => page.repositories, {
      // Reconciliation must see the complete repo list: a capped listing would
      // permanently wedge large installations.
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
    await finishInstallationRepoSync(installationId, true);
  } catch (err) {
    await finishInstallationRepoSync(installationId, false);
    throw err;
  }
}

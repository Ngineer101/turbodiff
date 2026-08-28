import {
  addRepositories,
  claimInstallationRepoSync,
  finishInstallationRepoSync,
  getInstallation,
  listRepositoryIdsForInstallation,
  removeRepositories,
} from '../data/db.ts';
import { installationToken } from '../integrations/github/app.ts';
import { githubPaginate } from '../integrations/github/client.ts';

// Webhooks keep the PostgreSQL repository mirror current, but a missed
// `installation_repositories` delivery (downtime, webhook URL change) leaves
// the mirror stale forever. This reconciles one installation's rows against
// GitHub's actual repo list — the same adds/removes the webhook would have
// applied. Callers treat failures as non-fatal: the mirror stays as-is.

export async function syncInstallationRepos(installationId: number): Promise<void> {
  // Artifacts installations have no GitHub side to reconcile against. Provider
  // identity is explicit; numeric id ranges must never carry application
  // semantics.
  const installation = await getInstallation(installationId);
  if (installation?.provider !== 'github') return;
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

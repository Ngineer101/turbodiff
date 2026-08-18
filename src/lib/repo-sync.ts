import { addRepositories, listRepositoryIdsForInstallation, removeRepositories } from './db.ts';
import { installationToken } from './github-app.ts';

// Webhooks keep the D1 repository mirror current, but a missed
// `installation_repositories` delivery (downtime, webhook URL change) leaves
// the mirror stale forever. This reconciles one installation's rows against
// GitHub's actual repo list — the same adds/removes the webhook would have
// applied. Callers treat failures as non-fatal: the mirror stays as-is.

const API = 'https://api.github.com';

// Per-isolate throttle so a burst of settings loads doesn't hammer GitHub.
const SYNC_INTERVAL_MS = 60_000;
const lastSyncAt = new Map<number, number>();

export async function syncInstallationRepos(installationId: number): Promise<void> {
  const last = lastSyncAt.get(installationId) ?? 0;
  if (Date.now() - last < SYNC_INTERVAL_MS) return;
  lastSyncAt.set(installationId, Date.now());

  const token = await installationToken(installationId);
  const live: { id: number; name: string; full_name: string }[] = [];
  let url: string | null = `${API}/installation/repositories?per_page=100`;
  while (url) {
    const res: Response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'turbodiff',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(
        `GitHub API ${res.status} listing repos for installation ${installationId}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    // SAFETY: non-ok responses threw above, and GitHub's "list repositories
    // accessible to the app installation" response always carries a
    // repositories array whose items have id, name, and full_name.
    const data = (await res.json()) as {
      repositories: { id: number; name: string; full_name: string }[];
    };
    live.push(
      ...data.repositories.map((r) => ({ id: r.id, name: r.name, full_name: r.full_name })),
    );
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
    url = next ? next[1] : null;
  }

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

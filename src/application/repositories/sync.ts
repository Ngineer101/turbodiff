import {
  finishIntegrationSync,
  getIntegration,
  listRepositories,
  removeRepositories,
  upsertRepositories,
} from '../../data/db.ts';
import { installationToken } from '../../integrations/github/app.ts';
import { githubPaginate } from '../../integrations/github/client.ts';

export async function syncGithubRepositories(integrationId: number): Promise<void> {
  const integration = await getIntegration(integrationId);
  if (!integration || integration.provider !== 'github' || !integration.external_account_id) return;
  try {
    const token = await installationToken(Number(integration.external_account_id));
    const remote = await githubPaginate<
      { repositories: { id: number; name: string; full_name: string; default_branch: string }[] },
      { id: number; name: string; full_name: string; default_branch: string }
    >(token, '/installation/repositories?per_page=100', (page) => page.repositories, {
      maxPages: Infinity,
    });
    await upsertRepositories(
      integration,
      remote.map((repository) => {
        const [owner = '', name = repository.name] = repository.full_name.split('/');
        return {
          externalId: String(repository.id),
          owner,
          name,
          defaultBranch: repository.default_branch,
        };
      }),
    );
    const live = new Set(remote.map((repository) => String(repository.id)));
    const stale = (await listRepositories([integration.organization_id]))
      .filter(
        (repository) =>
          repository.source_integration_id === integration.id &&
          repository.external_id &&
          !live.has(repository.external_id),
      )
      .map((repository) => repository.id);
    await removeRepositories(stale);
    await finishIntegrationSync(integration.id, null);
  } catch (failure) {
    await finishIntegrationSync(
      integration.id,
      null,
      failure instanceof Error ? failure.message : 'sync failed',
    );
    throw failure;
  }
}

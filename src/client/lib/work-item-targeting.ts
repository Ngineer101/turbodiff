import type { ApiBoard } from '../types.ts';

interface QuickAddTargetScope {
  board: Pick<ApiBoard, 'organizations' | 'repos'>;
  targetRepositoryIds: readonly number[];
  manualOrganizationId: string | null;
  activeRepositoryId: number | null;
}

export function quickAddRepositoryGroups(
  board: Pick<ApiBoard, 'organizations' | 'repos'>,
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  return board.organizations
    .map((organization) => ({
      organization,
      repositories: board.repos.filter(
        (repository) =>
          repository.organization_id === organization.id &&
          (!normalizedQuery ||
            `${repository.owner}/${repository.name}`.toLowerCase().includes(normalizedQuery)),
      ),
    }))
    .filter((group) => !normalizedQuery || group.repositories.length > 0);
}

export function toggleQuickAddRepository(
  repositories: ApiBoard['repos'],
  selectedRepositoryIds: readonly number[],
  repositoryId: number,
): number[] {
  if (selectedRepositoryIds.includes(repositoryId)) {
    return selectedRepositoryIds.filter((id) => id !== repositoryId);
  }
  const repository = repositories.find((candidate) => candidate.id === repositoryId);
  if (!repository) return [...selectedRepositoryIds];
  const firstSelectedId = selectedRepositoryIds[0];
  const selectedOrganizationId = repositories.find(
    (candidate) => candidate.id === firstSelectedId,
  )?.organization_id;
  if (selectedOrganizationId && selectedOrganizationId !== repository.organization_id) {
    return [repositoryId];
  }
  if (selectedRepositoryIds.length >= 3) return [...selectedRepositoryIds];
  return [...selectedRepositoryIds, repositoryId];
}

export function resolveQuickAddOrganizationId({
  board,
  targetRepositoryIds,
  manualOrganizationId,
  activeRepositoryId,
}: QuickAddTargetScope): string {
  const repositoryOrganization = (repositoryId: number) =>
    board.repos.find((repository) => repository.id === repositoryId)?.organization_id;

  return (
    (targetRepositoryIds[0] !== undefined
      ? repositoryOrganization(targetRepositoryIds[0])
      : undefined) ??
    manualOrganizationId ??
    (activeRepositoryId ? repositoryOrganization(activeRepositoryId) : undefined) ??
    board.repos[0]?.organization_id ??
    board.organizations[0]?.id ??
    ''
  );
}

import { describe, expect, it } from 'vite-plus/test';
import {
  quickAddRepositoryGroups,
  resolveQuickAddOrganizationId,
  toggleQuickAddRepository,
} from '../../../../src/client/lib/work-item-targeting.ts';

describe('resolveQuickAddOrganizationId', () => {
  it('defaults an unfiltered todo to an organization that has repositories', () => {
    const board = {
      organizations: [
        { id: 'empty-org', name: 'Empty organization' },
        { id: 'repo-org', name: 'Repository organization' },
      ],
      repos: [
        { id: 41, owner: 'acme', name: 'web', organization_id: 'repo-org' },
        { id: 42, owner: 'acme', name: 'api', organization_id: 'repo-org' },
      ],
    };

    expect(
      resolveQuickAddOrganizationId({
        board,
        targetRepositoryIds: [],
        manualOrganizationId: null,
        activeRepositoryId: null,
      }),
    ).toBe('repo-org');

    expect(
      resolveQuickAddOrganizationId({
        board,
        targetRepositoryIds: [],
        manualOrganizationId: 'empty-org',
        activeRepositoryId: null,
      }),
    ).toBe('empty-org');
  });

  it('groups every repository and keeps a selection within one organization', () => {
    const board = {
      organizations: [
        { id: 'first-org', name: 'First organization' },
        { id: 'second-org', name: 'Second organization' },
      ],
      repos: [
        { id: 41, owner: 'first', name: 'web', organization_id: 'first-org' },
        { id: 42, owner: 'first', name: 'api', organization_id: 'first-org' },
        { id: 51, owner: 'second', name: 'worker', organization_id: 'second-org' },
      ],
    };

    expect(
      quickAddRepositoryGroups(board, '').map((group) => ({
        organizationId: group.organization.id,
        repositoryIds: group.repositories.map((repository) => repository.id),
      })),
    ).toEqual([
      { organizationId: 'first-org', repositoryIds: [41, 42] },
      { organizationId: 'second-org', repositoryIds: [51] },
    ]);
    expect(toggleQuickAddRepository(board.repos, [41], 42)).toEqual([41, 42]);
    expect(toggleQuickAddRepository(board.repos, [41, 42], 51)).toEqual([51]);
  });
});

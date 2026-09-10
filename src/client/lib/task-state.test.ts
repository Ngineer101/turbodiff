import { describe, expect, it } from 'vite-plus/test';
import type { ApiPlan, ApiTaskRepo } from '../../shared/api-types.ts';
import { taskColumn } from './task-state.ts';

// Minimal fixtures varying only status/repos — taskColumn keys off repos
// alone, but the board's "Factory running" lamp depends on it classifying
// every started-but-unfinished task (including waiting-on-human states) as
// in_progress.

function repo(overrides: Partial<ApiTaskRepo> = {}): ApiTaskRepo {
  return {
    repository_id: 1,
    owner: 'acme',
    name: 'app',
    provider: 'github',
    feature_id: 1,
    pr_number: null,
    feature_status: null,
    feature_error: null,
    verification: null,
    ...overrides,
  };
}

function plan(overrides: Partial<ApiPlan> = {}): ApiPlan {
  return {
    id: 1,
    title: 'Task',
    status: 'approved',
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    questions: [],
    acceptance: [],
    plan: null,
    summary: null,
    archived: false,
    model: 'model',
    attachments: [],
    repos: [],
    ...overrides,
  };
}

describe('taskColumn', () => {
  it('is done when every repo is merged', () => {
    expect(
      taskColumn(
        plan({
          repos: [
            repo({ repository_id: 1, feature_status: 'merged' }),
            repo({ repository_id: 2, feature_status: 'merged' }),
          ],
        }),
      ),
    ).toBe('done');
  });

  it('is in_progress when one repo merged and another is still generating', () => {
    expect(
      taskColumn(
        plan({
          repos: [
            repo({ repository_id: 1, feature_status: 'merged' }),
            repo({ repository_id: 2, feature_status: 'generating' }),
          ],
        }),
      ),
    ).toBe('in_progress');
  });

  it('is in_progress for an approved task with an open unmerged PR', () => {
    expect(
      taskColumn(plan({ repos: [repo({ pr_number: 42, feature_status: 'pr_opened' })] })),
    ).toBe('in_progress');
  });

  it('is in_progress for repo-less planning states waiting on a human', () => {
    for (const status of ['analyzing', 'awaiting_answers', 'plan_ready']) {
      expect(taskColumn(plan({ status }))).toBe('in_progress');
    }
  });
});

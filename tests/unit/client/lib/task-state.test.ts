import { describe, expect, it } from 'vite-plus/test';
import { taskColumn } from '../../../../src/client/lib/task-state.ts';
import type { ApiTaskRepo, ApiTaskSummary } from '../../../../src/client/types.ts';

const repo = (featureStatus: string | null, prNumber: number | null = null): ApiTaskRepo => ({
  repository_id: 1,
  owner: 'acme',
  name: 'app',
  provider: 'github',
  feature_id: 1,
  pr_number: prNumber,
  feature_status: featureStatus,
  feature_error: null,
  verification: null,
});

const task = (repos: ApiTaskRepo[], status = 'completed'): ApiTaskSummary => ({
  id: 1,
  title: 'Ship it',
  status,
  error: null,
  created_at: '2026-09-19T00:00:00.000Z',
  archived: false,
  repos,
});

describe('taskColumn', () => {
  it('keeps delivered work and open pull requests in progress', () => {
    expect(taskColumn(task([repo('completed', 42)]))).toBe('in_progress');
    expect(taskColumn(task([repo('open', 42)]))).toBe('in_progress');
    expect(taskColumn(task([]))).toBe('in_progress');
  });

  it('moves a task to done only after every repository is merged', () => {
    expect(taskColumn(task([repo('merged', 42)]))).toBe('done');
    expect(taskColumn(task([repo('merged', 42), { ...repo('open', 43), repository_id: 2 }]))).toBe(
      'in_progress',
    );
  });
});

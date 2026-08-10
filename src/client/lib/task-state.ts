import type { ApiPlan } from '../../shared/api-types.ts';
import { GENERATION_STOPPED } from './queries.ts';

// One task-state vocabulary for board cards and the task detail page.

export type TaskTone = 'running' | 'on' | 'red' | 'warn' | 'neutral';

export function taskColumn(p: ApiPlan): 'in_progress' | 'done' {
  return p.repos.length > 0 && p.repos.every((r) => r.feature_status === 'merged')
    ? 'done'
    : 'in_progress';
}

export function taskState(p: ApiPlan): { label: string; tone: TaskTone; hint: string } {
  switch (p.status) {
    case 'analyzing':
      return {
        label: 'planning',
        tone: 'running',
        hint: 'analyzing the repo and drafting questions…',
      };
    case 'awaiting_answers':
      return {
        label: 'needs answers',
        tone: 'warn',
        hint: 'answer the clarifying questions to continue',
      };
    case 'refining':
      return { label: 'refining plan', tone: 'running', hint: 'incorporating your answers…' };
    case 'plan_ready':
      return {
        label: 'ready to approve',
        tone: 'warn',
        hint: 'review the plan and approve to generate',
      };
    case 'failed':
      return { label: 'planning failed', tone: 'red', hint: p.error ?? 'planning failed' };
    case 'approved': {
      // Aggregated over every attached repo — done only once ALL of them
      // merged; a stopped/open repo never blocks the others' progress.
      const total = p.repos.length;
      const merged = p.repos.filter((r) => r.feature_status === 'merged').length;
      const stopped = p.repos.filter((r) => GENERATION_STOPPED.has(r.feature_status ?? ''));
      const open = p.repos.filter((r) => r.pr_number && r.feature_status !== 'merged').length;
      if (total > 0 && merged === total) {
        return { label: 'merged', tone: 'on', hint: 'pull request merged' };
      }
      if (stopped.length > 0) {
        return {
          label: `generation stopped (${stopped.length})`,
          tone: 'red',
          hint: stopped[0].feature_error ?? 'generation stopped',
        };
      }
      if (merged > 0) {
        return {
          label: `${merged}/${total} merged`,
          tone: 'on',
          hint: 'some repos are still in flight',
        };
      }
      if (open > 0) {
        return {
          label: `${open}/${total} PRs open`,
          tone: 'on',
          hint: 'pull request(s) open — review and merge',
        };
      }
      return { label: 'generating', tone: 'running', hint: 'the coding agent is working…' };
    }
    default:
      return { label: p.status, tone: 'neutral', hint: '' };
  }
}

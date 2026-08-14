import type { ApiPlan } from '../../shared/api-types.ts';
import { sentence } from './format.ts';
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
        label: 'Planning',
        tone: 'running',
        hint: 'Analyzing the repo and drafting questions…',
      };
    case 'awaiting_answers':
      return {
        label: 'Needs answers',
        tone: 'warn',
        hint: 'Answer the clarifying questions to continue.',
      };
    case 'refining':
      return { label: 'Refining plan', tone: 'running', hint: 'Incorporating your answers…' };
    case 'plan_ready':
      return {
        label: 'Ready to approve',
        tone: 'warn',
        hint: 'Review the plan and approve to generate.',
      };
    case 'failed':
      return { label: 'Planning failed', tone: 'red', hint: p.error ?? 'Planning failed' };
    case 'approved': {
      // Aggregated over every attached repo — done only once ALL of them
      // merged; a stopped/open repo never blocks the others' progress.
      const total = p.repos.length;
      const merged = p.repos.filter((r) => r.feature_status === 'merged').length;
      const stopped = p.repos.filter((r) => GENERATION_STOPPED.has(r.feature_status ?? ''));
      const abandoned = p.repos.filter((r) => r.feature_status === 'abandoned');
      const open = p.repos.filter(
        (r) => r.pr_number && r.feature_status !== 'merged' && r.feature_status !== 'abandoned',
      ).length;
      if (total > 0 && merged === total) {
        return { label: 'Merged', tone: 'on', hint: 'Pull request merged.' };
      }
      if (stopped.length > 0) {
        return {
          label: `Generation stopped (${stopped.length})`,
          tone: 'red',
          hint: stopped[0].feature_error ?? 'Generation stopped',
        };
      }
      if (abandoned.length > 0 && merged === 0 && open === 0) {
        return {
          label: `Abandoned (${abandoned.length})`,
          tone: 'red',
          hint: 'Pull request closed without merging.',
        };
      }
      if (merged > 0) {
        return {
          label: `${merged}/${total} merged`,
          tone: 'on',
          hint: 'Some repos are still in flight.',
        };
      }
      if (open > 0) {
        return {
          label: `${open}/${total} PRs open`,
          tone: 'on',
          hint: 'Pull request(s) open — review and merge.',
        };
      }
      return { label: 'Generating', tone: 'running', hint: 'The coding agent is working…' };
    }
    default:
      return { label: sentence(p.status), tone: 'neutral', hint: '' };
  }
}

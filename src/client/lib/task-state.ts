import type { ApiPlan } from '../../shared/api-types.ts';
import { GENERATION_STOPPED } from './queries.ts';

// One task-state vocabulary for board cards and the task detail page.

export type TaskTone = 'running' | 'on' | 'red' | 'warn' | 'neutral';

export function taskColumn(p: ApiPlan): 'in_progress' | 'done' {
  return p.feature_status === 'merged' ? 'done' : 'in_progress';
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
      if (p.feature_status === 'merged')
        return { label: 'merged', tone: 'on', hint: 'pull request merged' };
      if (p.feature_status === 'pr_closed')
        return {
          label: 'PR closed',
          tone: 'neutral',
          hint: 'the pull request was closed without merging',
        };
      if (GENERATION_STOPPED.has(p.feature_status ?? ''))
        return {
          label: 'generation stopped',
          tone: 'red',
          hint: p.feature_error ?? 'generation stopped',
        };
      if (p.pr_number)
        return {
          label: `PR #${p.pr_number}`,
          tone: 'on',
          hint: 'pull request open — review and merge',
        };
      return { label: 'generating', tone: 'running', hint: 'the coding agent is working…' };
    }
    default:
      return { label: p.status, tone: 'neutral', hint: '' };
  }
}

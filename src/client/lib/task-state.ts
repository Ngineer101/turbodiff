import type { ApiPlan } from '../../shared/api-types.ts';
import type { StageState } from '../components/identity.tsx';
import { sentence } from './format.ts';
import { GENERATION_STOPPED } from './queries.ts';

// One task-state vocabulary for board cards and the task detail page.

export type TaskTone = 'running' | 'on' | 'red' | 'warn' | 'neutral';

// The pill vocabulary for one task: label + tone for the pill itself, hint
// for the line underneath it.
export interface TaskState {
  label: string;
  tone: TaskTone;
  hint: string;
}

// The PLAN → BUILD → VERIFY → SHIP stage lights, aggregated across the
// task's repos. A summary visual, deliberately coarser than taskState's
// label — precise wording stays on the pill, position on the line lives
// here.
export function taskStages(p: ApiPlan): { label: string; state: StageState }[] {
  const plan: StageState =
    p.status === 'failed'
      ? 'failed'
      : p.status === 'awaiting_answers' || p.status === 'plan_ready'
        ? 'attention'
        : p.status === 'approved'
          ? 'done'
          : 'live';

  let build: StageState = 'idle';
  let verify: StageState = 'idle';
  let ship: StageState = 'idle';
  if (p.status === 'approved' && p.repos.length > 0) {
    const stopped = p.repos.some((r) => GENERATION_STOPPED.has(r.feature_status ?? ''));
    const allBuilt = p.repos.every((r) => r.pr_number || r.feature_status === 'merged');
    build = stopped ? 'failed' : allBuilt ? 'done' : 'live';

    if (build === 'done') {
      const allMerged = p.repos.every((r) => r.feature_status === 'merged');
      const anyRunning = p.repos.some((r) => r.verification?.status === 'running');
      const anyFailed = p.repos.some((r) => r.verification?.status === 'failed');
      const allProven = p.repos.every(
        (r) => r.feature_status === 'merged' || r.verification?.status === 'passed',
      );
      verify = anyRunning ? 'live' : anyFailed ? 'attention' : allProven ? 'done' : 'idle';
      ship = allMerged ? 'done' : verify === 'done' ? 'attention' : 'idle';
    }
  }
  return [
    { label: 'Plan', state: plan },
    { label: 'Build', state: build },
    { label: 'Verify', state: verify },
    { label: 'Ship', state: ship },
  ];
}

export function taskColumn(p: ApiPlan): 'in_progress' | 'done' {
  return p.repos.length > 0 && p.repos.every((r) => r.feature_status === 'merged')
    ? 'done'
    : 'in_progress';
}

export function taskState(p: ApiPlan): TaskState {
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

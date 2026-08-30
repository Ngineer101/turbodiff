import {
  LIFECYCLE_STAGES,
  type ChangeCapability,
  type LifecycleDecision,
  type LifecycleScenario,
  type LifecycleStage,
  type ProcessProfileKey,
} from './lifecycle-contract.ts';
import { processProfile } from './process-profiles.ts';

export type LifecycleContext = LifecycleScenario['given'];

function hasCapability(context: LifecycleContext, capability: ChangeCapability): boolean {
  return context.capabilities?.includes(capability) ?? false;
}

function fact(context: LifecycleContext, key: string): boolean {
  return context.facts?.[key] === true;
}

function lastCompletedStage(context: LifecycleContext): LifecycleStage | null {
  const completed = new Set(context.completedStages ?? []);
  let latest: LifecycleStage | null = null;
  for (const stage of LIFECYCLE_STAGES) {
    if (completed.has(stage)) latest = stage;
  }
  return latest;
}

function capabilityDecision(
  stage: LifecycleStage,
  context: LifecycleContext,
): LifecycleDecision | null {
  if (stage === 'review') {
    if (!hasCapability(context, 'read_change')) {
      return { kind: 'handoff', reason: 'provider cannot read the change' };
    }
    if (!hasCapability(context, 'publish_review')) {
      return { kind: 'handoff', reason: 'provider cannot publish a review' };
    }
  }
  if (stage === 'repair' && !hasCapability(context, 'write_head')) {
    return { kind: 'handoff', reason: 'change head is not writable' };
  }
  if (stage === 'verify') {
    if (!fact(context, 'acceptanceContractPresent')) {
      return { kind: 'wait', reason: 'acceptance contract required' };
    }
    if (!hasCapability(context, 'read_change')) {
      return { kind: 'handoff', reason: 'provider cannot read the change' };
    }
  }
  if (
    stage === 'merge' &&
    !hasCapability(context, 'merge') &&
    !hasCapability(context, 'merge_queue')
  ) {
    return { kind: 'handoff', reason: 'merge authority unavailable' };
  }
  return null;
}

function schedule(stage: LifecycleStage, context: LifecycleContext): LifecycleDecision {
  return capabilityDecision(stage, context) ?? { kind: 'schedule', stage };
}

function nextEnabledStage(
  profileKey: ProcessProfileKey,
  after: LifecycleStage,
): LifecycleStage | null {
  const profile = processProfile(profileKey);
  for (const stage of LIFECYCLE_STAGES.slice(LIFECYCLE_STAGES.indexOf(after) + 1)) {
    if (profile.stages[stage].mode !== 'disabled') return stage;
  }
  return null;
}

function mergeDecision(context: LifecycleContext): LifecycleDecision {
  const capability = capabilityDecision('merge', context);
  if (capability) return capability;
  if (fact(context, 'conflict')) return { kind: 'wait', reason: 'change has a merge conflict' };
  if (fact(context, 'externalChecksPending') || context.facts?.externalChecksGreen === false) {
    return { kind: 'wait', reason: 'external checks are not green' };
  }
  return { kind: 'schedule', stage: 'merge' };
}

export function decideLifecycle(
  profileKey: ProcessProfileKey,
  context: LifecycleContext,
): LifecycleDecision {
  if (fact(context, 'eventAlreadyProcessed')) {
    return { kind: 'ignore', reason: 'event already processed' };
  }
  if (
    context.facts?.runStatus === 'completed' ||
    context.facts?.runStatus === 'failed' ||
    context.facts?.runStatus === 'cancelled' ||
    context.facts?.runStatus === 'handed_off'
  ) {
    return { kind: 'ignore', reason: 'run is terminal' };
  }
  if (context.facts?.repositoryEnabled === false) {
    return { kind: 'handoff', reason: 'repository automation disabled' };
  }
  if (context.event === 'human.handoff_requested') {
    return { kind: 'handoff', reason: 'handoff requested by user' };
  }
  if (context.event === 'run.cancelled') return { kind: 'ignore', reason: 'run is terminal' };

  if (context.event === 'human.resume_requested') {
    if (profileKey === 'legacy_factory' && context.origin !== 'factory') {
      return { kind: 'ignore', reason: 'legacy profile admits factory changes only' };
    }
    return schedule(context.startStage, context);
  }
  if (context.event === 'work.requested') return schedule(context.startStage, context);

  if (context.event === 'plan.ready') {
    if (processProfile(profileKey).stages.plan.requireHumanApproval) {
      return { kind: 'wait', reason: 'plan approval required' };
    }
    return schedule('implement', context);
  }
  if (context.event === 'human.approved') {
    const latest = lastCompletedStage(context) ?? context.startStage;
    const next = nextEnabledStage(profileKey, latest);
    return next ? schedule(next, context) : { kind: 'complete' };
  }

  if (context.event === 'change.opened' || context.event === 'change.updated') {
    if (fact(context, 'draft')) return { kind: 'ignore', reason: 'change is draft' };
    if (profileKey === 'idea_to_pr' && (context.completedStages ?? []).includes('publish')) {
      return { kind: 'ignore', reason: 'run responsibility ended at publish' };
    }
    if (profileKey === 'review_on_demand') {
      return { kind: 'ignore', reason: 'review requires an explicit request' };
    }
    if (profileKey === 'legacy_factory' && context.origin !== 'factory') {
      return { kind: 'ignore', reason: 'legacy profile admits factory changes only' };
    }
    if (fact(context, 'draft')) return { kind: 'ignore', reason: 'change is draft' };
    if (context.event === 'change.updated') {
      if (!fact(context, 'headChanged')) return { kind: 'ignore', reason: 'change head unchanged' };
      if (fact(context, 'debounceActive')) {
        return { kind: 'ignore', reason: 'review debounce active' };
      }
    }
    return schedule('review', context);
  }

  if (context.event === 'change.closed') return { kind: 'complete' };

  if (context.event === 'external.checks_updated') return mergeDecision(context);

  if (context.event === 'stage.failed') {
    return { kind: 'wait', reason: 'stage failure requires retry policy evaluation' };
  }

  if (context.event === 'stage.completed') {
    if (fact(context, 'criteriaConflict')) {
      return {
        kind: 'wait',
        reason: 'acceptance criteria conflict requires a human decision',
      };
    }

    const completed = context.completedStages ?? [];
    if (completed.includes(context.stopAfterStage)) {
      return context.stopAfterStage === 'merge'
        ? { kind: 'complete' }
        : { kind: 'handoff', reason: 'requested stop boundary reached' };
    }

    const latest = lastCompletedStage(context);
    if (!latest) return schedule(context.startStage, context);

    if (latest === 'review' && fact(context, 'blockingFindings')) {
      return schedule('repair', context);
    }
    if (latest === 'verify' && context.facts?.verificationPassed === false) {
      if (fact(context, 'repairAttemptsRemaining')) return schedule('repair', context);
      return { kind: 'handoff', reason: 'verification failed and repair policy is exhausted' };
    }
    if (latest === 'verify') return mergeDecision(context);
    if (latest === 'repair') return schedule('review', context);

    const next = nextEnabledStage(profileKey, latest);
    if (!next) return { kind: 'complete' };
    if (next === 'repair') {
      const afterRepair = nextEnabledStage(profileKey, 'repair');
      return afterRepair ? schedule(afterRepair, context) : { kind: 'complete' };
    }
    return schedule(next, context);
  }

  return { kind: 'ignore', reason: 'event is not actionable' };
}

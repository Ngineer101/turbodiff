import {
  type LifecycleStage,
  type ProcessProfileContract,
  type ProcessProfileKey,
  type StagePolicyContract,
  type StageMode,
} from './lifecycle-contract.ts';

function stages(
  modes: Partial<Record<LifecycleStage, StageMode>>,
  approvals: LifecycleStage[] = [],
): ProcessProfileContract['stages'] {
  const policy = (stage: LifecycleStage): StagePolicyContract => {
    const result: StagePolicyContract = { mode: modes[stage] ?? 'disabled' };
    if (approvals.includes(stage)) result.requireHumanApproval = true;
    return result;
  };
  return {
    plan: policy('plan'),
    implement: policy('implement'),
    publish: policy('publish'),
    review: policy('review'),
    repair: policy('repair'),
    verify: policy('verify'),
    merge: policy('merge'),
  };
}

export const PROCESS_PROFILES = {
  review_on_demand: {
    key: 'review_on_demand',
    stages: stages({ review: 'on_demand' }),
  },
  automatic_review: {
    key: 'automatic_review',
    stages: stages({ review: 'automatic' }),
  },
  review_and_repair: {
    key: 'review_and_repair',
    stages: stages({ review: 'automatic', repair: 'automatic' }),
  },
  idea_to_pr: {
    key: 'idea_to_pr',
    stages: stages({ plan: 'on_demand', implement: 'automatic', publish: 'automatic' }, ['plan']),
  },
  assisted_delivery: {
    key: 'assisted_delivery',
    stages: stages(
      {
        plan: 'on_demand',
        implement: 'automatic',
        publish: 'automatic',
        review: 'automatic',
        repair: 'automatic',
        verify: 'automatic',
      },
      ['plan'],
    ),
  },
  full_delivery: {
    key: 'full_delivery',
    stages: stages(
      {
        plan: 'on_demand',
        implement: 'automatic',
        publish: 'automatic',
        review: 'automatic',
        repair: 'automatic',
        verify: 'automatic',
        merge: 'automatic',
      },
      ['plan'],
    ),
  },
  native_turnkey: {
    key: 'native_turnkey',
    stages: stages(
      {
        plan: 'on_demand',
        implement: 'automatic',
        publish: 'automatic',
        review: 'automatic',
        repair: 'automatic',
        verify: 'automatic',
        merge: 'automatic',
      },
      ['plan'],
    ),
  },
  legacy_factory: {
    key: 'legacy_factory',
    stages: stages(
      {
        plan: 'on_demand',
        implement: 'automatic',
        publish: 'automatic',
        review: 'automatic',
        repair: 'automatic',
        verify: 'automatic',
        merge: 'automatic',
      },
      ['plan'],
    ),
  },
} satisfies Record<ProcessProfileKey, ProcessProfileContract>;

export const ADOPTABLE_PROCESS_PROFILE_KEYS = [
  'legacy_factory',
  'review_on_demand',
  'automatic_review',
  'review_and_repair',
] as const satisfies readonly ProcessProfileKey[];

export type AdoptableProcessProfileKey = (typeof ADOPTABLE_PROCESS_PROFILE_KEYS)[number];

export function processProfile(key: ProcessProfileKey): ProcessProfileContract {
  return PROCESS_PROFILES[key];
}

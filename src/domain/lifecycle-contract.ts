// Normative serializable vocabulary for the composable lifecycle. The first
// implementation stack consumes these contracts incrementally; keeping the
// vocabulary here prevents the HTTP, queue, service, and AI layers from
// inventing subtly different stage and decision names.

export const LIFECYCLE_STAGES = [
  'plan',
  'implement',
  'publish',
  'review',
  'repair',
  'verify',
  'merge',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const PROCESS_PROFILE_KEYS = [
  'review_on_demand',
  'automatic_review',
  'review_and_repair',
  'idea_to_pr',
  'assisted_delivery',
  'full_delivery',
  'native_turnkey',
  'legacy_factory',
] as const;

export type ProcessProfileKey = (typeof PROCESS_PROFILE_KEYS)[number];

export type StageMode = 'disabled' | 'on_demand' | 'automatic';
export type RunStatus =
  | 'active'
  | 'awaiting_human'
  | 'handed_off'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ChangeOrigin = 'human' | 'factory' | 'automation' | 'imported';
export type ChangeCapability =
  | 'read_change'
  | 'publish_review'
  | 'write_head'
  | 'publish_check'
  | 'merge'
  | 'merge_queue';

export type LifecycleEventKind =
  | 'work.requested'
  | 'plan.ready'
  | 'human.approved'
  | 'change.opened'
  | 'change.updated'
  | 'change.closed'
  | 'stage.completed'
  | 'stage.failed'
  | 'external.checks_updated'
  | 'human.resume_requested'
  | 'human.handoff_requested'
  | 'run.cancelled';

export type LifecycleDecision =
  | { kind: 'schedule'; stage: LifecycleStage }
  | { kind: 'wait'; reason: string }
  | { kind: 'handoff'; reason: string }
  | { kind: 'complete' }
  | { kind: 'ignore'; reason: string };

export interface StagePolicyContract {
  mode: StageMode;
  requireHumanApproval?: boolean;
  maxAttempts?: number;
}

export interface ProcessProfileContract {
  key: ProcessProfileKey;
  stages: Record<LifecycleStage, StagePolicyContract>;
}

export interface RunStageCommand {
  kind: 'run_stage';
  factoryRunId: number;
  stageRunId: number;
  stage: LifecycleStage;
  changeId?: number;
  idempotencyKey: string;
}

export interface LifecycleScenario {
  id: string;
  description: string;
  profile: ProcessProfileKey;
  given: {
    event: LifecycleEventKind;
    origin: ChangeOrigin;
    startStage: LifecycleStage;
    stopAfterStage: LifecycleStage;
    completedStages?: LifecycleStage[];
    capabilities?: ChangeCapability[];
    facts?: Record<string, boolean | string | number | null>;
  };
  expected: LifecycleDecision;
}

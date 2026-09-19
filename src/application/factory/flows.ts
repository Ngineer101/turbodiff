export type FactoryScope = 'work_item' | 'delivery' | 'change';

export type FactoryStageOperation =
  | 'plan'
  | 'dispatch'
  | 'implement'
  | 'chat'
  | 'review'
  | 'verify'
  | 'repair'
  | 'merge'
  | 'reconcile'
  | 'explain'
  | 'invoke_automation';

export interface FactoryStageDefinition {
  readonly key: string;
  readonly operation: FactoryStageOperation;
  readonly success:
    | { readonly kind: 'complete' }
    | { readonly kind: 'gate'; readonly gate: string; readonly nextStage: string };
}

export interface FactoryFlowDefinition {
  readonly key: string;
  readonly version: number;
  readonly scope: FactoryScope;
  readonly initialStage: string;
  readonly stages: Readonly<Record<string, FactoryStageDefinition>>;
}

export const WORK_ITEM_FLOW = {
  key: 'work_item',
  version: 1,
  scope: 'work_item',
  initialStage: 'plan',
  stages: {
    plan: {
      key: 'plan',
      operation: 'plan',
      success: { kind: 'gate', gate: 'plan_approval', nextStage: 'dispatch' },
    },
    dispatch: {
      key: 'dispatch',
      operation: 'dispatch',
      success: { kind: 'complete' },
    },
  },
} as const satisfies FactoryFlowDefinition;

const DELIVERY_FLOW_V1 = {
  key: 'delivery',
  version: 1,
  scope: 'delivery',
  initialStage: 'implement',
  stages: {
    implement: {
      key: 'implement',
      operation: 'implement',
      success: { kind: 'complete' },
    },
  },
} as const satisfies FactoryFlowDefinition;

export const DELIVERY_FLOW = { ...DELIVERY_FLOW_V1, version: 2 } as const;

export const CHANGE_DELIVERY_FLOW = {
  key: 'change_delivery',
  version: 1,
  scope: 'change',
  initialStage: 'review',
  stages: {
    review: { key: 'review', operation: 'review', success: { kind: 'complete' } },
    verify: { key: 'verify', operation: 'verify', success: { kind: 'complete' } },
    repair: { key: 'repair', operation: 'repair', success: { kind: 'complete' } },
    reconcile: { key: 'reconcile', operation: 'reconcile', success: { kind: 'complete' } },
    merge: { key: 'merge', operation: 'merge', success: { kind: 'complete' } },
  },
} as const satisfies FactoryFlowDefinition;

export const REVIEW_FLOW = {
  key: 'review',
  version: 1,
  scope: 'change',
  initialStage: 'review',
  stages: {
    review: {
      key: 'review',
      operation: 'review',
      success: { kind: 'complete' },
    },
  },
} as const satisfies FactoryFlowDefinition;

export const CHAT_FLOW = {
  key: 'chat',
  version: 1,
  scope: 'delivery',
  initialStage: 'respond',
  stages: {
    respond: { key: 'respond', operation: 'chat', success: { kind: 'complete' } },
  },
} as const satisfies FactoryFlowDefinition;

export const AUTOMATION_FLOW = {
  key: 'automation',
  version: 1,
  scope: 'work_item',
  initialStage: 'invoke',
  stages: {
    invoke: {
      key: 'invoke',
      operation: 'invoke_automation',
      success: { kind: 'complete' },
    },
  },
} as const satisfies FactoryFlowDefinition;

export const EXPLANATION_FLOW = {
  key: 'explanation',
  version: 1,
  scope: 'change',
  initialStage: 'explain',
  stages: {
    explain: {
      key: 'explain',
      operation: 'explain',
      success: { kind: 'complete' },
    },
  },
} as const satisfies FactoryFlowDefinition;

export const FACTORY_FLOWS = [
  WORK_ITEM_FLOW,
  DELIVERY_FLOW_V1,
  DELIVERY_FLOW,
  CHAT_FLOW,
  CHANGE_DELIVERY_FLOW,
  REVIEW_FLOW,
  AUTOMATION_FLOW,
  EXPLANATION_FLOW,
] as const;

export function factoryFlow(key: string, version: number): FactoryFlowDefinition | undefined {
  return FACTORY_FLOWS.find((flow) => flow.key === key && flow.version === version);
}

export function factoryStage(
  flow: FactoryFlowDefinition,
  stageKey: string,
): FactoryStageDefinition | undefined {
  return flow.stages[stageKey];
}

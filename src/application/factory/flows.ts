export interface FactoryFlowDefinition {
  readonly key: string;
  readonly version: number;
  readonly scope: 'work_item' | 'delivery' | 'change';
  readonly initialStage: string;
}

export const DISPATCH_FLOW = {
  key: 'dispatch',
  version: 1,
  scope: 'work_item',
  initialStage: 'dispatch',
} as const satisfies FactoryFlowDefinition;

export const DELIVERY_FLOW = {
  key: 'delivery',
  version: 1,
  scope: 'delivery',
  initialStage: 'implement',
} as const satisfies FactoryFlowDefinition;

export const PLANNING_FLOW = {
  key: 'planning',
  version: 1,
  scope: 'work_item',
  initialStage: 'plan',
} as const satisfies FactoryFlowDefinition;

export const REVIEW_FLOW = {
  key: 'review',
  version: 1,
  scope: 'change',
  initialStage: 'review',
} as const satisfies FactoryFlowDefinition;

export const AUTOMATION_FLOW = {
  key: 'automation',
  version: 1,
  scope: 'work_item',
  initialStage: 'invoke',
} as const satisfies FactoryFlowDefinition;

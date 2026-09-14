import { implementerAgent } from '../agents/implementer.ts';
import { plannerAgent } from '../agents/planner.ts';
import { reviewerAgent } from '../agents/reviewer.ts';

export const AGENT_DEFINITIONS = {
  planner: plannerAgent,
  implementer: implementerAgent,
  reviewer: reviewerAgent,
} as const;

export const BUILTIN_AGENTS = [
  {
    definitionKey: plannerAgent.id,
    slug: 'planner',
    name: 'Planner',
    description: 'Turns a work item into a typed plan artifact.',
    instructionsOverride: null,
  },
  {
    definitionKey: implementerAgent.id,
    slug: 'implementer',
    name: 'Implementer',
    description: 'Produces a repository change artifact for a delivery.',
    instructionsOverride: null,
  },
  {
    definitionKey: reviewerAgent.id,
    slug: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews an immutable change revision and produces a review artifact.',
    instructionsOverride: null,
  },
] as const;

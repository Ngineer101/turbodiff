import { implementerAgent } from '../agents/implementer.ts';
import { plannerAgent } from '../agents/planner.ts';
import { reviewerAgent } from '../agents/reviewer.ts';
import { explainerAgent } from '../agents/explainer.ts';

export const AGENT_DEFINITIONS = {
  planner: plannerAgent,
  implementer: implementerAgent,
  reviewer: reviewerAgent,
  explainer: explainerAgent,
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
  {
    definitionKey: explainerAgent.id,
    slug: 'explainer',
    name: 'Explainer',
    description: 'Explains an immutable change revision as a visual document.',
    instructionsOverride: null,
  },
] as const;

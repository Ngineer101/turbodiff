import { describe, expect, it } from 'vite-plus/test';
import {
  acceptanceContractArtifactSchema,
  planArtifactSchema,
  planningAnalysisArtifactSchema,
} from '../plan.ts';

describe('planner artifacts', () => {
  it('accepts a complete analysis with actionable questions', () => {
    expect(
      planningAnalysisArtifactSchema.parse({
        kind: 'analysis',
        analysis: 'The change belongs in the existing task selector.',
        questions: [
          {
            text: 'Which tasks should count?',
            options: ['Manual tasks only', 'All running tasks'],
            recommended: 'All running tasks',
          },
        ],
        tier: 'standard',
      }),
    ).toMatchObject({ tier: 'standard', questions: [{ recommended: 'All running tasks' }] });
  });

  it('rejects a question whose default is not one of its choices', () => {
    expect(() =>
      planningAnalysisArtifactSchema.parse({
        kind: 'analysis',
        analysis: 'A decision is required.',
        questions: [
          {
            text: 'Which behavior?',
            options: ['A', 'B'],
            recommended: 'C',
          },
        ],
        tier: 'standard',
      }),
    ).toThrow('recommendation must exactly match one option');
  });

  it('enforces the artifact contract for each planning tier', () => {
    expect(() =>
      planArtifactSchema('standard').parse({
        kind: 'plan',
        plan: 'Change the selector.',
        acceptance: [],
        summary: null,
      }),
    ).toThrow('standard plans require a reviewer-facing summary');

    expect(() =>
      planArtifactSchema('trivial').parse({
        kind: 'plan',
        plan: 'Change the selector.',
        acceptance: ['One', 'Two', 'Three', 'Four', 'Five'],
      }),
    ).toThrow('trivial plans may have at most 4 acceptance criteria');
  });

  it('keeps each acceptance contract tied to the plan it was derived from', () => {
    expect(
      acceptanceContractArtifactSchema.parse({
        kind: 'acceptance-contract',
        planArtifactId: 42,
        criteria: ['The endpoint returns the new resource.'],
      }),
    ).toMatchObject({ planArtifactId: 42 });
    expect(() =>
      acceptanceContractArtifactSchema.parse({
        kind: 'acceptance-contract',
        criteria: [],
      }),
    ).toThrow();
  });
});

import { z } from 'zod';

export const PLANNING_TIERS = ['trivial', 'standard'] as const;
export type PlanningTier = (typeof PLANNING_TIERS)[number];

const text = (maxLength: number) => z.string().trim().min(1).max(maxLength);

export const planQuestionSchema = z
  .object({
    text: text(1_000),
    options: z.array(text(500)).min(2).max(3).optional(),
    recommended: text(500).optional(),
  })
  .strict()
  .superRefine((question, context) => {
    if (!question.options) {
      if (question.recommended) {
        context.addIssue({
          code: 'custom',
          message: 'planning question without options cannot have a recommendation',
        });
      }
      return;
    }
    if (new Set(question.options).size !== question.options.length) {
      context.addIssue({ code: 'custom', message: 'planning question options must be unique' });
    }
    if (!question.recommended || !question.options.includes(question.recommended)) {
      context.addIssue({
        code: 'custom',
        message: 'planning question recommendation must exactly match one option',
      });
    }
  });

export type PlanQuestion = z.infer<typeof planQuestionSchema>;

export const planningAnalysisArtifactSchema = z
  .object({
    kind: z.literal('analysis'),
    analysis: text(100_000),
    questions: z.array(planQuestionSchema),
    tier: z.enum(PLANNING_TIERS),
  })
  .strict();

export type PlanningAnalysisArtifact = z.infer<typeof planningAnalysisArtifactSchema>;

const planArtifactBaseSchema = z
  .object({
    kind: z.literal('plan'),
    plan: text(200_000),
    summary: text(20_000).nullable().optional(),
    acceptance: z.array(text(2_000)).max(8),
  })
  .strict();

export function planArtifactSchema(tier: PlanningTier) {
  const acceptanceLimit = tier === 'trivial' ? 4 : 8;
  return planArtifactBaseSchema
    .superRefine((artifact, context) => {
      if (artifact.acceptance.length > acceptanceLimit) {
        context.addIssue({
          code: 'custom',
          message: `${tier} plans may have at most ${acceptanceLimit} acceptance criteria`,
        });
      }
      if (new Set(artifact.acceptance).size !== artifact.acceptance.length) {
        context.addIssue({ code: 'custom', message: 'plan acceptance criteria must be unique' });
      }
      if (tier === 'standard' && artifact.summary == null) {
        context.addIssue({
          code: 'custom',
          message: 'standard plans require a reviewer-facing summary',
        });
      }
    })
    .transform((artifact) => ({ ...artifact, summary: artifact.summary ?? null }));
}

export type PlanArtifact = z.output<ReturnType<typeof planArtifactSchema>>;

export const planFeedbackSchema = z
  .array(
    z
      .object({
        snippet: z.string().trim().max(300),
        comment: text(1_000),
      })
      .strict(),
  )
  .max(20);

export type PlanFeedback = z.infer<typeof planFeedbackSchema>[number];

export function parsePlanFeedback(raw: string | null): PlanFeedback[] {
  if (raw === null) return [];
  return planFeedbackSchema.parse(JSON.parse(raw));
}

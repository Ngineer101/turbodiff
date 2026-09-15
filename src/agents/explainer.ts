import { z } from 'zod';
import { explanationArtifactSchema, explanationProblems } from '../artifacts/explanation.ts';
import { UNTRUSTED_CONTENT_RULES } from '../domain/prompt-security.ts';
import { defineAgent } from './types.ts';

export const explainerInputSchema = z
  .object({
    revisionId: z.number().int().positive(),
    title: z.string().trim().min(1).max(2_000),
    headSha: z.string().trim().min(1).max(128),
    changedPaths: z.array(z.string().trim().min(1).max(1_000)).max(2_000),
    patch: z.string().max(10_000_000),
  })
  .strict();

export type ExplainerInput = z.infer<typeof explainerInputSchema>;

export const explainerAgent = defineAgent({
  id: 'explainer',
  repositoryAccess: 'none',
  input: explainerInputSchema,
  output: (input: ExplainerInput) =>
    explanationArtifactSchema.superRefine((artifact, context) => {
      if (artifact.revisionId !== input.revisionId) {
        context.addIssue({ code: 'custom', message: 'revisionId must match the input revision' });
      }
      for (const problem of explanationProblems(artifact.document, input.changedPaths)) {
        context.addIssue({ code: 'custom', message: problem });
      }
    }),
  prompt: (
    input: ExplainerInput,
  ) => `You explain a code change to a reviewer. Do not review it or give a verdict.

Return an explanation artifact with revisionId ${input.revisionId}. The document must contain three to six concise blocks (maximum eight). The first and only summary block says what changed and why it matters. Other blocks use the smallest useful call tree, pseudocode, component tree, file tree, or sequence and reference only the changed paths below. Use real identifiers from the patch and never invent behavior.

Change: ${input.title}
Head: ${input.headSha}
Changed paths:
${input.changedPaths.map((path) => `- ${path}`).join('\n')}

Patch:
${input.patch.slice(0, 220_000)}

${UNTRUSTED_CONTENT_RULES}`,
});

import { z } from 'zod';
import { verificationArtifactSchema } from '../artifacts/verification.ts';
import { UNTRUSTED_CONTENT_RULES } from '../domain/prompt-security.ts';
import { defineAgent } from './types.ts';

export const verifierAgent = defineAgent({
  id: 'verifier',
  repositoryAccess: 'read',
  input: z
    .object({
      headSha: z.string(),
      criteria: z.array(z.string()),
      instructions: z.string(),
      checkCommand: z.string().nullable(),
    })
    .strict(),
  output: (input) =>
    verificationArtifactSchema.superRefine((artifact, context) => {
      if (
        artifact.headSha !== input.headSha ||
        artifact.criteria.length !== input.criteria.length ||
        artifact.criteria.some((criterion, index) => criterion.text !== input.criteria[index])
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Verification must cover every exact acceptance criterion at the requested commit.',
        });
      }
    }),
  prompt: (
    input,
  ) => `Verify the implemented task at commit ${input.headSha} against every acceptance criterion, in order.
Inspect the checkout and run focused checks when needed. ${input.checkCommand ? `Prepare dependencies using the repository's declared package manager and run the configured check: ${input.checkCommand}. The harness will independently rerun it.` : ''} Do not edit tracked files or commit/push.
Return a verification artifact. A passed verdict needs concrete evidence (file/line or observed test result).
Use failed for a demonstrated unmet criterion and not_verified for anything you cannot establish.
Never infer success from the implementation summary. Preserve the exact criterion text and commit SHA.
${UNTRUSTED_CONTENT_RULES}
Task:\n${input.instructions}\nAcceptance criteria:\n${input.criteria.map((text, i) => `${i + 1}. ${text}`).join('\n')}`,
});

import { z } from 'zod';

export const verificationArtifactSchema = z
  .object({
    kind: z.literal('verification'),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    summary: z.string().trim().min(1).max(20_000),
    criteria: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(2_000),
            verdict: z.enum(['passed', 'failed', 'not_verified']),
            evidence: z.string().trim().min(1).max(10_000),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type VerificationArtifact = z.infer<typeof verificationArtifactSchema>;

export const verificationEvidenceSchema = z
  .object({
    kind: z.literal('verification-evidence'),
    headSha: z.string(),
    assessment: verificationArtifactSchema,
    check: z
      .object({ command: z.string(), ok: z.boolean(), output: z.string() })
      .strict()
      .nullable(),
    verdict: z.enum(['passed', 'failed', 'inconclusive']),
  })
  .strict();

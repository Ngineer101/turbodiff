import { z } from 'zod';

const requiredText = z.string().trim().min(1);

export const reviewFindingSchema = z
  .object({
    path: requiredText.max(1_000),
    line: z.number().int().positive(),
    side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
    startLine: z.number().int().positive().optional(),
    severity: z.enum(['P1', 'P2']).default('P2'),
    body: requiredText.max(4_000),
    evidence: requiredText.max(8_000),
    failurePath: requiredText.max(4_000),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.startLine !== undefined && finding.startLine >= finding.line) {
      context.addIssue({
        code: 'custom',
        path: ['startLine'],
        message: 'startLine must be before line',
      });
    }
  });

export const reviewFileEvidenceSchema = z
  .object({
    path: requiredText.max(1_000),
    disposition: z.enum(['reviewed', 'blocked']),
    evidence: requiredText.max(1_000),
  })
  .strict();

export const reviewArtifactSchema = z
  .object({
    summary: requiredText.max(12_000),
    findings: z.array(reviewFindingSchema).max(100).default([]),
    fileEvidence: z.array(reviewFileEvidenceSchema).max(2_000).default([]),
  })
  .strict()
  .superRefine((artifact, context) => {
    const paths = new Set<string>();
    for (const [index, evidence] of artifact.fileEvidence.entries()) {
      if (paths.has(evidence.path)) {
        context.addIssue({
          code: 'custom',
          path: ['fileEvidence', index, 'path'],
          message: `duplicate file evidence for ${evidence.path}`,
        });
      }
      paths.add(evidence.path);
    }
  });

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewFileEvidence = z.infer<typeof reviewFileEvidenceSchema>;
export type ReviewArtifact = z.infer<typeof reviewArtifactSchema>;

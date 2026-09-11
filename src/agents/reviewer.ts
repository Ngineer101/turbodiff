import { z } from 'zod';
import { reviewArtifactSchema, type ReviewArtifact } from '../artifacts/review.ts';
import { UNTRUSTED_CONTENT_RULES } from '../domain/prompt-security.ts';
import { defineAgent } from './types.ts';

const requiredText = z.string().trim().min(1);

const changedFileSchema = z
  .object({
    path: requiredText.max(1_000),
    reviewable: z.boolean(),
    omittedReason: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const reviewerInputSchema = z
  .object({
    repository: requiredText,
    change: z
      .object({
        title: requiredText,
        description: z.string(),
        base: requiredText,
        head: requiredText,
        revision: requiredText,
        files: z.array(changedFileSchema).max(2_000),
      })
      .strict(),
    focus: z
      .object({
        name: requiredText,
        instructions: requiredText,
      })
      .strict(),
    changedSincePreviousReview: z
      .object({
        revision: requiredText,
        paths: z.array(requiredText.max(1_000)).max(2_000),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ReviewerInput = z.infer<typeof reviewerInputSchema>;

function changedFiles(input: ReviewerInput): string {
  if (input.change.files.length === 0) return '- No changed files were reported.';
  return input.change.files
    .map((file) =>
      file.reviewable
        ? `- ${file.path}`
        : `- ${file.path} (not reviewable: ${file.omittedReason ?? 'omitted'})`,
    )
    .join('\n');
}

function previousReviewDelta(input: ReviewerInput): string {
  const delta = input.changedSincePreviousReview;
  if (!delta) return '';
  const paths = delta.paths.length > 0 ? delta.paths.map((path) => `- ${path}`).join('\n') : '- none';
  return `\n## Change since the previous review\nPrevious revision: ${delta.revision}\nPrioritize these paths, then check any affected interactions:\n${paths}\n`;
}

export const reviewerAgent = defineAgent<ReviewerInput, ReviewArtifact>({
  id: 'reviewer',
  repositoryAccess: 'read',
  input: reviewerInputSchema,
  output: () => reviewArtifactSchema,
  prompt(input) {
    return `You are a precise code-review agent. Review the supplied change in ${input.repository} at revision ${input.change.revision}.

Your review focus is "${input.focus.name}":
${input.focus.instructions}

Inspect the complete supplied patch and the repository checkout. Review only defects introduced by this change and only concerns covered by your focus. Search callers, state writers, tests, and surrounding code when correctness depends on code outside the patch. Actively try to disprove each candidate finding against the actual code. Omit anything speculative, pre-existing, stylistic, or unsupported by a concrete failure path.

Severity:
- P1: a demonstrated defect that must be fixed before merge, with concrete damage.
- P2: a demonstrated defect that should be fixed but does not independently make the change unsafe to merge.
- Do not report minor style or polish feedback.

Return one review artifact:
- summary: 1-3 sentences describing the change and your assessment under this focus. Do not include branding, a finding count, or a publication verdict.
- findings: only supported P1/P2 findings. Anchor each finding to a line visible in the supplied patch. Use RIGHT for the new version and LEFT only for deleted lines. Include private evidence and the reachable failure path.
- fileEvidence: exactly one entry for every reviewable changed path below. Use reviewed with a concise code-specific account of what you checked, or blocked with the concrete reason it could not be assessed.

An empty findings array is valid and preferred over an invented issue.

${UNTRUSTED_CONTENT_RULES}

## Change
Title: ${input.change.title}
Base: ${input.change.base}
Head: ${input.change.head}

${input.change.description || '(no description)'}

## Changed files
${changedFiles(input)}
${previousReviewDelta(input)}`;
  },
});

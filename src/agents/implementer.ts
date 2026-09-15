import { z } from 'zod';
import { repositoryChangeArtifactSchema } from '../artifacts/change.ts';
import { UNTRUSTED_CONTENT_RULES } from '../domain/prompt-security.ts';
import { defineAgent } from './types.ts';

const requiredText = z.string().trim().min(1);
const outputFilesSchema = z
  .object({
    summary: requiredText,
    notes: requiredText,
  })
  .strict();

const checkPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('harness'), command: z.string().nullable() }).strict(),
  z.object({ kind: z.literal('gated'), command: requiredText }).strict(),
  z.object({ kind: z.literal('baseline-failed'), command: requiredText }).strict(),
]);

const implementInputSchema = z
  .object({
    operation: z.literal('implement'),
    repository: requiredText,
    title: requiredText,
    instructions: requiredText,
    scope: z.enum(['small', 'standard']),
    testing: z.enum(['harness-only', 'repository-patterns']),
    noChangeOutcome: z.enum(['allowed', 'unexpected']),
    check: checkPolicySchema,
    outputFiles: outputFilesSchema,
  })
  .strict();

const repairInputSchema = z
  .object({
    operation: z.literal('repair'),
    checkCommand: requiredText,
    checkOutput: z.string(),
    freshSession: z.boolean(),
    originalTaskFile: requiredText,
    outputFiles: outputFilesSchema,
  })
  .strict();

export const implementerInputSchema = z.discriminatedUnion('operation', [
  implementInputSchema,
  repairInputSchema,
]);

export type ImplementerInput = z.infer<typeof implementerInputSchema>;
export type ImplementInput = z.infer<typeof implementInputSchema>;
export type ImplementRepairInput = z.infer<typeof repairInputSchema>;

function checkRule(input: ImplementInput): string {
  switch (input.check.kind) {
    case 'baseline-failed':
      return `- The repository check command (\`${input.check.command}\`) already fails on the base branch. Do not try to fix those pre-existing failures; implement the task and verify your changes by reading them.`;
    case 'gated':
      return `- Dependencies are already installed. Before finishing, run \`${input.check.command}\` and fix failures caused by your changes. Do not fix failures that clearly pre-date this task.`;
    case 'harness':
      return `- Do not run dependency installs, builds, or test suites unless the task itself requires it. The harness${input.check.command ? ` runs \`${input.check.command}\`` : ' performs its configured checks'} after you finish.`;
  }
}

function implementationPrompt(input: ImplementInput): string {
  const testingRule =
    input.testing === 'repository-patterns'
      ? '- If the repository has an established testing pattern, add or update tests for the new behavior in that same pattern.'
      : '- Keep verification proportionate to the requested change.';
  const noChangeRule =
    input.noChangeOutcome === 'allowed'
      ? '- If nothing needs to change, leave the working tree clean; that is a valid outcome.'
      : '- The task is expected to require a change. If the current code already satisfies it, leave the working tree clean rather than manufacturing an edit.';

  return `You are an automated implementation agent working in a fresh checkout of ${input.repository}.

Complete the task below. Rules:
- Implement exactly what the task describes—no scope creep or drive-by refactors.
- Match the repository's existing style, structure, naming, and idioms.
${input.scope === 'small' ? '- This is a small, localized task: make the minimum edits, verify them by reading, and stop.' : testingRule}
${checkRule(input)}
${noChangeRule}
- Do not run git commit or git push; the harness handles git.
- If part of the task is ambiguous, choose the most conventional interpretation and write the choice to ${input.outputFiles.notes}.
- When changes are complete, write ${input.outputFiles.summary}: a concise pull-request description with ${input.scope === 'small' ? '1-3' : '3-6'} bullet points covering what changed and why. Do not restate the task or narrate your process.

${UNTRUSTED_CONTENT_RULES}

## Task: ${input.title}

${input.instructions}
`;
}

function repairPrompt(input: ImplementRepairInput): string {
  const checkOutput = input.checkOutput || '(command exited unsuccessfully without output)';
  return `${input.freshSession ? `Read ${input.originalTaskFile} for the task previously implemented in this checkout.\n\n` : ''}The repository check command (\`${input.checkCommand}\`) failed after your changes:

\`\`\`
${checkOutput}
\`\`\`

Fix only the failures caused by your changes, then re-run the check to confirm. Do not commit, push, or expand the task's scope. If a failure clearly pre-dates the task and cannot be fixed safely, record that in ${input.outputFiles.notes} and stop.

${UNTRUSTED_CONTENT_RULES}
`;
}

export const implementerAgent = defineAgent({
  id: 'implementer',
  repositoryAccess: 'write',
  input: implementerInputSchema,
  output: () => repositoryChangeArtifactSchema,
  prompt(input) {
    return input.operation === 'implement' ? implementationPrompt(input) : repairPrompt(input);
  },
});

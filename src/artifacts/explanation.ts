import { z } from 'zod';

export const explanationRefSchema = z
  .object({
    path: z.string().trim().min(1).max(500),
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
  })
  .strict();

const sketchLineSchema = z
  .object({ text: z.string().max(200), change: z.enum(['+', '-']).optional() })
  .strict();
const blockTitleSchema = z.string().trim().min(1).max(80);
const blockTextSchema = z.string().trim().min(1).max(400);
const refsSchema = z.array(explanationRefSchema).max(6);

const summarySchema = z.object({ kind: z.literal('summary'), text: z.string().min(1).max(1_200) });
const sketchSchema = (kind: 'call_tree' | 'pseudocode' | 'file_tree' | 'component_tree') =>
  z
    .object({
      kind: z.literal(kind),
      title: blockTitleSchema,
      text: blockTextSchema,
      lines: z.array(sketchLineSchema).min(1).max(40),
      refs: refsSchema,
    })
    .strict();
const sequenceSchema = z
  .object({
    kind: z.literal('sequence'),
    title: blockTitleSchema,
    text: blockTextSchema,
    participants: z.array(z.string().trim().min(1).max(24)).min(2).max(5),
    messages: z
      .array(
        z
          .object({
            from: z.string().trim().min(1).max(24),
            to: z.string().trim().min(1).max(24),
            label: z.string().trim().min(1).max(80),
            style: z.enum(['call', 'reply', 'error']).default('call'),
          })
          .strict(),
      )
      .min(1)
      .max(14),
    loop: z
      .object({
        label: z.string().trim().min(1).max(60),
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    refs: refsSchema,
  })
  .strict();

export const explanationBlockSchema = z.discriminatedUnion('kind', [
  summarySchema,
  sketchSchema('call_tree'),
  sketchSchema('pseudocode'),
  sketchSchema('file_tree'),
  sketchSchema('component_tree'),
  sequenceSchema,
]);

export const explanationDocumentSchema = z
  .object({ blocks: z.array(explanationBlockSchema).min(1).max(8) })
  .strict();

export const explanationArtifactSchema = z
  .object({
    kind: z.literal('explanation'),
    revisionId: z.number().int().positive(),
    document: explanationDocumentSchema,
  })
  .strict();

export type ExplanationDocument = z.infer<typeof explanationDocumentSchema>;
export type ExplanationArtifact = z.infer<typeof explanationArtifactSchema>;

export function explanationProblems(
  document: ExplanationDocument,
  changedPaths: readonly string[],
): string[] {
  const problems: string[] = [];
  const knownPaths = new Set(changedPaths);
  if (document.blocks[0]?.kind !== 'summary') problems.push('the first block must be the summary');
  if (document.blocks.filter((block) => block.kind === 'summary').length !== 1) {
    problems.push('exactly one summary block is required');
  }
  document.blocks.forEach((block, index) => {
    if (block.kind === 'summary') return;
    const label = `block ${index + 1}`;
    if (block.refs.length === 0) problems.push(`${label} needs a diff reference`);
    for (const ref of block.refs) {
      if (!knownPaths.has(ref.path)) problems.push(`${label} references unknown file ${ref.path}`);
      if (ref.start !== undefined && ref.end !== undefined && ref.end < ref.start) {
        problems.push(`${label} has an inverted line range`);
      }
    }
    if (block.kind !== 'sequence') return;
    const participants = new Set(block.participants);
    if (participants.size !== block.participants.length) {
      problems.push(`${label} repeats a participant`);
    }
    block.messages.forEach((message, messageIndex) => {
      if (!participants.has(message.from) || !participants.has(message.to)) {
        problems.push(`${label} message ${messageIndex + 1} uses an undeclared participant`);
      }
    });
    if (block.loop && (block.loop.to < block.loop.from || block.loop.to >= block.messages.length)) {
      problems.push(`${label} has an invalid loop range`);
    }
  });
  return problems;
}

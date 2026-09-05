import * as v from 'valibot';
import type { ExplanationDocument } from '../shared/api-types.ts';
import { isJsonObject, type JsonValue } from '../shared/json.ts';

// The Explain tab (docs/explain-tab.md): a show-me
// document for a change — one sentence per block, then the smallest
// code-shape sketch that makes the point, each anchored to the diff lines it
// describes. The Explainer agent emits it through submit_explanation; the
// cockpit renders it beside the raw diff. This module owns the document
// contract (schema, semantic checks, prompt body) so the agent tool, the
// stored jsonb, and the API response all agree on one shape.

export const EXPLAIN_MAX_BLOCKS = 8;
const MAX_SKETCH_LINES = 40;
const MAX_REFS_PER_BLOCK = 6;
const MAX_SEQUENCE_PARTICIPANTS = 5;
const MAX_SEQUENCE_MESSAGES = 14;
// Diff budget sent to the model: the cockpit already caps files at 50 and
// patches at 100k chars; this keeps one request inside a sane context.
export const EXPLAIN_MAX_PATCH_CHARS = 40_000;
export const EXPLAIN_MAX_BODY_CHARS = 220_000;

// A pointer into the Diff tab: a changed file, optionally a new-file line
// range. Every non-summary block carries at least one.
const refSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  start: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  end: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

const sketchLineSchema = v.object({
  text: v.pipe(v.string(), v.maxLength(200)),
  // Diff-shaped sketches mark added/removed lines; unmarked lines are context.
  change: v.optional(v.picklist(['+', '-'])),
});

const blockTitle = v.pipe(v.string(), v.minLength(1), v.maxLength(80));
const blockText = v.pipe(v.string(), v.minLength(1), v.maxLength(400));
const refsSchema = v.pipe(v.array(refSchema), v.maxLength(MAX_REFS_PER_BLOCK));

export const SKETCH_KINDS = ['call_tree', 'pseudocode', 'file_tree', 'component_tree'] as const;
export type SketchKind = (typeof SKETCH_KINDS)[number];

const sketchSchema = <K extends SketchKind>(kind: K) =>
  v.object({
    kind: v.literal(kind),
    title: blockTitle,
    text: blockText,
    lines: v.pipe(v.array(sketchLineSchema), v.minLength(1), v.maxLength(MAX_SKETCH_LINES)),
    refs: refsSchema,
  });

const summarySchema = v.object({
  kind: v.literal('summary'),
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(1_200)),
});

const sequenceMessageSchema = v.object({
  from: v.pipe(v.string(), v.minLength(1), v.maxLength(24)),
  to: v.pipe(v.string(), v.minLength(1), v.maxLength(24)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  style: v.optional(v.picklist(['call', 'reply', 'error']), 'call'),
});

const sequenceSchema = v.object({
  kind: v.literal('sequence'),
  title: blockTitle,
  text: blockText,
  participants: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(24))),
    v.minLength(2),
    v.maxLength(MAX_SEQUENCE_PARTICIPANTS),
  ),
  messages: v.pipe(
    v.array(sequenceMessageSchema),
    v.minLength(1),
    v.maxLength(MAX_SEQUENCE_MESSAGES),
  ),
  // An optional loop bracket around a contiguous run of messages (0-based,
  // inclusive indexes into `messages`).
  loop: v.optional(
    v.object({
      label: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
      from: v.pipe(v.number(), v.integer(), v.minValue(0)),
      to: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
  refs: refsSchema,
});

export const explanationBlockSchema = v.variant('kind', [
  summarySchema,
  sketchSchema('call_tree'),
  sketchSchema('pseudocode'),
  sketchSchema('file_tree'),
  sketchSchema('component_tree'),
  sequenceSchema,
]);

export const explanationDocumentSchema = v.object({
  blocks: v.pipe(v.array(explanationBlockSchema), v.minLength(1), v.maxLength(EXPLAIN_MAX_BLOCKS)),
});

// The wire types live in api-types (dependency-free for the client); the
// schema's output is assigned to them below, so the two cannot drift
// without a type error here.
export type {
  ExplanationBlock,
  ExplanationDocument,
  ExplanationRef,
  ExplanationSequenceBlock,
  ExplanationSketchBlock,
} from '../shared/api-types.ts';

export function explanationFromSchema(
  parsed: v.InferOutput<typeof explanationDocumentSchema>,
): ExplanationDocument {
  return parsed;
}

// Semantic rules the schema alone can't express. Returns human-readable
// problems the agent can act on (the tool rejects with them), or [] when the
// document is sound. `changedPaths` are the diff's files: a ref must point at
// one of them or the Jump link would land nowhere.
export function explanationProblems(
  doc: ExplanationDocument,
  changedPaths: readonly string[],
): string[] {
  const problems: string[] = [];
  const known = new Set(changedPaths);
  if (doc.blocks[0]?.kind !== 'summary') problems.push('the first block must be the summary');
  if (doc.blocks.filter((b) => b.kind === 'summary').length > 1) {
    problems.push('only one summary block is allowed');
  }
  doc.blocks.forEach((block, index) => {
    if (block.kind === 'summary') return;
    const label = `block ${index + 1} (${block.kind} "${block.title}")`;
    if (block.refs.length === 0) problems.push(`${label} needs at least one ref into the diff`);
    for (const ref of block.refs) {
      if (!known.has(ref.path)) {
        problems.push(`${label} refs "${ref.path}", which is not a changed file`);
      }
      if (ref.start !== undefined && ref.end !== undefined && ref.end < ref.start) {
        problems.push(`${label} has a ref whose end line precedes its start line`);
      }
    }
    if (block.kind !== 'sequence') return;
    const participants = new Set(block.participants);
    if (participants.size !== block.participants.length) {
      problems.push(`${label} lists a participant twice`);
    }
    block.messages.forEach((message, i) => {
      if (!participants.has(message.from) || !participants.has(message.to)) {
        problems.push(`${label} message ${i + 1} names a participant that is not declared`);
      }
    });
    if (block.loop) {
      if (block.loop.to < block.loop.from || block.loop.to >= block.messages.length) {
        problems.push(`${label} loop range must cover existing messages in order`);
      }
    }
  });
  return problems;
}

// Stored jsonb -> document. Rows are written only by submit_explanation, but
// the contract may tighten between deploys; a row that no longer parses reads
// as absent rather than crashing the cockpit.
export function parseExplanationDocument(raw: JsonValue | null): ExplanationDocument | null {
  if (!isJsonObject(raw)) return null;
  const parsed = v.safeParse(explanationDocumentSchema, raw);
  return parsed.success ? explanationFromSchema(parsed.output) : null;
}

export interface ExplainFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

// The dispatch body: the change's title and every file's patch, budgeted.
// Files whose patch is missing (binary, renamed, oversized) are listed so the
// model knows they changed without inventing their contents.
export function explanationRequestBody(
  title: string,
  files: readonly ExplainFile[],
  headSha: string,
): string {
  const sections: string[] = [];
  let budget = EXPLAIN_MAX_BODY_CHARS;
  for (const file of files) {
    const header = `### ${file.filename} (${file.status}, +${file.additions} −${file.deletions})`;
    if (file.patch === null) {
      sections.push(`${header}\n[patch not available — binary, renamed, or too large]`);
      continue;
    }
    let patch = file.patch;
    if (patch.length > EXPLAIN_MAX_PATCH_CHARS) {
      patch = `${patch.slice(0, EXPLAIN_MAX_PATCH_CHARS)}\n[turbodiff: patch truncated at ${EXPLAIN_MAX_PATCH_CHARS} characters of ${file.patch.length}]`;
    }
    const section = `${header}\n\`\`\`diff\n${patch}\n\`\`\``;
    if (section.length > budget) {
      sections.push(`${header}\n[turbodiff: omitted — request budget exhausted]`);
      continue;
    }
    budget -= section.length;
    sections.push(section);
  }
  return (
    `Explain the change "${title}" at head ${headSha.slice(0, 12)} and submit the document with submit_explanation.\n\n` +
    `Changed files (${files.length}):\n${files.map((f) => `- ${f.filename}`).join('\n')}\n\n` +
    sections.join('\n\n')
  );
}

// One agent instance per explanation row, so a regenerate never resumes the
// earlier conversation (the document must stand on the current diff alone).
export function explainInstanceId(featureId: number, headSha: string, nonce: string): string {
  return `explain--${featureId}--${headSha.slice(0, 12)}--${nonce}`.toLowerCase();
}

export const EXPLAIN_INSTANCE_PREFIX = 'explain--';

export function isExplainInstanceId(instanceId: string): boolean {
  return instanceId.startsWith(EXPLAIN_INSTANCE_PREFIX);
}

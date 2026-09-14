import { defineTool } from '@flue/runtime';
import {
  explanationDocumentSchema,
  explanationFromSchema,
  explanationProblems,
} from '../../domain/explain.ts';

export const makeSubmitExplanation = (changedPaths: readonly string[]) =>
  defineTool({
    name: 'submit_explanation',
    description:
      'Store the finished explanation for the change. Call exactly once. The first block must be ' +
      'the summary; every other block needs at least one ref to a changed file (with new-file ' +
      'line numbers when the sketch describes a specific hunk). If the call is rejected, fix the ' +
      'listed problems and call again.',
    input: explanationDocumentSchema,
    async run({ data }) {
      const document = explanationFromSchema(data);
      const problems = explanationProblems(document, changedPaths);
      if (problems.length > 0) {
        throw new Error(
          `explanation rejected — fix these and resubmit:\n- ${problems.join('\n- ')}\n\n` +
            `Changed files: ${changedPaths.join(', ')}`,
        );
      }
      return { output: JSON.stringify({ artifact: document }) };
    },
  });

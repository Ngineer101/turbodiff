import { defineTool } from '@flue/runtime';
import { completeExplanation } from '../../data/db.ts';
import {
  explanationDocumentSchema,
  explanationFromSchema,
  explanationProblems,
} from '../../domain/explain.ts';
import { notifyFeatureLive } from '../../services/live-updates.ts';

// The Explainer agent's one output channel. Closes over the instance id so a
// regenerate can never complete the row of the run it replaced, and over the
// diff's file list so every Jump ref is checked against real paths before
// the document is stored. Semantic problems are returned as an error the
// model can act on; a stored document is always sound.
export const makeSubmitExplanation = (
  agentInstanceId: string,
  featureId: number,
  changedPaths: readonly string[],
) =>
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
      const row = await completeExplanation(agentInstanceId, document);
      if (!row) {
        throw new Error('this explanation run is no longer open (replaced or already submitted)');
      }
      await notifyFeatureLive(featureId);
      return { output: { stored: true, blocks: document.blocks.length } };
    },
  });

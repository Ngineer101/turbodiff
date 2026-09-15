import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ARTIFACTS_NAMESPACE } from '../../integrations/git/provider.ts';
import { parseArtifactsEvent } from '../../shared/artifacts-events.ts';
import { applyArtifactsEvent } from './artifacts.ts';

// Workflow-backed ingestion for Artifacts repository events.
export class ArtifactsEventsWorkflow extends WorkflowEntrypoint<unknown, unknown> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<string> {
    const parsed = parseArtifactsEvent(event.payload);
    if (!parsed) {
      console.warn(
        'turbodiff: unparseable artifacts event:',
        JSON.stringify(event.payload).slice(0, 500),
      );
      return 'unparseable';
    }
    // Belt and braces with the config-level namespace filter.
    if (parsed.namespace !== ARTIFACTS_NAMESPACE) return 'foreign namespace';

    return await step.do(
      `apply ${parsed.type} for ${parsed.repoName}`,
      { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' },
      () => applyArtifactsEvent(parsed),
    );
  }
}

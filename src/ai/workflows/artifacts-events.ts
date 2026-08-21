import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ARTIFACTS_NAMESPACE } from '../../integrations/git/provider.ts';
import { applyArtifactsEvent } from '../../services/artifacts.ts';
import { parseArtifactsEvent } from '../../shared/artifacts-events.ts';

// Artifacts event ingestion (docs/artifacts-provider.md). The platform
// starts one instance per event via the `triggers.events` entries in
// wrangler.jsonc — the native replacement for GitHub webhooks: declarative,
// per-namespace (no per-repo subscription provisioning), delivered with
// Workflow durability. Unparseable or foreign events return instead of
// throwing so the engine never retry-loops on them.
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

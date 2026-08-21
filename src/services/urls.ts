import { env } from 'cloudflare:workers';

// Absolute cockpit URLs embedded outside the SPA (PR/CR comments, review
// dispatch bodies, certificates). One builder so the route shape can never
// drift per call site.
export function cockpitFeatureUrl(featureId: number): string {
  return `${env.PUBLIC_BASE_URL}/factory/features/${featureId}`;
}

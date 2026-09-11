import { env } from 'cloudflare:workers';

export function cockpitFeatureUrl(featureId: number): string {
  return `${env.PUBLIC_BASE_URL}/factory/features/${featureId}`;
}

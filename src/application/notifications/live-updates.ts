import { env } from 'cloudflare:workers';
import type { LiveUpdates } from '../../live-updates.ts';

export async function notifyOrganizationsLive(organizationIds: readonly string[]): Promise<void> {
  const ids = [...new Set(organizationIds)];
  if (ids.length === 0) return;
  // SAFETY: wrangler.jsonc binds LIVE_UPDATES to the LiveUpdates class.
  const namespace = env.LIVE_UPDATES as DurableObjectNamespace<LiveUpdates>;
  await Promise.all(ids.map((id) => namespace.getByName(id).broadcast()));
}

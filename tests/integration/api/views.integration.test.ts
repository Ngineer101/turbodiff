import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { createEffectApiHandler } from '../../../src/api/server/handler.ts';
import { createWorkItem, createDeliveries } from '../../../src/data/work.ts';
import { execute } from '../../../src/data/postgres.ts';
import { getSessionAccess } from '../../../src/data/session-access.ts';
import { apiDependencies, createTenant, rollbackAfter } from './support.ts';

describe('factory read views', () => {
  it('returns a complete authorized delivery view with one authentication, and denies another tenant', () =>
    rollbackAfter(async () => {
      const owner = await createTenant();
      const stranger = await createTenant();
      const item = await createWorkItem({
        organizationId: owner.organizationId,
        title: 'Delivery',
        description: 'Read view',
        origin: 'idea',
        repositoryIds: [owner.repositoryId],
      });
      const [delivery] = await createDeliveries(item);
      let authenticated = 0;
      let user = owner.user;
      const handle = createEffectApiHandler(
        apiDependencies([], async () => {
          authenticated++;
          return user;
        }),
      );
      const response = await handle(
        new Request(`https://app.test/api/deliveries/${delivery!.id}/view`),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        delivery: { id: delivery!.id },
        workItem: { id: item.id, title: 'Delivery' },
        plan: null,
        revision: null,
        factoryRuns: [],
      });
      expect(authenticated).toBe(1);
      user = stranger.user;
      expect(
        (await handle(new Request(`https://app.test/api/deliveries/${delivery!.id}/view`))).status,
      ).toBe(404);
      expect(
        (await handle(new Request(`https://app.test/api/work-items/${item.id}/view`))).status,
      ).toBe(404);
      const list = await handle(new Request('https://app.test/api/work-item-views'));
      expect(await list.json()).toEqual({ items: [] });
    }));

  it('reflects membership revocation immediately without a cached authorization decision', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      expect(await getSessionAccess(tenant.userId, null)).toMatchObject({
        organization_ids: [tenant.organizationId],
        github_connected: true,
        has_unclaimed: false,
      });
      await execute(sql`DELETE FROM auth.member WHERE "userId" = ${tenant.userId}`);
      expect(await getSessionAccess(tenant.userId, null)).toEqual({
        organization_ids: [],
        github_connected: false,
        has_unclaimed: false,
      });
    }));
});

import { sql } from 'drizzle-orm';
import { execute, queryRows } from './database.ts';

export interface PushSubscriptionRow {
  id: number;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export async function upsertPushSubscription(
  userId: string,
  subscription: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  await execute(sql`
    INSERT INTO app.push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (${userId}, ${subscription.endpoint}, ${subscription.p256dh}, ${subscription.auth})
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `);
}

export async function deletePushSubscription(userId: string, endpoint: string): Promise<void> {
  await execute(sql`
    DELETE FROM app.push_subscriptions WHERE user_id = ${userId} AND endpoint = ${endpoint}
  `);
}

export async function listPushSubscriptions(userIds: string[]): Promise<PushSubscriptionRow[]> {
  if (userIds.length === 0) return [];
  return queryRows<PushSubscriptionRow>(sql`
    SELECT * FROM app.push_subscriptions WHERE user_id = ANY(${userIds}::text[])
  `);
}

export async function deletePushSubscriptionByEndpoint(endpoint: string): Promise<void> {
  await execute(sql`DELETE FROM app.push_subscriptions WHERE endpoint = ${endpoint}`);
}

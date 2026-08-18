import {
  buildPushPayload,
  type PushSubscription as WebPushSubscription,
} from '@block65/webcrypto-web-push';
import { env } from 'cloudflare:workers';
import {
  deletePushSubscriptionById,
  getPlan,
  listPushSubscriptionsForUser,
  type PushSubscriptionRow,
} from './db.ts';

// Server-side Web Push sending, isolated from planner.ts so a notification
// failure can never affect plan state — every entry point here fails open
// (catches its own errors) rather than throwing.

export type PushSendResult = 'sent' | 'gone' | 'error';

export async function sendPushToSubscription(
  sub: PushSubscriptionRow,
  payload: { title: string; body: string; url: string },
): Promise<PushSendResult> {
  try {
    const subscription: WebPushSubscription = {
      endpoint: sub.endpoint,
      expirationTime: null,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    const init = await buildPushPayload({ data: payload }, subscription, {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    });
    const res = await fetch(sub.endpoint, init);
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'error';
  } catch (err) {
    console.error('turbodiff: push send failed for subscription', sub.id, err);
    return 'error';
  }
}

// Pushes to every stored subscription of the plan's creator. No-ops for
// operator/API-created plans (no created_by_id to resolve). Never throws —
// a planner call site never needs its own error handling around this.
export async function notifyPlanUsers(
  planId: number,
  payload: { title: string; body: string; url: string },
): Promise<void> {
  try {
    const plan = await getPlan(planId);
    if (!plan || plan.created_by_id === null) return;
    const subs = await listPushSubscriptionsForUser(plan.created_by_id);
    const results = await Promise.all(
      subs.map(async (sub) => ({ sub, result: await sendPushToSubscription(sub, payload) })),
    );
    await Promise.all(
      results
        .filter(({ result }) => result === 'gone')
        .map(({ sub }) => deletePushSubscriptionById(sub.id)),
    );
  } catch (err) {
    console.error('turbodiff: notifyPlanUsers failed for plan', planId, err);
  }
}

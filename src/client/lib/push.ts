// Thin Web Push helpers, mirroring the thin-wrapper style of ./api.ts.

import { api } from './api.ts';

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  return navigator.serviceWorker.register('/sw.js');
}

// Standard base64url -> Uint8Array conversion for applicationServerKey (the
// VAPID public key arrives as base64url from /api/me; PushManager.subscribe
// needs a Uint8Array).
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64safe);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// Every failure mode below used to collapse into a bare `false`, which the
// settings toggle reported as "permission was not granted" no matter what
// actually broke. Only the permission denial returns false now; everything
// else throws with a message the toggle can show verbatim.
export async function subscribeToPush(vapidPublicKey: string): Promise<boolean> {
  if (!pushSupported()) throw new Error('This browser has no Push API support');
  // An unset VAPID_PUBLIC_KEY var reaches the client as '', and subscribing
  // with an empty applicationServerKey fails deep inside the browser with an
  // opaque DOMException — name the real cause instead.
  if (!vapidPublicKey) {
    throw new Error('Push is not configured on this server (VAPID_PUBLIC_KEY is unset)');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  // register() is idempotent; `ready` then waits for an *active* worker,
  // which pushManager.subscribe() needs.
  await registerServiceWorker();
  const registration = await navigator.serviceWorker.ready;

  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  } catch (err) {
    throw new Error(
      `The browser refused the push subscription: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await api.post('/api/push/subscribe', subscription.toJSON());
  return true;
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

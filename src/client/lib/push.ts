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

export async function subscribeToPush(vapidPublicKey: string): Promise<boolean> {
  if (!pushSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const registration =
    (await navigator.serviceWorker.getRegistration()) ?? (await registerServiceWorker());
  if (!registration) return false;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
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

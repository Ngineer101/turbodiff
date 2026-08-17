// Plain (unbundled) service worker — served byte-for-byte as a static asset,
// no vite build step touches public/. Registered at the origin root so its
// default scope (/) covers every route, letting notificationclick reach any
// /tasks/:id.

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Turbodiff', {
      body: data.body || '',
      icon: '/logo-small.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      const existing = all.find((c) => c.url === url);
      if (existing) return existing.focus();
      return clients.openWindow(url);
    }),
  );
});

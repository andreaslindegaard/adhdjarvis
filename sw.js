const CACHE_NAME = 'adhd-jarvis-v57';

// Install: skip waiting immediately to take over
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: delete ALL old caches and take control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) =>
        Promise.all(cacheNames.map((name) => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: ALWAYS network-first for same-origin, no caching of JS/HTML
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-only for Firebase/Google API calls
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('firebaseio.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first for ALL same-origin requests
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(fetch(event.request));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification?.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            client.navigate(targetUrl).catch(() => {});
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        return undefined;
      })
  );
});

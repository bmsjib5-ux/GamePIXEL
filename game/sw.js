// Service worker: lets Edge / Chrome install the game as an app.
// It passes every request straight to the network (no caching), so a new version of the
// game is always picked up as before.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

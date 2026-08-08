// AgentHub service worker: web push display + deep link.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'AgentHub', body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'AgentHub', {
    body: data.body || '',
    tag: data.taskId || 'agenthub',
    data,
    badge: undefined,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  const url = taskId ? `/#/task/${taskId}` : '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      if ('focus' in c) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

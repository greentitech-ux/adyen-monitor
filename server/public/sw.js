// sw.js - service worker: recebe push do servidor e mostra a notificacao
// (com som padrao do sistema) mesmo com a aba fechada.

self.addEventListener('push', (event) => {
  let data = { title: 'Monitor Adyen', body: 'Novo evento' };
  try {
    data = event.data.json();
  } catch (e) {
    /* usa o padrao acima */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag,
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

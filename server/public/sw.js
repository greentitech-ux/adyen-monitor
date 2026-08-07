// sw.js - service worker: recebe push do servidor e mostra a notificacao
// (com som padrao do sistema) mesmo com a aba fechada.

self.addEventListener('push', (event) => {
  let data = { title: 'Zenith Ops', body: 'Novo evento' };
  try {
    data = event.data.json();
  } catch (e) {
    /* usa o padrao acima */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: data.tag,
      vibrate: [200, 100, 200],
      silent: false,
      renotify: true,
      requireInteraction: true, // fica na tela ate a pessoa interagir, em vez de sumir sozinha em poucos segundos
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

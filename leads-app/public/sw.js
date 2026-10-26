// OPERA Leads: service worker da app instalável. Só trata das notificações no telemóvel; não guarda nada em cache,
// para que cada versão publicada chegue logo a toda a gente.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Aviso vindo da função leads-notify: { title, body, url, tag }.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "OPERA Leads", body: event.data?.text() ?? "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "OPERA Leads", {
    body: data.body || "",
    icon: "/leads/icon-192.png",
    badge: "/leads/badge-96.png",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || "/leads/" },
  }));
});

// Tocar na notificação: abre a lead ou a conversa na app já aberta, ou abre a app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/leads/", self.location.origin);
  // O link vem com o endereço do ambiente; aqui fica sempre o desta app.
  const url = new URL(`/leads/${target.search}`, self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).pathname.startsWith("/leads"));
    if (win) {
      await win.focus();
      win.postMessage({ type: "abrir", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

const CACHE = "territory-static-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/manifest.webmanifest", "/territory-icon.svg"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (
    !url.pathname.startsWith("/_next/static/")
    && url.pathname !== "/manifest.webmanifest"
    && url.pathname !== "/territory-icon.svg"
    && !url.pathname.startsWith("/icon-")
  ) return;

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  })));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Territory", body: event.data?.text() ?? "Your league has an update." };
  }

  event.waitUntil(self.registration.showNotification(payload.title || "Territory", {
    body: payload.body || "Your league has an update.",
    icon: "/territory-icon.svg",
    badge: "/territory-icon.svg",
    tag: payload.tag || "territory-update",
    renotify: true,
    data: payload.data || { url: "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.navigate(target);
        return client.focus();
      }
    }
    return clients.openWindow(target);
  })());
});

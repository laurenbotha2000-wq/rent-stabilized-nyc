// Offline app shell. Listing data is never cached here: it comes from
// Firestore and requires sign-in.
const CACHE = "shell-v4";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/map.js", "/prefs.js", "/commute.js", "/stations.json", "/config.js",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Saved-search alerts sent by scripts/notify.mjs: { title, body, url, tag }
self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || "Rent Stabilized NYC", {
    body: m.body || "New apartments match your saved search.",
    tag: m.tag, renotify: Boolean(m.tag),
    icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
    data: { url: m.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", location.origin);
  if (url.origin !== location.origin) return; // only ever open this site
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => new URL(w.url).origin === location.origin);
    return open ? open.focus() : self.clients.openWindow(url.href);
  }));
});

// Same-origin shell files: network first, cache as fallback (so updates show up
// right away, and the app still opens offline).
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/__/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html")))
  );
});

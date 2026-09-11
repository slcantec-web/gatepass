const CACHE_NAME = "gatepass-shell-v4";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/css/main.css",
  "/css/dashboard.css",
  "/css/mobile.css",
  "/js/app.js",
  "/js/auth.js",
  "/js/api.js",
  "/js/qr.js",
  "/js/dashboard.js",
  "/js/settings.js",
  "/js/gatepass.js",
  "/js/approvals.js",
  "/js/movement.js",
  "/js/security.js",
  "/js/employees.js",
  "/js/locations.js",
  "/js/reports.js",
  "/js/users.js",
  "/js/assisted.js",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // NEVER intercept API calls: gate/movement transactions must always hit the
  // live server and never be silently queued for later replay (spec section 23).
  if (url.pathname.startsWith("/api/")) {
    return; // let it go straight to the network
  }

  // Network-first, cache as offline fallback only. Prefer a fresh copy
  // whenever the device is online - this is an actively-changing admin app,
  // not a static brochure site, so staleness is worse than an extra fetch.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

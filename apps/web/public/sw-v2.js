const CACHE_PREFIX = "honor-pilot";
const CACHE_VERSION = "2026-07-12-v2";
const CACHE_NAME = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const DATA_MANIFEST = "/data/manifest.json";
const CORE_ASSETS = ["/manifest.webmanifest", "/icon.svg", "/search-worker.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => refreshDataset())
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function refreshDataset(request = new Request(DATA_MANIFEST, { cache: "no-store" })) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const manifestResponse = await fetch(request, { cache: "no-store" });
    if (!manifestResponse.ok) throw new Error("manifest fetch failed");
    const manifest = await manifestResponse.clone().json();
    if (!manifest.indexUrl || !/^[a-f0-9]{64}$/i.test(manifest.sha256 ?? "")) {
      throw new Error("manifest schema invalid");
    }

    const indexResponse = await fetch(manifest.indexUrl, { cache: "no-cache" });
    if (!indexResponse.ok) throw new Error("index fetch failed");
    const indexText = await indexResponse.clone().text();
    if (await sha256Hex(indexText) !== manifest.sha256) throw new Error("index checksum mismatch");

    await cache.put(manifest.indexUrl, indexResponse);
    await cache.put(DATA_MANIFEST, manifestResponse.clone());
    return manifestResponse;
  } catch {
    return (await cache.match(DATA_MANIFEST)) ?? Response.error();
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === DATA_MANIFEST) {
    event.respondWith(refreshDataset(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.includes("/search-index.") ||
    CORE_ASSETS.includes(url.pathname)
  ) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener("push", (event) => {
  const payload = event.data?.json?.() ?? {
    title: "병역명문가 혜택 변경",
    body: "팔로우한 혜택에 새로운 변경이 있습니다."
  };
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag ?? "honor-benefit-change",
      data: { url: payload.url ?? "/" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url ?? "/"));
});

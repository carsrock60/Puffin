const CACHE_NAME = "puffin-shell-v6";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/puffin-180.png",
  "/icons/puffin-192.png",
  "/icons/puffin-512.png",
];

async function cacheModuleGraph(cache, moduleUrl, visited = new Set()) {
  if (visited.has(moduleUrl)) return;
  visited.add(moduleUrl);

  const response = await fetch(moduleUrl);
  if (!response.ok) throw new Error(`Could not cache app module: ${moduleUrl}`);

  const source = await response.clone().text();
  await cache.put(moduleUrl, response);

  const importPaths = Array.from(
    source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g),
    (match) => match[1],
  );

  await Promise.all(importPaths.map((importPath) => {
    const importUrl = new URL(importPath, moduleUrl);
    if (importUrl.origin !== self.location.origin) return Promise.resolve();
    return cacheModuleGraph(cache, importUrl.href, visited);
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);

    const indexResponse = await fetch("/index.html");
    const indexHtml = await indexResponse.text();
    const assetUrls = [];
    const moduleUrls = [];

    for (const match of indexHtml.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      const tag = match[0];
      const isModuleScript = /<script\b/i.test(tag) && /\btype=["']module["']/i.test(tag);
      const isStylesheet = /<link\b/i.test(tag)
        && (/\brel=["']stylesheet["']/i.test(tag) || /\brel=["']modulepreload["']/i.test(tag));
      if (!isModuleScript && !isStylesheet) continue;

      const assetPath = tag.match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
      if (!assetPath) continue;

      const assetUrl = new URL(assetPath, self.location.origin);
      if (assetUrl.origin !== self.location.origin) continue;
      if (isModuleScript) moduleUrls.push(assetUrl.href);
      else assetUrls.push(assetUrl.href);
    }

    await cache.addAll([...new Set(assetUrls)]);
    const visitedModules = new Set();
    await Promise.all(moduleUrls.map((moduleUrl) => cacheModuleGraph(cache, moduleUrl, visitedModules)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith("puffin-shell-") && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);

  if (request.method !== "GET" || requestUrl.origin !== self.location.origin) return;

  const isNavigation = request.mode === "navigate";
  const isAppShellAsset = APP_SHELL.includes(requestUrl.pathname)
    || request.destination === "script"
    || request.destination === "style";
  if (!isNavigation && !isAppShellAsset) return;

  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response.ok) {
          await caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) return cachedResponse;

        if (isNavigation) {
          const cachedApp = await caches.match("/index.html");
          if (cachedApp) return cachedApp;
        }

        return new Response("Puffin is offline and this item is not cached yet.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }),
  );
});

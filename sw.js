// Service worker: lets the page install as an app and open quickly, even with a weak signal.
//
//  - The page itself (HTML, CSS, JavaScript, icons) is cached when the app is first opened.
//  - data/repeaters.json is served from the cache straight away and refreshed in the background,
//    so a new data file shows up the second time you open the app.
//  - Leaflet and leaflet-rotate (from the CDNs) are cached after their first download.
//  - Map tiles and address lookups always go to the network, they are not cached here.
//
// Change VERSION to throw away everything cached by an older copy of this file.

const VERSION = "v1";
const SHELL_CACHE = `au-radio-map-shell-${VERSION}`;
const RUNTIME_CACHE = `au-radio-map-runtime-${VERSION}`;

const SHELL_FILES = [
    "./",
    "index.html",
    "style.css",
    "app.js",
    "manifest.webmanifest",
    "icons/icon.svg",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/apple-touch-icon.png",
];
const CDN_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net"];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) =>
            // One missing file shouldn't stop the install, so add them one at a time
            Promise.all(SHELL_FILES.map((file) => cache.add(file).catch(() => {})))
        )
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names
                        .filter((name) => name.startsWith("au-radio-map-") && name !== SHELL_CACHE && name !== RUNTIME_CACHE)
                        .map((name) => caches.delete(name))
                )
            )
            .then(() => self.clients.claim())
    );
});

// Answer from the cache now, and refresh the cached copy in the background
async function staleWhileRevalidate(event, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(event.request);
    const refresh = fetch(event.request)
        .then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
        })
        .catch(() => null);
    event.waitUntil(refresh);
    return cached || (await refresh) || Response.error();
}

// Files that never change at a given address (versioned CDN files): the cache wins
async function cacheFirst(request) {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") cache.put(request, response.clone());
    return response;
}

// Opening the app: try the network so updates arrive, fall back to the cached page when offline
async function networkFirstPage(event) {
    try {
        const response = await fetch(event.request);
        if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put("index.html", response.clone());
        }
        return response;
    } catch (error) {
        return (await caches.match("index.html")) || (await caches.match("./")) || Response.error();
    }
}

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);

    if (url.origin === self.location.origin) {
        if (request.mode === "navigate") {
            event.respondWith(networkFirstPage(event));
        } else {
            event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
        }
    } else if (CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request));
    }
    // Anything else (map tiles, address search) is left to the browser
});

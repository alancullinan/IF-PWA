/*
 * Service worker.
 *
 * EVERY PATH HERE IS RELATIVE. This app is served from a subpath
 * (…github.io/IF-PWA/). A root-absolute '/index.html' would resolve to the
 * ORIGIN root - one level above the app, a URL we do not own. That matters
 * more than it looks: cache.addAll() is atomic, so a single unreachable entry
 * rejects the whole install and the app silently has no offline support at
 * all. Worse, if something does answer at the origin root, we would cache a
 * stranger's page as our offline shell.
 *
 * Relative URLs inside a service worker resolve against the WORKER's location
 * (…/IF-PWA/sw.js), so './index.html' is …/IF-PWA/index.html. They also work
 * unchanged at a domain root, so moving to a real domain later needs no edits.
 */

// Bump together with the ?v= strings in index.html on every deploy. Neither
// alone is enough: caches.match() keys on the full URL including the query.
const CACHE_NAME = 'fasting-v0.3.5';

// The version the HTML asks for in its ?v= strings. Derived from CACHE_NAME so
// the two cannot drift apart.
const VERSION = CACHE_NAME.slice('fasting-v'.length);

// './' and './index.html' are DISTINCT cache keys, and GitHub Pages serves the
// bare directory URL from index.html, so both are precached.
const PRECACHE = [
  './',
  './index.html',
  // Cached under the exact URLs the HTML requests, so an offline launch right
  // after a deploy still finds them.
  './script.js?v=' + VERSION,
  './styles.css?v=' + VERSION,
  './manifest.json',
  './fonts/outfit.woff2',
  './icons/icon-72x72.png',
  './icons/icon-96x96.png',
  './icons/icon-128x128.png',
  './icons/icon-144x144.png',
  './icons/icon-152x152.png',
  './icons/icon-192x192.png',
  './icons/icon-384x384.png',
  './icons/icon-512x512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  /*
   * Navigations go NETWORK-FIRST.
   *
   * index.html is the only file naming the current ?v= asset URLs, so serving
   * a stale copy pins the app to the old release permanently: the new HTML is
   * never fetched, so its new ?v= strings are never requested, so a deploy can
   * never take effect. Cache-first here is a trap that only shows up on an
   * upgrade, never on a fresh install.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        // Offline: fall back to whatever shell we hold. caches.match() returns
        // a promise, so these must be chained - `a || b` would always take `a`.
        .catch(() => caches.match('./index.html')
          .then((r) => r || caches.match('./')))
    );
    return;
  }

  /*
   * Assets are cache-first, matched on the EXACT url - query string included.
   *
   * This used to pass ignoreSearch, which was a trap. The HTML is network-first
   * so a deploy's new index.html arrives immediately, asking for
   * script.js?v=NEW - but ignoreSearch matched that against the OLD bare
   * script.js still in the cache, so the app kept running the previous release
   * no matter how many times it was relaunched. The only escape was the worker
   * itself updating and wiping the cache, and when that did not happen on a
   * real iPhone the app was stuck for good.
   *
   * Matching exactly makes a version bump self-healing: a new ?v= simply misses
   * the cache and is fetched, whatever the worker is doing. The cost is one
   * network fetch per changed asset per deploy, which is unavoidable anyway -
   * the file changed.
   */
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});

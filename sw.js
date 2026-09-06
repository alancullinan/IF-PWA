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
const CACHE_NAME = 'fasting-v0.3.3';

// './' and './index.html' are DISTINCT cache keys, and GitHub Pages serves the
// bare directory URL from index.html, so both are precached.
const PRECACHE = [
  './',
  './index.html',
  './script.js',
  './styles.css',
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
   * Assets are cache-first with ignoreSearch.
   *
   * The HTML requests script.js/styles.css with a ?v= cache-buster while the
   * precache stores them bare; without ignoreSearch the precached copies never
   * match and every launch goes to the network. Safe because a deploy ships a
   * new CACHE_NAME, so activate() wipes these entries, and the navigation above
   * guarantees the HTML itself is fresh.
   */
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
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

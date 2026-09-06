---
name: pwa-traps
description: Production failure modes for Progressive Web Apps - service worker caching and upgrade paths, iOS viewport and safe-area layout, offline behaviour, and the tests that catch them. Use this whenever building, deploying or debugging a PWA, a service worker, a web app manifest, or an offline-capable web app - and especially when a symptom sounds like "the app won't update", "it works online but not offline", "it says it's on the latest version but isn't", "the layout is fine in the browser but wrong on my phone", or "the nav bar sits too high". Also use when adding offline support or an installable manifest to an existing site, or when writing tests for any of that. These failures are almost all invisible on a fresh install and on a desktop browser, so reach for this before hand-rolling a service worker.
---

# PWA production traps

Everything here comes from shipping two vanilla PWAs to real iPhones. Each item
cost real debugging time — usually several wrong fixes first — and they share a
shape worth naming up front:

> **The dangerous PWA bugs are invisible where you test and only appear where
> you don't.** They pass on a fresh install, on desktop, and in a headless
> browser, then fail on a device that already has an old worker, old cached
> assets, or a real notch.

So the recurring advice is: test the *upgrade* path rather than the fresh
install, and get the device to *report* what it sees rather than inferring it.

**Platform note.** The iOS behaviour below was verified on iPhone 15 Pro,
iOS 26, September 2026. Web platform behaviour changes; if something here
contradicts what a device is actually reporting, believe the device and update
this file.

---

## 1. Caching and the upgrade path

### Never match cached assets with `ignoreSearch`

This is the worst of the lot, and it is a tempting optimisation.

If the HTML requests `script.js?v=NEW` and the cache is matched with
`{ ignoreSearch: true }`, it matches the **old bare `script.js`** still in the
cache. Network-first HTML arrives updated, but the asset it names keeps
resolving to the previous release. The app is pinned to a stale version, and
relaunching never fixes it.

The usual defence — "a deploy ships a new `CACHE_NAME` and `activate()` wipes
the old entries" — only holds *if the worker updates*. When it doesn't, the app
is stuck permanently with no user-visible way out.

```js
// Self-healing: a new ?v= misses the cache and is fetched, whatever the
// worker is doing.
caches.match(request).then((cached) => cached || fetchAndCache(request));
```

Precache the **versioned** URLs (derive the version from `CACHE_NAME` so they
cannot drift) so an offline launch straight after a deploy still resolves.

### Navigations go network-first

The HTML is the only file naming the current asset URLs. Serve a stale copy and
the new `?v=` strings are never requested, so a deploy can never take effect.
Fall back to the cached shell only when the network fails.

### `cache.addAll()` is atomic

One unreachable entry rejects the **entire** install, and the app silently has
no offline support while looking perfect online. This is how a single wrong path
disables offline completely.

### Under a subpath, every path must be relative

Deploying to `example.github.io/my-app/` rather than a domain root? A leading
slash resolves to the **origin root**, above the app. Inside a service worker,
relative URLs resolve against the worker's own location, so `'./index.html'` is
correct and also works unchanged at a domain root — the reverse is not true.

Register relatively too: `register('sw.js')` takes a default scope of the
worker's directory, which is what you want.

### An update check must ask the server, not the worker

Reading `registration.installing` / `.waiting` after `update()` cannot tell
"nothing new" from "already done" — because `skipWaiting()` leaves both `null`
in the **success** case too. A check written that way reports "you are on the
latest version" while sitting on a stale build, which actively misleads whoever
is debugging.

Fetch the worker script and read its version out directly:

```js
const res = await fetch('sw.js?probe=' + Date.now(), { cache: 'no-store' });
const deployed = (await res.text()).match(/CACHE_NAME = '([^']+)'/)?.[1];
```

Register with `updateViaCache: 'none'` as well — many static hosts serve the
worker with a `max-age`, and a worker answered from the HTTP cache looks
unchanged, so no update is ever detected.

### Ship a data-safe escape hatch

Unregister every worker and delete every cache, then reload. Leave IndexedDB
alone, so a wedged install is recoverable **without** costing the user their
data. The alternative advice — "delete the app and reinstall" — destroys it.

### Cache-busting is two-sided, so check it statically

`caches.match()` keys on the full URL including the query string, so the cache
version and the `?v=` strings in the HTML must agree. Nothing at runtime can
detect a mismatch (the worker cannot read the HTML), and forgetting one is the
mistake a person actually makes. A three-line test comparing them turns it into
a red test instead of a stale app on someone's phone.

---

## 2. iOS viewport and safe area

### The three ways of saying "full height" disagree

This one cost four rounds of fixing a layout that was already correct.

| Expression | What it resolves to |
|---|---|
| `height: 100vh` | the **large** viewport — the whole screen. Usually what you want. |
| `position: fixed; inset: 0` | the **visual** viewport — measured 793pt on an 852pt screen |
| `height: 100%` | a box that already excludes the status bar |

Size the shell to the wrong one and a strip of screen is never drawn on. The
symptom is a tab bar that "floats too high" no matter how the margins are
tuned — because the margins were right and the window was short.

A combination proven on hardware: `black-translucent` status bar,
`viewport-fit=cover`, and a shell sized with `100vh`.

### One owner per safe-area edge

Apply the top inset to the element that meets the top, the bottom inset to the
element that meets the bottom, and never to `body` as well. Applying it twice
doubles it — a 34pt home indicator becomes 58pt of dead space, taken out of the
view above it.

### Clamp the inset; do not trust it

A device reported a bottom inset near 93pt. Cap it at the tallest home
indicator that exists, and floor it for phones reporting nothing:

```css
margin-bottom: clamp(8px, env(safe-area-inset-bottom), 34px);
```

### `env()` is only readable through a real element

There is no `getComputedStyle` shortcut. Create a probe element with
`padding-top: env(safe-area-inset-top)` and read its computed padding. And
measure it **when the screen is shown**, not once at startup — iOS has not
settled the viewport by the time `init` runs, and an early read reports values
that were never true.

### Stop the shell scrolling

`overflow: hidden` and `overscroll-behavior: none` on the shell, with each
scrollable view using `overscroll-behavior: contain`. Otherwise a drag anywhere
rubber-bands the whole app, and a view that fits still bounces.

---

## 3. Storage

### One store. Never two.

Writing localStorage-first with an IndexedDB fallback, while *reading*
localStorage-first, produces silent data loss: once localStorage hits quota the
stores diverge, new records land in IndexedDB, and every launch returns the
older localStorage copy. Nothing throws. Assert in a test that saving writes
nothing to localStorage — a single store cannot have that bug.

### A save must report whether it worked

Return a real boolean and tell the user when a write fails. Swallowing the error
makes failure indistinguishable from success, which is how data loss starts.

### Persistence is not durability

`navigator.storage.persist()` reduces eviction risk; it does not prevent it.
iOS clears storage for sites unused about a week, and nothing in a PWA's
IndexedDB reliably follows the user to new hardware. **An export is the only
copy that survives a new phone** — so if the app holds anything the user would
miss, build export/import early, not last.

### Timers are derived, never accumulated

Store the start timestamp and compute `Date.now() - startedAt` on every render;
let `setInterval` drive the display only. Any counter the app increments will
drift when the page is throttled, reset when the app is killed, or double-count
if a resume path runs twice — and each failure produces a plausible wrong number
rather than an error.

---

## 4. Sharing and files

`navigator.share()` should be passed `files` and **nothing else**. iOS "Save to
Files" materialises any `title` or `text` as its own document, leaving a stray
file beside every export.

A dismissed share sheet rejects with `AbortError`. That is a **cancellation, not
a success** — recording it as a completed export makes the app claim a backup
that never left the device.

Sandboxed contexts often block script-driven downloads, so treat `<a download>`
as a fallback rather than the primary path.

---

## 5. Dates

If the app buckets anything by day, derive the day from **local** date
components, never by slicing `toISOString()`. That is UTC, and it files an
evening event under the following day for any timezone ahead of UTC — for half
the year in Europe, permanently further east.

```js
const startOfLocalDay = (ts) => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
```

Run the tests in a real timezone (`page.emulateTimezone('Europe/Dublin')`) so a
UTC-shaped bug cannot hide behind a UTC test environment.

---

## 6. Testing

`references/testing.md` has the harness pattern and the specific suites worth
writing, with code. Read it when setting up tests for a PWA.

The short version:

- **Test the upgrade path, not the fresh install.** Install an old release,
  deploy a new one over it, assert the client ends up running the new code.
  Every serious caching bug is invisible on a clean install.
- **Also test that a deploy lands when the worker does NOT update** — leave the
  worker byte-identical, change only the HTML and the asset it names.
- **Write a layout suite.** Every functional test passes happily on an app whose
  primary button cannot be reached. Check fit and reachability across several
  phone sizes with safe-area insets injected, since `env()` reports 0 in
  headless browsers.
- **Add static checks for what runtime cannot see** — version agreement, which
  element owns which inset, how the shell is sized. These symptoms are invisible
  to geometric tests because the app measures itself as correct.
- **Verify each test fails against the bug it guards.** Assertions pass
  vacuously more often than you would think — an "every cached URL is under our
  scope" check passes trivially when the cache is empty, which is the exact
  failure it was written for.
- Serve a **temp copy** of the app, never the working tree, so an interrupted
  run cannot modify your files.

---

## 7. Debugging on a device you cannot inspect

Remote-debugging someone's phone is usually not available. Two things that work
far better than reasoning from a description:

**Build a diagnostics readout into the app.** A line in a settings screen
showing the running version, `innerWidth`×`innerHeight`, the measured insets,
and whether it is running installed or in a browser. Guessing at those values
produced three wrong fixes in a row; one screenshot of that line ended it.

**Measure the screenshot.** A screenshot is a precise instrument — load it into
a canvas, scan for the element's colour, and get exact pixel positions. Dividing
by the device pixel ratio gives points, and comparing that against the app's own
reported viewport height distinguishes "the CSS is wrong" from "the window is
the wrong size". Those need completely different fixes.

And when a working app on the same hardware solves the same problem, read its
source before theorising. That beat three rounds of inference.

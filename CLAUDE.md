# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project Overview

A personal intermittent fasting PWA. Vanilla JS, no build step, no runtime
dependencies, no backend, no accounts. Built for one person's own use; friends
or family may be given the URL, and that is the whole distribution plan.

Deployed to **https://alancullinan.github.io/IF-PWA/** — a GitHub Pages
**subpath**, not a domain root. That single fact drives several rules below.

Background reading: `docs/RESEARCH.md` (why the app is scoped as it is) and
`docs/PLAN.md` (the build order and what is deliberately deferred).

## Development Commands

- **Run locally**: any static server, but it must be served from a `/IF-PWA/`
  subpath to match production. `python -m http.server` from the parent
  directory works.
- **Tests**: `npm install` once, then `npm test` runs all eight suites.
  Individually: `npm run test:offline|storage|timer|history|stats|backup|layout|upgrade`.
  Puppeteer is the only dependency and is test tooling — nothing from
  `node_modules` is ever served to a browser.
- **Deploy**: push to `main`. GitHub Pages builds automatically; there is no
  build step. Work happens on a feature branch and is fast-forwarded to `main`
  as a deliberate act, so a half-finished phase never lands on a phone.

## Deploy discipline: bump three versions together

`CACHE_NAME` in `sw.js`, the `?v=` strings in `index.html`, and `APP_VERSION`
in `script.js` must always agree. `caches.match()` keys on the full URL
including the query string, so bumping one and not the others can serve a stale
asset. Nothing at runtime can detect the mismatch — `sw.js` cannot read
`index.html` — so `test/upgrade.test.js` checks it statically. A one-sided bump
is a red test rather than a stale app on a phone that is awkward to debug.

## Rules that came from real failures

Each of these cost real time. None is theoretical.

### Every path is relative. No leading slashes, anywhere.

Under a subpath, `/index.html` resolves to the **origin root**, above the app.
`cache.addAll()` is atomic, so one such entry rejects the whole install and the
app silently has no offline support — while looking perfect online. Relative
paths also work unchanged at a domain root, so this survives a later move; the
reverse is not true. Pinned by `test/offline.test.js`.

### Never match cached assets with `ignoreSearch`.

This is the worst bug the project had. With `ignoreSearch`, a request for
`script.js?v=NEW` matches the **old bare** `script.js` in the cache. The HTML is
network-first and does arrive updated, but the asset it names keeps resolving to
the previous release, so relaunching changes nothing — for good, if the worker
does not update. It looks like a broken deploy and is not.

Matching on the exact URL makes a version bump self-healing: a new `?v=` misses
the cache and is fetched, whatever the worker is doing. The precache stores the
**versioned** URLs so an offline launch straight after a deploy still works.
`test/upgrade.test.js` pins this with sw.js left byte-identical.

### The three ways of saying "full height" disagree on iOS.

- `100vh` — the **large** viewport, the whole screen. **Use this.**
- `position: fixed; inset: 0` — the **visual** viewport. Measured at 793pt on
  an 852pt iPhone 15 Pro, leaving a 59pt strip the app never drew on.
- `height: 100%` — resolves against a box that already excludes the status bar.

The shell is `height: 100vh` with `black-translucent` and `viewport-fit=cover`,
which is what MatchTracker uses and what demonstrably fills the screen on the
same handset. Four rounds of margin tuning were spent before this was found;
the CSS was correct the whole time and the window was the wrong size.

### Safe-area insets: one owner per edge, and clamp the value.

The top inset belongs to `.view`, the bottom to `.tabbar`. Applying either to
`body` as well double-counts it. And do not trust the reported number: this
phone reported a bottom inset near 93pt, so the margin is
`clamp(8px, env(safe-area-inset-bottom), 34px)` — floored for phones reporting
nothing, capped at the tallest home indicator there is.

### An update check must ask the server, not the worker.

Reading `registration.installing`/`.waiting` after `update()` cannot tell
"nothing new" from "already done", because `skipWaiting()` leaves both null in
the success case too. It reported "you are on the latest version" while sitting
on a stale build. `fetchDeployedVersion()` fetches `sw.js` with `no-store` and
reads `CACHE_NAME` out of it. `forceRefresh()` is the escape hatch: it drops
every worker and cache but leaves IndexedDB alone, so a wedged install is
recoverable **without** losing recorded fasts.

### One storage store. Never two.

The reference app wrote localStorage-first and read localStorage-first across
two independent stores; once localStorage hit quota they diverged silently and
recent records vanished. `test/storage.test.js` asserts that saving writes
**nothing** to localStorage. `saveData()` returns a real boolean and shows the
user a notice when a write fails — a swallowed error makes failure
indistinguishable from success.

### Elapsed time is derived, never accumulated.

`(endedAt ?? Date.now()) - startedAt`, recomputed on every render.
`setInterval` drives the display only. A fast runs 16–24+ hours across screen
locks, backgrounding, force quits and reboots; any counter the app increments
would drift, reset or double-count, and each failure yields a plausible wrong
number rather than an error.

### A fast belongs to the local day it STARTED on.

A 16:8 fast normally crosses midnight. Attributing by the end moves most fasts
to the following day, and deriving the day from `toISOString()` (UTC) files an
Irish fast begun after 23:00 under tomorrow for half the year. Use
`startOfLocalDay()`. `test/stats.test.js` runs in `Europe/Dublin` so a
UTC-shaped bug cannot hide behind the test environment's timezone.

### Share sheet: `files` only, and a dismissal is not a backup.

iOS "Save to Files" materialises any `title` or `text` as its own document,
leaving a stray file beside every backup — so `navigator.share()` is passed
`files` and nothing else. A dismissed sheet rejects with `AbortError` and is a
**cancellation**; recording it would make the staleness line claim a backup
that never left the device.

## Testing

Eight suites, all Puppeteer against a temp copy of the repo served from a
`/IF-PWA/` subpath. They never serve the working tree.

The organising principle: **test the upgrade path, not the fresh install.**
Every serious bug here was invisible on a clean install and only appeared on a
device that already held data or an older worker.

`test/layout.test.js` is its own category and worth keeping. Every functional
suite passed happily on an app whose primary button could not be reached
without scrolling. It checks fit and reachability across six phone sizes with
safe-area insets injected (`env()` reports 0 in headless), plus static checks
for the shell-sizing and inset rules above, since those symptoms are invisible
to any geometric test — the app measures itself as correct.

When fixing a bug, **verify the test fails against the bug** before trusting
it. Several assertions here passed vacuously until that was checked.

## Architecture

Single IIFE in `script.js` (~1,470 lines). Four views toggled by `showView()`:
timer, history, stats, settings. Sheets (edit fast, import) follow one pattern:
cancel left, title centre, action right.

`window.__ifTest` at the bottom of `script.js` is the test seam — deliberately
small, exposing behaviour under test rather than the whole module.

### Data

IndexedDB via `StorageManager` (`FastingDB` / `records`, keyed by `key`).
Storage keys: `fasts`, `weights`, `settings`, `lastBackupAt`.

```javascript
// fasts
{ id, startedAt, endedAt: null while running, goalHours, planId, editedAt }
// weights (not yet surfaced in the UI)
{ id, at, kg }
// settings
{ activePlanId }
```

Room is deliberately left for `mood`/`energy`/`hunger`/`note` on a fast if the
journal is ever wanted; optional fields need no migration.

## Design

"Soft Circadian": `#12142A` ground, `#1A1D3C` cards, `#EDEBFF` text,
`#A9A6D8` secondary, `#8D8AC4` muted, `#FFB37A` accent, Outfit 300–600
self-hosted as one variable font so the first offline launch renders correctly.

Two things checked rather than eyeballed, and worth rechecking if the palette
moves: muted text clears AA at 11px on the card surface, and the heatmap ramp
is monotonic in luminance so a darker cell always means a shorter fast.

Outcomes are never colour alone — a missed goal says "Short by 2h 00m" rather
than turning red. Stage timings are stated as approximations in the UI itself,
because the hour boundaries are typical rather than measured and the app should
not imply otherwise. Icons are inline SVG, never emoji. `tools/make-icons.py`
generates the app icons with no image library.

## Not built

The weight logging UI is the only unbuilt phase; `docs/PLAN.md` has it, and the
`weights` store and its data shape already exist. Deliberately out of scope for
good: notifications (impossible to schedule from a PWA — use the
phone's own alarms), food logging, AI coaching, accounts, Health app sync.

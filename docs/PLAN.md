# Implementation Plan — Intermittent Fasting PWA

Companion to `docs/RESEARCH.md`. Decisions there are settled; this is the build order.

**Settled:** personal use · subpath hosting · metric only · no notifications ·
no journal · no share cards · no water tracking · no food logging · no accounts,
no server.

> **MatchTracker is reference-only.** It is a working app in daily use, and it stays
> exactly as it is. Every "port from MatchTracker" below means *read it and copy the
> code into this repo* — never edit, refactor, extract or "improve" anything in the
> MatchTrackerPWA working tree, and never make a shared library of the common parts.
> A little duplication between the two apps is the correct trade: it keeps a change
> here from being able to break a match on a Sunday.

---

## 0. The subpath constraint — get this right first

Deploying to `https://alancullinan.github.io/IF-PWA/` rather than a domain root is the
one decision that touches files we cannot easily fix later, because a service worker
that has cached the wrong paths is exactly the failure that is invisible until it is
maddening.

MatchTracker precaches **root-absolute** paths (`/index.html`, `/script.js`). Under a
subpath those resolve to `alancullinan.github.io/index.html` — outside our scope,
owned by nothing, and the SW install silently fails or caches garbage.

**Rule: every path in the project is relative. No leading slashes, anywhere.**

| File | Root-absolute (MatchTracker) | Subpath-safe (here) |
|---|---|---|
| `sw.js` precache list | `'/index.html'` | `'./index.html'` |
| `sw.js` nav fallback | `caches.match('/index.html')` | `caches.match('./index.html')` |
| `manifest.json` | `"start_url": "/"`, `"scope": "/"` | `"start_url": "./"`, `"scope": "./"` |
| `manifest.json` icons | `"icons/icon-192.png"` | unchanged — already relative |
| `index.html` manifest link | `href="/manifest.json"` | `href="manifest.json"` |
| SW registration | `register('/sw.js')` | `register('sw.js')` |

Why relative works: inside `sw.js`, relative URLs resolve against the worker's own
location (`/IF-PWA/sw.js`), so `'./index.html'` → `/IF-PWA/index.html`. Registering
`'sw.js'` from `/IF-PWA/index.html` gives the worker a default scope of `/IF-PWA/`,
which is exactly what we want.

**Bonus:** relative paths work at a domain root *too*. If this ever moves to its own
domain, nothing needs changing — which is not true in the other direction.

**Gotchas to watch:**
- `./` and `./index.html` are **two distinct cache keys**. GitHub Pages serves
  `/IF-PWA/` from `index.html`, so a navigation to the bare directory URL must find a
  cached entry. Precache both, and have the navigation handler write its copy under a
  single agreed key.
- No `<base href>`. It interacts badly with relative SW paths; just keep everything
  relative and consistent.
- GitHub Pages project sites have no SPA fallback, but we are a single page, so this
  never arises.

### Phase 0 acceptance
Install to iPhone Home Screen from the subpath URL, go into airplane mode, relaunch,
and the app must load. Nothing else is worth building until this is true.

---

## 1. Scaffold and storage

Port from MatchTracker — copied out, renamed and stripped, leaving that repo untouched:

- `index.html`, `styles.css` (+ `tailwind-minimal.css`), `script.js` as a single IIFE.
- `StorageManager` — copy verbatim, change `DB_NAME` to `FastingDB`, store to `fasts`.
  **No localStorage migration path**: there is no legacy data, so that whole function
  and its `MIGRATED_FLAG` are dropped. Single store from line one.
- `manifest.json`, icon set via `create-icons.html`, self-hosted fonts.
- `package.json` + `test/` with `sw-upgrade.test.js` and `storage.test.js` ported.
  Puppeteer stays the only dependency, and nothing from `node_modules` is ever served.
- The `window.__ifTest` seam at the bottom of `script.js` so tests can reach inside
  the IIFE (MatchTracker's `window.__mtTest`).

**Cache discipline, from day one:** bumping `CACHE_NAME` in `sw.js` *and* the `?v=`
query strings on `script.js`/`styles.css` in `index.html` are both required. Neither
alone works — `caches.match()` keys on the full URL including the query string.

---

## 2. Core timer

The heart of the app, and much simpler than MatchTracker's.

```javascript
// A fast has no pause and no periods. Elapsed time is DERIVED, never accumulated.
elapsedMs = (fast.endedAt ?? Date.now()) - fast.startedAt;
```

`setInterval` drives the *display only* — it never touches stored state. A fast runs
16-24+ hours across screen locks, app kills and reboots; on relaunch we recompute from
`startedAt` and are automatically correct. This is MatchTracker's
`periodStartTimestamp` lesson, and it matters far more here.

- Start / end a fast. One active fast at a time (`endedAt === null`).
- Plan presets: 12:12, 14:10, 16:8, 18:6, 20:4, OMAD. Plus custom hours.
- Progress ring (SVG `stroke-dasharray`).
- **Over-goal state:** the ring caps at 100% but the clock keeps counting, showing
  e.g. `17:12 / 16:00` in a distinct colour. Fasting past goal is normal and the UI
  should treat it as success, not as an error.

### Data model
```javascript
// fasts
{
  id: "1757155200000-482913",
  startedAt: 1757155200000,   // ms epoch
  endedAt: null,              // ms epoch, or null while running
  goalHours: 16,
  planId: "16-8",             // or "custom"
  editedAt: null              // set if a timestamp was adjusted after the fact
}

// weights
{ id, at: 1757155200000, kg: 78.4 }

// settings
{ activePlanId, lastBackupAt }
```
Storage keys: `fasts`, `weights`, `settings`, `lastBackupAt`.

Room is deliberately left for `mood`/`energy`/`hunger`/`note` on a fast if the journal
is ever wanted — adding optional fields later needs no migration.

---

## 3. History and editing

**Edit start/end time is the single most-used feature after the timer**, because
forgetting to hit start is the normal case. It deserves first-class UI, not a buried
long-press.

- Adjust the running fast's `startedAt` ("I actually started at 8pm").
- Edit or delete any past fast.
- History list, newest first: date, duration, goal, hit/missed.
- Set `editedAt` on any adjustment so history stays honest.

**Validation worth having:** reject `endedAt < startedAt`, and warn on overlapping
fasts rather than silently allowing them.

---

## 4. Backup — export and import

**Promoted from last to first-after-usable.** Export is the only thing that survives a
device change, and it was originally scheduled behind four features that are merely
nice to look at. That was the wrong order: stats and heatmaps are worthless if the
underlying history did not make it onto the new phone.

It cannot come earlier than this — there has to be data before there is anything to
export — but it comes the moment the app is genuinely usable.

Port `DataManager` from MatchTracker: JSON export via the share sheet with an
`<a download>` fallback, plus import.

Two rules that came from real bugs and must survive the port:
- **`navigator.share({ files })` only.** Never pass `title` or `text` — iOS "Save to
  Files" materialises string fields as a stray extra document, leaving a file named
  "Text" beside every backup.
- **A dismissed share sheet is not a backup.** `navigator.share()` rejects with
  `AbortError` when the sheet is dismissed; recording that as a backup would make the
  staleness indicator claim a backup that never left the device.

**Import matters as much as export here.** A phone change is export on the old device,
import on the new one — a one-way export is half a feature. The new device starts
empty, so the simple "replace everything behind a confirmation" import noted earlier
is exactly the right shape for the migration case; MatchTracker's three-way
new/identical/conflicting analysis solves a problem (two devices diverging) that a
single-user single-device app does not have.

**Export is the only real backup.** iOS evicts storage for sites unused ~7 days,
`navigator.storage.persist()` does not fully prevent it, and nothing in a PWA's
IndexedDB reliably follows you to a new handset. The app should surface
`lastBackupAt` and nag when it goes stale.

**Steer the destination.** The share sheet will happily send the backup to a chat app,
where it is one conversation-clear away from gone. The copy should point at "Save to
Files" / iCloud Drive, which is the option that is actually reachable from the next
phone.

---

## 5. Stats and heatmap

- Current streak, longest fast, 7/30-day average duration, goal-completion rate.
- Calendar heatmap, GitHub-contributions style. Very cheap, very legible.

**Date bucketing:** a 16:8 fast normally crosses midnight, so a fast belongs to the
**local date of `startedAt`**. Compute from local date parts, never by slicing an ISO
string — that is UTC and will put evening fasts on the wrong day. Ireland observes DST;
because durations are derived from epoch timestamps they are unaffected, but *day
bucketing* is local and must be done deliberately.

---

## 6. Weight log

Manual entry only — HealthKit is unreachable from the web (see `RESEARCH.md` §3).
List of entries plus an SVG trend line. Metric only.

---

## 7. Metabolic stage timeline — BUILT

Stage boundaries are marked on the ring itself, which costs no vertical space on
a screen that only just fits, and the stage card opens a sheet listing the whole
sequence: past stages with the clock time they passed, the current one as "now",
and upcoming ones as how far off they are.

Upcoming stages are relative rather than clock times on purpose. A 24h stage on
a fast begun at 00:06 also reads 00:06, which looks like a bug rather than
tomorrow - and "how long until ketosis" is the question being asked anyway.

The sheet closes with a line noting these are typical timings and not a
measurement. Not a legal disclaimer - just so I don't end up believing my own UI.

---

## Build order

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | Scaffold + relative paths + SW | Installs and runs offline from the subpath |
| 1 | Storage + tests | `sw-upgrade` and `storage` suites pass |
| 2 | Timer, plans, progress ring | Survives a force-quit mid-fast |
| 3 | History + time editing | Can fix a forgotten start |
| 4 | **Export / import** | **Round-trips a backup onto a different device** |
| 5 | Stats + heatmap | — |
| 6 | Weight log | — |
| 7 | Stage timeline | Done |

Phases 0-4 are the app. Everything after is worth having but not load-bearing.

Phase 4's gate is deliberately a *different device*, not a round-trip on the same one:
an export that only reimports where it was written has not been tested against the
thing it exists for.

Estimated ~1,000-1,500 lines of `script.js`, against MatchTracker's ~8,900.

---

## Deferred

Notifications, journal, water, share cards, food logging, units toggle, Health sync,
accounts. Rationale for each is in `RESEARCH.md`.

---

## Note: MatchTracker data and the phone change

Unrelated to this app, but the same deadline. MatchTracker's real match history lives
in IndexedDB on the current handset, and PWA storage does not reliably follow you to a
new phone. Its export already exists and is tested (`test/backup.test.js`) — Home →
**Export / Import** → **Export All Matches** → Save to Files. Worth doing before the
migration, not after.

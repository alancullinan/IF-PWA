# Implementation Plan — Intermittent Fasting PWA

Companion to `docs/RESEARCH.md`. Decisions there are settled; this is the build order.

**Settled:** personal use · subpath hosting · metric only · no notifications ·
no journal · no share cards · no water tracking · no food logging · no accounts,
no server.

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

Port from MatchTracker, renamed and stripped:

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

## 4. Stats and heatmap

- Current streak, longest fast, 7/30-day average duration, goal-completion rate.
- Calendar heatmap, GitHub-contributions style. Very cheap, very legible.

**Date bucketing:** a 16:8 fast normally crosses midnight, so a fast belongs to the
**local date of `startedAt`**. Compute from local date parts, never by slicing an ISO
string — that is UTC and will put evening fasts on the wrong day. Ireland observes DST;
because durations are derived from epoch timestamps they are unaffected, but *day
bucketing* is local and must be done deliberately.

---

## 5. Weight log

Manual entry only — HealthKit is unreachable from the web (see `RESEARCH.md` §3).
List of entries plus an SVG trend line. Metric only.

---

## 6. Metabolic stage timeline

Marks on the timer showing the approximate phase: fed 0-4h, glycogen depletion 4-12h,
lipolysis ~12h, ketosis ~16-18h, autophagy ~24h.

One quiet line of copy noting these are typical approximations, not a personal
measurement. Not a legal disclaimer — just so I don't end up believing my own UI.

---

## 7. Backup

Port `DataManager` from MatchTracker: JSON export via the share sheet with
`<a download>` fallback, plus import.

Two rules that came from real bugs and must survive the port:
- **`navigator.share({ files })` only.** Never pass `title` or `text` — iOS "Save to
  Files" materialises string fields as a stray extra document.
- **A dismissed share sheet is not a backup.** `AbortError` must not set `lastBackupAt`,
  or the staleness indicator will claim a backup that never left the device.

The import conflict-resolution machinery (three-way new/identical/conflicting) is
probably over-engineered for one device with one data source. Start with a simple
"replace everything" import behind a confirmation, and port the full analysis only if
it is ever needed.

**Export is the only real backup.** iOS evicts storage for sites unused ~7 days and
`navigator.storage.persist()` does not fully prevent it. The app should nag when
`lastBackupAt` gets stale.

---

## Build order

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | Scaffold + relative paths + SW | Installs and runs offline from the subpath |
| 1 | Storage + tests | `sw-upgrade` and `storage` suites pass |
| 2 | Timer, plans, progress ring | Survives a force-quit mid-fast |
| 3 | History + time editing | Can fix a forgotten start |
| 4 | Stats + heatmap | — |
| 5 | Weight log | — |
| 6 | Stage timeline | — |
| 7 | Export/import | Round-trips a backup |

Phases 0-3 are the app. Everything after is worth having but not load-bearing.

Estimated ~1,000-1,500 lines of `script.js`, against MatchTracker's ~8,900.

---

## Deferred

Notifications, journal, water, share cards, food logging, units toggle, Health sync,
accounts. Rationale for each is in `RESEARCH.md`.

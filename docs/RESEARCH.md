# Intermittent Fasting PWA — Competitive & Feasibility Research

Research date: September 2026. Sources are listed at the bottom.

Purpose: survey what existing intermittent fasting (IF) apps actually do, work out
which of it is buildable as a zero-dependency PWA, and identify what we can lift
directly from MatchTrackerPWA.

---

## 1. The competitive landscape

Five apps dominate. They split cleanly into **timers** and **coaching funnels**.

| App | Core positioning | Notable features | Business model |
|---|---|---|---|
| **Zero** | The purist's fasting timer | 11+ fasting profiles (circadian 12h, 16:8, 18:6, OMAD, 36h "Monk"), custom schedules, metabolic phase timeline, streaks, weight/adherence dashboard, fasting journal (mood/energy/hunger), large article library | Strong free tier; premium adds circadian data + content |
| **Fastic** | Guided programs for beginners | Timer + guided 6-week programme, IF challenges, community, basic food tracking, AI food scanner (free) | Freemium, leans on coaching |
| **Simple** | AI weight-loss coach | Detailed onboarding questionnaire, AI coach Q&A, tracks calories/water/steps/weight, syncs Google Fit / Fitbit / Apple Watch | Subscription; criticised for opaque pricing |
| **BodyFast** | Personalised weekly plans | 12 fasting plans free (16:8, 5:2 etc.), fasting clock + reminders, fasting stages, weight & body measurements, water tracker, 100+ recipes, weekly plan from "the Coach" | Freemium |
| **LIFE Fasting Tracker** | Keto/ketosis crowd | Fasting windows, estimated time in ketosis, integrates ketone meters (Biosense, Keto-Mojo), social "circles" | Free-leaning |

There is also a healthy open-source tier — FastTrack, Simple IF Tracker (already a
single-file offline PWA), NutriTrace, OpenNutriTracker — which proves the core is
small and that "privacy-first, no account" is an established niche, not a novelty.

### The gap worth aiming at

The recurring complaint across reviews is **not** missing features — it is the
business model wrapped around them:

- Core timers paywalled behind annual subscriptions; history beyond ~3 days locked.
- Apps advertising "free forever" then paywalling core functionality.
- Onboarding questionnaires that withhold pricing until an email is captured.
- Pricing spread from $0 to ~$420/year (DoFasting) for *the same core functionality*.
- Generic AI coaching; self-contradicting weight-loss content.
- High store rankings tracking marketing spend rather than satisfaction.

That is the opening: **the whole useful core of an IF app is a timer, a history,
and a chart.** It is genuinely small. Everything expensive in these apps is content
and coaching bolted on to justify a subscription. A free, offline, no-account PWA
that does the core properly is a real product, not a compromised one.

---

## 2. Feature inventory

### Table stakes — an IF app without these is not an IF app
1. **Fast timer** — start/stop, elapsed time, target duration, progress ring.
2. **Fasting plans/presets** — 16:8, 18:6, 20:4, OMAD, 12:12, 14:10, 5:2, custom.
3. **Edit start/end times** — retroactively fixing a forgotten start is *the* most-used
   feature after the timer itself. Users habitually forget to hit start.
4. **History** — list of completed fasts with duration, date, and whether the goal was hit.
5. **Streaks & basic stats** — current streak, longest fast, 7/30-day average, total fasts.
6. **Reminders** — "your eating window closes in 30 min", "you hit 16h". (See §3 — this
   is the one hard problem.)

### Strong differentiators — cheap to build, high perceived value
7. **Metabolic stage timeline** — the single most-copied feature. Shows phase transitions
   as the fast progresses. Common marketed boundaries: fed/anabolic 0–4h, glycogen
   depletion 4–12h, lipolysis ~12h, ketosis ~16–18h, autophagy ~24h, deep fast 48h+.
   ⚠️ **Caveat worth respecting:** these hour boundaries are marketing-grade, not
   settled science. They vary hugely by individual, last meal, and activity, and
   autophagy in humans is measured by proxy markers, not directly. We should present
   these as *approximate, typical* ranges with a plain disclaimer rather than as
   personal biological fact. This is both honest and a differentiator, since the
   commercial apps present them as certainties.
8. **Weight log + trend chart** — a few numbers and an SVG line. Very cheap.
9. **Fasting journal** — mood / energy / hunger per fast, then surface the pattern
   ("you report low energy on fasts over 18h"). Zero charges for this; it's a form
   and a group-by.
10. **Water tracker** — trivial counter, universally expected.
11. **Calendar heatmap** — GitHub-contributions-style month view of fasting adherence.
    Extremely legible, very cheap.
12. **Share card** — canvas-generated image of a completed fast for social. **We have
    already built exactly this in MatchTracker** (see §4).

### Deliberately out of scope (at least for v1)
- **Food/calorie logging** — needs a food database, an ongoing licence cost, and it is
  a different app. Zero's own weakness is that people bounce to MyFitnessPal; we should
  not pretend to solve it badly.
- **AI coaching** — needs a backend, an API key, and running costs, which forces the
  subscription model we are explicitly avoiding. Also the most-criticised feature.
- **Community / social circles** — needs accounts, a server, and moderation.
- **Wearable & Health app sync** — not possible from a PWA (see §3).
- **Recipes / article library** — content work, not engineering; adds bulk not value.

---

## 3. PWA feasibility — what actually works

This is the section that decides the product's shape.

### ✅ Works well
- **Offline-first**: the whole app is local. Service worker + IndexedDB, exactly as
  MatchTracker does it. No network needed, ever.
- **Installable, standalone, portrait-locked**: manifest handles this.
- **The timer itself**: a fast is just a start timestamp. Elapsed time is
  `Date.now() - startedAt` — *derived*, never accumulated. This is strictly simpler
  and more robust than MatchTracker's timer, because a fast has no pause and no
  periods. Backgrounding the app, killing it, or rebooting the phone cannot corrupt
  it: on relaunch we recompute from the stored timestamp.
- **Export/import backup**: same JSON share-sheet approach as MatchTracker.
- **Share cards**: canvas → blob → `navigator.share({ files })`.

### ⚠️ The hard problem: notifications
This is the one genuine functional gap versus native, and it needs a decision.

- iOS supports web push for PWAs **only** when installed to the Home Screen (iOS 16.4+).
  Fine — our users will install it.
- **There is no way to schedule a local notification from a PWA.** The Notification
  Triggers API was never shipped by Safari. Safari supports *push* (server-sent), not
  *local scheduled* notifications. So "remind me at 8pm when my eating window closes"
  cannot be done purely client-side.
- **EU status — corrected:** several 2026 articles still claim Apple removed standalone
  PWA support in the EU under the DMA. **This is out of date.** Apple announced the
  reversal on 1 March 2024 and Home Screen web apps (and therefore web push) continued
  to work in the EU from iOS 17.4. Relevant to us directly, given MatchTracker's
  Irish user base.

**Three options, in order of my preference:**

- **(a) No push in v1.** Ship notification-free. In-app, the timer is always correct and
  the stage timeline is visible whenever the app is open. Many users of the open-source
  trackers live happily without reminders. Zero engineering cost, zero running cost,
  keeps the "no account, no server" promise intact.
- **(b) Foreground-only notifications.** Use the Notification API while the page is
  alive to fire milestone alerts ("16h reached") when the app is open or recently
  backgrounded. Cheap, partial, slightly unreliable — but honest if labelled as such.
- **(c) A minimal push server.** A tiny VAPID web-push endpoint holding only a
  subscription object and a scheduled time. This buys real reminders but breaks the
  no-backend property and introduces hosting, keys, and a privacy story. Worth doing
  **only** if reminders prove to be the top user request after v1.

Recommendation: **(a) for v1, (b) as a fast follow, (c) only on evidence.**

### ❌ Not possible from a PWA
- **Apple HealthKit / Health Connect sync.** HealthKit has no backend API and no web
  surface; Google deprecated the Fit REST API to new signups in May 2024. Weight and
  steps must be entered manually or not at all. This is a genuine, permanent limitation
  versus Simple/Zero and should be stated plainly rather than worked around.
- **Ketone meter integration** (LIFE's differentiator) — Web Bluetooth is not on Safari.

---

## 4. What MatchTrackerPWA gives us for free

MatchTracker is a mature answer to "how do you build a reliable offline PWA with no
build step". Substantial parts port over more or less directly, and — more valuably —
its scar tissue tells us which bugs to not write again.

### Port directly
| From MatchTracker | Use in the IF app |
|---|---|
| `StorageManager` (`script.js:128–330`) | Single-store IndexedDB wrapper. Rename the DB, keep the shape verbatim. |
| `sw.js` | Precache list + the network-first-navigation / `ignoreSearch`-assets fetch strategy. |
| `DataManager` export/import (`script.js:381–620`) | Backup as JSON via share sheet, `lastBackupAt` staleness indicator, and the three-way new/identical/conflicting import analysis. |
| Canvas share-card generation (`script.js:~2040, ~3488`) | "I completed an 18-hour fast" card instead of a scoring event. |
| `test/sw-upgrade.test.js`, `test/storage.test.js`, `test/backup.test.js` | The harnesses transfer almost unchanged; only the seeded data differs. |
| `manifest.json`, icon pipeline, `create-icons.html`, self-hosted fonts | Straight copy with new branding. |
| View-switching (`showView()`), modal conventions, dark theme, `tailwind-minimal.css` | The whole UI substrate. |

### Hard-won lessons to carry over
1. **Timers must be timestamp-anchored, never interval-accumulated.** MatchTracker
   stores `periodStartTimestamp` and derives elapsed time from it
   (`script.js:6959`), with `setInterval` only driving the *display*. A fast can run
   for 24+ hours across screen locks and app kills, so this matters far more here than
   it did there. **Never store an incrementing counter.**
2. **One storage store, never two.** MatchTracker's worst bug was writing localStorage-
   first and reading localStorage-first across two independent stores; once localStorage
   hit quota they diverged silently and recent matches vanished. Single store from day one.
3. **Never delete an unverified copy.** The migration writes, reads back, verifies, and
   only then removes originals. Same discipline for any future data reshaping.
4. **Cache-busting is two-sided.** Bumping `CACHE_NAME` without bumping the `?v=` query
   strings in `index.html` serves stale assets forever, because `caches.match()` keys on
   the full URL. Both, every time.
5. **Navigations go network-first.** Cache-first navigation pins the app to the old
   release permanently. Already fixed in MatchTracker's `sw.js`; copy that comment too.
6. **`navigator.share()` with `files` only** — never pass `title` or `text`, because iOS
   "Save to Files" materialises string fields as a stray extra document.
7. **A dismissed share sheet is not a backup.** `AbortError` must not set `lastBackupAt`.
8. **Test the upgrade path, not the fresh install.** Every serious caching and storage
   bug in MatchTracker was invisible on a fresh install and only appeared on a device
   that already had data. The test suites exist because of this.
9. **Export is the only real backup.** iOS evicts storage for sites unused ~7 days, and
   `navigator.storage.persist()` does not fully prevent it. Prompt for exports.

### Where the IF app is genuinely simpler
- No dual-team logic, no player rosters, no panels, no periods, no live-share.
- One running fast at a time versus many concurrent matches.
- The event model collapses to: a fast has a start, an end, a goal, and optional notes.
- Expect roughly **1,000–1,500 lines of `script.js`** against MatchTracker's ~8,900.

---

## 5. Suggested v1 scope

A defensible, buildable MVP:

1. Big timer with progress ring; start/stop; current plan shown.
2. Plan presets (12:12, 14:10, 16:8, 18:6, 20:4, OMAD) + custom hours.
3. Edit start/end time of the current or a past fast.
4. Metabolic stage timeline with an honest "approximate" disclaimer.
5. History list + calendar heatmap.
6. Stats: current streak, longest streak, 7/30-day averages, goal-completion rate.
7. Weight log with a trend line.
8. Post-fast journal: mood, energy, hunger, free-text note.
9. Export / import JSON backup with staleness prompt.
10. Share card for a completed fast.

Deferred: water tracking, push reminders, food logging, anything requiring a server.

### Data model sketch
```javascript
// A fast — note startedAt/endedAt are timestamps, not durations
{
  id: "1757155200000-482913",
  startedAt: 1757155200000,     // ms epoch
  endedAt: 1757212800000,       // ms epoch, or null while running
  goalHours: 16,
  planId: "16-8",               // or "custom"
  mood: 3,                      // 1-5, optional
  energy: 4,                    // 1-5, optional
  hunger: 2,                    // 1-5, optional
  note: "",
  editedAt: null                // set if start/end was adjusted after the fact
}

// Weight entry
{ id, at: 1757155200000, kg: 78.4 }

// Settings
{ activePlanId, units: "metric" | "imperial", lastBackupAt, stageDisclaimerAck }
```
Storage keys, mirroring MatchTracker: `fasts`, `weights`, `settings`, `lastBackupAt`.

---

## 6. Open questions for you

1. **Notifications** — is shipping v1 without reminders acceptable? It is the single
   biggest fork in the road, because option (c) means running a server and gives up
   the no-account property.
2. **Domain/hosting** — same pattern as `matchtracker.club` (GitHub Pages + CNAME at a
   domain root, since the SW precaches root-absolute paths)?
3. **Audience** — personal/family use, or a public app aimed at the paywall-fatigued
   crowd? This changes how much polish onboarding and the share card deserve.
4. **Units** — metric only, or metric + imperial from day one?

---

## Sources

- [Best Intermittent Fasting Apps 2026: Tested](https://fasting-diet-guide.com/best-intermittent-fasting-apps/)
- [Zero vs Fastic vs Swoodie 2026 comparison](https://swoodie.app/blog/zero-vs-fastic-vs-swoodie-2026)
- [Intermittent Fasting Tracker App: 9 Best Picks Compared (2026) — HabitBox](https://habitbox.app/blog/intermittent-fasting-tracker-app)
- [BodyFast — free version features](https://help.bodyfast.app/hc/en-001/articles/26281001421458-What-features-are-included-in-the-free-app-version)
- [Intermittent Fasting Apps With No Subscription (2026)](https://getfasted.app/articles/comparisons/compare-no-subscription-fasting)
- [5 Intermittent Fasting Apps Ranked — Unstar](https://unstar.app/id/blog/zero-simple-fastic-life-fasting-bodyfast-intermittent-fasting-apps-ranked-2026)
- [Simple App Review (2026) — Fortune](https://fortune.com/article/simple-app-review/)
- [What Are the Different Stages of Intermittent Fasting? — Healthline](https://www.healthline.com/nutrition/stages-of-fasting)
- [The 4 Stages Of Fasting — mindbodygreen](https://www.mindbodygreen.com/articles/stages-of-fasting)
- [PWA iOS Limitations and Safari Support 2026 — MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)
- [Upcoming Support for Background Notifications in PWAs on Safari? — Apple Developer Forums](https://developer.apple.com/forums/thread/735402)
- [iOS 17.4 won't remove Home Screen web apps in the EU after all — 9to5Mac](https://9to5mac.com/2024/03/01/apple-home-screen-web-apps-ios-17-eu/)
- [Apple reverses decision about blocking web apps on iPhones in the EU — TechCrunch](https://techcrunch.com/2024/03/01/apple-reverses-decision-about-blocking-web-apps-on-iphones-in-the-eu/)
- [What You Can (and Can't) Do With Apple HealthKit Data](https://www.themomentum.ai/blog/what-you-can-and-cant-do-with-apple-healthkit-data)
- [Simple IF Tracker — single-file offline PWA](https://github.com/Vojislav77/if-tracker)
- [FastTrack — self-hosted fasting tracker](https://github.com/theqldcoalminer/fasttrack)
- [OpenNutriTracker](https://github.com/simonoppowa/OpenNutriTracker)

# Intermittent Fasting PWA — Competitive & Feasibility Research

Research date: September 2026. Sources are listed at the bottom.

Purpose: survey what existing intermittent fasting (IF) apps actually do, work out
which of it is buildable as a zero-dependency PWA, and identify what we can lift
directly from MatchTrackerPWA.

**Project context: this is a personal app, built for my own use.** It is not going to
the App Store and is not competing with anything. Friends or family may be given the
URL if they ask, but that is the whole distribution plan. Everything below is filtered
through that: the survey is for *stealing good ideas*, not for positioning.

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

### What the survey is actually good for

Since we are not competing with these apps, the pricing complaints and paywall
patterns are irrelevant except as a reading of *which features people resent paying
for* — which is a decent proxy for which features they actually use. The signal there
is consistent: **people resent paying for the timer, the history and the stats.** That
is the core, and it is the part that is small enough to just build.

Equally useful is the open-source tier — FastTrack, Simple IF Tracker (already a
single-file offline PWA), NutriTrace, OpenNutriTracker. These are the closest
comparables to what we are doing, and they confirm the scope is a weekend-to-a-fortnight
project, not a product build.

The rest of what the commercial apps sell — AI coaching, recipe libraries, community
circles, article archives, onboarding funnels — is content and monetisation scaffolding.
None of it applies. **This is the single biggest consequence of the project being
personal: perhaps 70% of what these apps ship is not features at all.**

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

### Cheap to build, worth having
7. **Metabolic stage timeline** — the single most-copied feature. Shows phase transitions
   as the fast progresses. Common marketed boundaries: fed/anabolic 0–4h, glycogen
   depletion 4–12h, lipolysis ~12h, ketosis ~16–18h, autophagy ~24h, deep fast 48h+.
   ⚠️ **Caveat worth respecting:** these hour boundaries are marketing-grade, not
   settled science. They vary hugely by individual, last meal, and activity, and
   autophagy in humans is measured by proxy markers, not directly. We should present
   these as *approximate, typical* ranges rather than as personal biological fact —
   the commercial apps state them as certainties and that is worth not copying, if only
   so I don't end up believing my own UI.
8. **Weight log + trend chart** — a few numbers and an SVG line. Very cheap.
9. **Fasting journal** — mood / energy / hunger per fast, then surface the pattern
   ("you report low energy on fasts over 18h"). Zero charges for this; it's a form
   and a group-by.
10. **Water tracker** — trivial counter, in every commercial app. Cut (see §5).
11. **Calendar heatmap** — GitHub-contributions-style month view of fasting adherence.
    Extremely legible, very cheap.
12. **Share card** — canvas-generated image of a completed fast. MatchTracker already
    has this code (see §4), but it exists to drive social sharing, so it is cut for a
    personal build. Noted here because the port would be near-free if that changes.

### Deliberately out of scope
- **Food/calorie logging** — needs a food database and an ongoing licence cost, and it
  is a different app.
- **AI coaching** — needs a backend and running costs. Also the most-criticised feature
  in every review set.
- **Community / social circles** — needs accounts and a server. Meaningless for one user.
- **Wearable & Health app sync** — not possible from a PWA (see §3).
- **Recipes / article library** — content work, not engineering.
- **Onboarding flow** — I already know what 16:8 means. A first-run default and a
  settings screen is the whole of it.

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

### ⚠️ Notifications — the one real gap, and why it stops mattering
This is the only genuine functional gap versus a native app.

- iOS supports web push for PWAs **only** when installed to the Home Screen (iOS 16.4+).
  Fine — I would install it anyway.
- **There is no way to schedule a local notification from a PWA.** The Notification
  Triggers API was never shipped by Safari. Safari supports *push* (server-sent), not
  *local scheduled* notifications. So "remind me at 8pm when my eating window closes"
  cannot be done purely client-side.
- **EU status — corrected:** several 2026 articles still claim Apple removed standalone
  PWA support in the EU under the DMA. **This is out of date.** Apple announced the
  reversal on 1 March 2024 and Home Screen web apps (and therefore web push) continued
  to work in the EU from iOS 17.4. Relevant directly, since I am in Ireland.

**For a personal app, the calculus changes completely.** Standing up a VAPID push
server, with keys and hosting, to send reminders to exactly one person is absurd.
The realistic options are:

- **(a) No push. Use the phone's own Reminders/Clock app.** A repeating daily alarm at
  the time your eating window opens and closes costs nothing, is more reliable than
  anything we could build, and needs zero code. For a fixed schedule like 16:8 — where
  the reminder times are the *same every day* — this is not a workaround, it is simply
  the better answer. **This is my recommendation.**
- **(b) Foreground-only milestone alerts.** Use the Notification API while the page is
  alive, so opening the app mid-fast can surface "16h reached". Cheap, partial, and
  worth doing only if it turns out to be missed.
- **(c) A push server.** Not worth it for one user. Revisit only if the app ends up
  being shared and someone actually asks.

This effectively **removes the biggest open question from the project**. The one
genuine PWA limitation is neatly sidestepped by the fact that a personal user can
just set an alarm.

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

Reduced for personal use — the cuts are all things that only made sense for an audience.

**Build:**
1. Big timer with progress ring; start/stop; current plan shown.
2. Plan presets (12:12, 14:10, 16:8, 18:6, 20:4, OMAD) + custom hours.
3. **Edit start/end times.** The most important feature after the timer, because
   forgetting to hit start is the normal case, not the edge case.
4. History list + calendar heatmap.
5. Stats: current streak, longest fast, 7/30-day averages, goal-completion rate.
6. Weight log with a trend line.
7. Export / import JSON backup.

**Probably build, cheaply:**
8. Metabolic stage timeline. Still the nicest thing to look at mid-fast. One honest
   line noting the hour boundaries are approximate — for my own benefit, not as a
   disclaimer to users.
9. Post-fast journal (mood / energy / hunger / note) — worth it only if I would
   actually fill it in. Easy to add later; the data model leaves room.

**Cut from the earlier list:**
- **Share cards.** Built for social virality. I am not posting my fasts anywhere.
  (The MatchTracker canvas code stays available if this ever changes.)
- **Water tracking.** Present in every commercial app because it pads a feature list.
  Skip unless genuinely wanted.
- **Onboarding.** Sensible defaults instead.

### Testing

Keep two of MatchTracker's three suites — `sw-upgrade` and `storage`. It is tempting to
skip tests on a personal project, but both suites exist because of bugs that were
**invisible on a fresh install and only appeared on a device that already had data**:
a stale service worker serving last month's app forever, and a storage bug that
silently ate recent records. Those are exactly the bugs that are most maddening on an
app you rely on daily and cannot debug from a user report. They port over nearly free.

`backup.test.js` is lower priority but the export path is still the only thing standing
between a lost phone and a lost history, so it is worth having eventually.

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
{ activePlanId, lastBackupAt }
```
Storage keys, mirroring MatchTracker: `fasts`, `weights`, `settings`, `lastBackupAt`.

Metric only — no units toggle. I can add one if anyone who wants pounds ever asks.

---

## 6. Decisions taken, and what is left

Resolved by the project being personal:
- **Notifications** — none in v1; use the phone's Reminders app. (§3)
- **Units** — metric only.
- **Share cards, water tracking, onboarding** — cut.
- **Privacy/accounts** — moot. No server, no account, data never leaves the device.

Resolved since:
- **Hosting** — subpath (`alancullinan.github.io/IF-PWA/`). Every path in the project
  must therefore be relative rather than root-absolute, unlike MatchTracker. See
  `PLAN.md` §0, which is the highest-risk part of the build to get wrong.
- **Journal** — out. Mood/energy/hunger tracking would not get filled in. The data
  model leaves room to add it later without a migration.

Nothing is blocking. Build order is in `docs/PLAN.md`.

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

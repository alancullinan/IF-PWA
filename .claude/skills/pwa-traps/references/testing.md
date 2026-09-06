# Testing a PWA

Read this when setting up tests for a PWA. It assumes Puppeteer, but the shape
transfers to Playwright unchanged.

## Contents

- [Why the harness looks like this](#why-the-harness-looks-like-this)
- [The harness](#the-harness)
- [Suite 1: offline from the real path](#suite-1-offline-from-the-real-path)
- [Suite 2: the upgrade path](#suite-2-the-upgrade-path)
- [Suite 3: layout on real phone sizes](#suite-3-layout-on-real-phone-sizes)
- [Suite 4: storage](#suite-4-storage)
- [Static checks](#static-checks)
- [Verifying the tests themselves](#verifying-the-tests-themselves)

## Why the harness looks like this

Three properties do most of the work:

1. **Serve a temp copy, never the working tree.** Upgrade tests need to rewrite
   files mid-run to fake a deploy. Doing that to the working tree means an
   interrupted run leaves the developer's files modified.
2. **Serve from the real path.** If production is a subpath, the tests must
   serve from that subpath, or the whole class of root-absolute-path bugs is
   invisible.
3. **Be able to cut the network.** Airplane mode is the point of a PWA, and
   "the server refuses every request" is the only honest way to simulate it.

## The harness

```js
const REPO = path.resolve(__dirname, '..');
const MOUNT = '/my-app';               // the subpath production uses

/** Copy the app's runtime files into a scratch dir, mounted under MOUNT. */
async function materialise(tmpDir) {
  const root = path.join(tmpDir, MOUNT);
  await fsp.mkdir(root, { recursive: true });
  for (const f of APP_FILES) {
    await fsp.copyFile(path.join(REPO, f), path.join(root, f));
  }
  return root;
}

/** state.offline makes every response a network error. */
function startServer(state, port) {
  const server = http.createServer(async (req, res) => {
    if (state.offline) { req.socket.destroy(); return; }
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    // Directory URLs serve index.html, as static hosts do.
    const rel = urlPath.endsWith('/') ? path.join(urlPath, 'index.html') : urlPath;
    const file = path.join(state.dir, rel);
    if (!file.startsWith(state.dir)) { res.writeHead(403).end(); return; }
    try {
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        // No HTTP caching: we are testing the service worker, and the browser
        // cache would confound which layer served a response.
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
```

Give each suite its own port so they can run in sequence without collisions,
and return the served `root` from `boot()` so upgrade tests can rewrite it.

**A test seam.** Code inside an IIFE is unreachable from the test. Expose a
small object — the behaviour under test, not the whole module:

```js
window.__appTest = { APP_VERSION, showView, StorageManager, computeStats };
```

## Suite 1: offline from the real path

Load online, then flip the server offline and reload.

Assert: the shell renders, the **stylesheet actually applied** (check a computed
colour, not just that the file was requested), the script ran, a self-hosted
font loaded, and the worker's scope is the subpath. Then check the precache:

```js
check('precache populated', cached.length >= 15, true);
check('cached the directory URL', cached.includes(`${MOUNT}/`), true);
// Guard against passing vacuously: an empty cache satisfies every()
// trivially, and an empty cache is exactly the failure being tested for.
check('nothing cached above the subpath',
  cached.length > 0 && cached.every((p) => p.startsWith(`${MOUNT}/`)), true);
```

`./` and `./index.html` are **distinct cache keys**, and static hosts serve the
bare directory URL from `index.html`, so precache both.

## Suite 2: the upgrade path

This is the suite that matters most, because every serious caching bug is an
upgrade bug.

Install the old release, then rewrite the served copy to fabricate a new one —
version markers in the worker, the `?v=` strings in the HTML, and something
observable in the script and stylesheet. Using the *current* source as the "old"
release keeps the test meaningful as the app evolves.

**Poll to a deadline rather than sleeping a fixed time.** The
install → activate → claim → reload chain takes an unpredictable few hundred
milliseconds; a fixed sleep either flakes or wastes seconds. A too-short sleep
will report a working upgrade path as broken and send you fixing the wrong
thing.

**Tolerate the page reloading underneath you.** If the app reloads itself when a
new worker takes over, `page.evaluate` throws mid-call. That navigation is the
success signal, not a fault — catch it and retry.

**The case that matters most:** assert a deploy lands even when the worker
never updates. Leave the worker byte-identical so no new one can install, change
only the HTML and the asset it names, and require the app to reach the new code
anyway. That is the real-world failure, and it is the one a normal upgrade test
misses entirely.

## Suite 3: layout on real phone sizes

Every functional suite passes happily on an app whose primary button cannot be
reached. This suite is a separate category and worth writing.

`env()` reports 0 in a headless browser, so inject the insets a real device
reports — **onto the elements that own them**, matching the stylesheet:

```js
const DEVICES = [
  { name: 'iPhone SE',     w: 375, h: 667, top: 0,  bottom: 0 },
  { name: 'iPhone 15 Pro', w: 393, h: 852, top: 59, bottom: 34 },
  // A device reporting far more than a home indicator needs.
  { name: 'oversized inset', w: 393, h: 852, top: 59, bottom: 93 },
];

await page.addStyleTag({ content:
  `.view{padding-top:${32 + d.top}px!important}` +
  `.tabbar{margin-bottom:${Math.min(Math.max(8, d.bottom), 34)}px!important}` });
```

Assert per device: the view does not overflow, the primary button sits above the
nav, the gap below the nav is the inset and not inset-plus-margin, and touch
targets stay at least 44px.

## Suite 4: storage

Assert the properties that make silent data loss impossible, not the happy path:

- saving writes **nothing** to localStorage (pins the single-store rule)
- exactly one database exists
- a failing write returns `false` — a real boolean, not `undefined`
- a failing write tells the user
- data survives a reload (really persisted, not in memory)

To simulate a failing write, replace the storage API and watch it fail:

```js
Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
  open() { const r = {}; setTimeout(() => r.onerror && r.onerror(), 0); return r; },
}});
```

`defineProperty`, not assignment — `indexedDB` is an accessor, and a plain
assignment fails silently in sloppy mode, so the test would pass against a
working store and prove nothing. Restore by **reloading the page**: capturing
and re-applying the descriptor is fragile, because the property is not an own
property of `window` and "restoring" `undefined` deletes the API for the rest
of the run.

## Static checks

Some failures are invisible to any runtime test because the app measures itself
as correct. Read the source and assert on it:

- the cache version, the `?v=` strings and the app version all agree
- exactly one element consumes each safe-area inset
- the shell is sized with the viewport unit you intend
- the status-bar meta is the value proven on hardware

These cost three lines each and catch mistakes a person genuinely makes.

## Verifying the tests themselves

**Reintroduce the bug and confirm the test fails.** Otherwise you have a test
you merely believe in. Doing this repeatedly turned up:

- an assertion that passed **vacuously** (`every()` on an empty array — and an
  empty cache was the very failure it guarded)
- a suite claiming to pin a bug it did not catch at all, because another
  mechanism recovered from it
- a "flaky" failure that was actually a fixed sleep being shorter than the
  operation, which sent two fixes to the wrong place

Also watch for **time-boundary flakes**. A test that seeds "five hours ago" and
asserts the string `"5h 00m"` will fail depending on where in the minute it
runs, if anything in the path truncates to the minute. Derive the expected value
or assert within a tolerance.

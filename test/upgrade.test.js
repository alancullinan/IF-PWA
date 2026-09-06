/**
 * Service worker UPGRADE path.
 *
 * Every serious caching bug in the reference app was an upgrade bug, not a
 * fresh-install bug: the app worked perfectly on a clean install and served a
 * stale version forever to anyone who already had it. Testing a first visit
 * would have caught none of them, and neither would opening it on a new phone.
 *
 * This installs an "old" release, deploys a "new" one over it, and asserts the
 * client actually ends up running the new code.
 *
 * What it pins: that a client already running an old release ends up on the
 * new code, that stale caches are cleared, that the new stylesheet is live and
 * not just the new script, and that the upgraded app still works offline.
 *
 * What it deliberately does NOT claim to pin: cache-first navigation. That was
 * checked by reintroducing it, and the suite stayed green - a versioned
 * CACHE_NAME plus skipWaiting recovers from it, because activate() deletes the
 * cache holding the stale shell. The bug it would cause needs a SECOND mistake
 * to bite: leaving CACHE_NAME unchanged. Which is why the cheap static check
 * below exists instead of a simulation.
 *
 * Run with:  npm test
 */

const fsp = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { boot, makeChecker, sleep, REPO } = require('./harness');

const PORT = 8234;

async function waitForController(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => !!navigator.serviceWorker.controller)) return true;
    await sleep(200);
  }
  return false;
}

/** Rewrite the served copy into a different release, as a deploy would. */
async function deployNewVersion(root, from, to) {
  const edits = [
    ['sw.js', (t) => t.replace(`fasting-v${from}`, `fasting-v${to}`)],
    ['index.html', (t) => t.split(`?v=${from}`).join(`?v=${to}`)],
    ['script.js', (t) => t.replace(`const APP_VERSION = '${from}'`, `const APP_VERSION = '${to}'`)],
    ['styles.css', (t) => t.replace('--accent:      #FFB37A;', '--accent:      #00FF00;')],
  ];
  for (const [file, edit] of edits) {
    const p = path.join(root, file);
    const before = await fsp.readFile(p, 'utf8');
    const after = edit(before);
    if (after === before) throw new Error(`deploy edit did not apply to ${file}`);
    await fsp.writeFile(p, after);
  }
}

/**
 * Read APP_VERSION, tolerating the page reloading underneath us.
 *
 * When a new worker takes over, the app reloads itself so the user is running
 * the new code immediately. That destroys the execution context mid-evaluate,
 * so a plain read throws - the navigation is the success signal, not a fault.
 */
async function currentVersion(page) {
  try {
    return await page.evaluate(() => (window.__ifTest || {}).APP_VERSION);
  } catch {
    return null;
  }
}

/**
 * Relaunch until the new version is running, or give up.
 *
 * Polls to a deadline rather than sleeping a fixed time per relaunch: the
 * install, activate, claim and self-reload chain takes an unpredictable few
 * hundred milliseconds, and a fixed sleep either flakes or wastes seconds.
 */
async function reloadUntilUpgraded(page, base, want, relaunches = 4, waitMs = 6000) {
  for (let i = 0; i < relaunches; i++) {
    try {
      await page.goto(base, { waitUntil: 'networkidle2' });
    } catch {
      // The app's own reload can abort ours; the next pass picks it up.
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if ((await currentVersion(page)) === want) return i + 1;
      await sleep(250);
    }
  }
  return null;
}

/**
 * The deploy rule, checked statically.
 *
 * caches.match() keys on the full URL including the query string, so bumping
 * CACHE_NAME without bumping the ?v= strings (or the reverse) can leave an old
 * asset in place. Nothing in the runtime can detect that - sw.js cannot read
 * index.html - so it is checked here, where forgetting costs a red test rather
 * than a stale app on a phone that is hard to debug remotely.
 */
function checkVersionsAgree(check) {
  const sw = fsSync.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
  const html = fsSync.readFileSync(path.join(REPO, 'index.html'), 'utf8');

  const script = fsSync.readFileSync(path.join(REPO, 'script.js'), 'utf8');

  const cacheName = (sw.match(/CACHE_NAME = 'fasting-v([^']+)'/) || [])[1];
  const appVersion = (script.match(/APP_VERSION = '([^']+)'/) || [])[1];
  const queryVersions = [...html.matchAll(/\?v=([0-9.]+)/g)].map((m) => m[1]);

  check('sw.js names a cache version', typeof cacheName === 'string', true);
  check('index.html busts its assets', queryVersions.length >= 2, true);
  check('every ?v= agrees with CACHE_NAME',
    queryVersions.every((v) => v === cacheName), true);
  check('APP_VERSION agrees too', appVersion, cacheName);
  return cacheName;
}

/** The version currently in the tree, so a bump does not break this suite. */
function currentRepoVersion() {
  const sw = fsSync.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
  return sw.match(/CACHE_NAME = 'fasting-v([^']+)'/)[1];
}

async function main() {
  const { check, report } = makeChecker();

  console.log('\n  Cache-busting is two-sided');
  checkVersionsAgree(check);

  const ctx = await boot(PORT);
  const OLD = currentRepoVersion();
  const NEW = '9.9.9';

  try {
    const page = await ctx.browser.newPage();

    console.log('\n  Install the old release');
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });
    check('worker took control', await waitForController(page), true);
    check('running the old version', await page.evaluate(
      () => window.__ifTest.APP_VERSION), OLD);

    console.log('\n  Deploy a new release over it');
    await deployNewVersion(ctx.root, OLD, NEW);
    const reloads = await reloadUntilUpgraded(page, ctx.base, NEW);

    check('the client ends up on the new code', reloads !== null, true);
    check('new version reported', await currentVersion(page), NEW);

    // The stylesheet is the separate half of the trap: it is requested with a
    // ?v= the precache does not store, so an unbumped query string leaves the
    // old file in place even when CACHE_NAME changed.
    check('the new stylesheet is live too', await page.evaluate(
      () => getComputedStyle(document.documentElement)
        .getPropertyValue('--accent').trim()), '#00FF00');

    check('old caches cleaned up', await page.evaluate(
      async () => (await caches.keys()).length), 1);
    check('and the surviving cache is the new one', await page.evaluate(
      async () => (await caches.keys())[0]), `fasting-v${NEW}`);

    console.log('\n  The upgraded app still works offline');
    ctx.state.offline = true;
    await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });
    check('still loads with the network gone', await page.evaluate(
      () => !!document.querySelector('#timer-view.is-active')), true);
    check('and it is the new version that is cached', await page.evaluate(
      () => window.__ifTest.APP_VERSION), NEW);
  } finally {
    await ctx.close();
  }

  process.exit(report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

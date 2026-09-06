/**
 * Phase 0 gate: the app installs and runs OFFLINE, served from a SUBPATH.
 *
 * This is the test the whole relative-path discipline exists for. The app is
 * served under /IF-PWA/ rather than at a domain root, so a single
 * root-absolute path ('/index.html') in sw.js would resolve above the app.
 * Because cache.addAll() is atomic, one bad entry rejects the ENTIRE install
 * and the app silently has no offline support - while looking perfect online.
 * That split is exactly why eyeballing it in a browser is not enough.
 *
 * Run with:  npm test
 */

const { boot, makeChecker, sleep, MOUNT } = require('./harness');

const PORT = 8231;

/** Wait until a service worker actually controls the page. */
async function waitForController(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => !!navigator.serviceWorker.controller)) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  const { check, report } = makeChecker();
  const ctx = await boot(PORT);

  try {
    const page = await ctx.browser.newPage();

    console.log('\n  Serving from a subpath, first visit');
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });

    check('app shell rendered', await page.evaluate(
      () => !!document.querySelector('#timer-view.is-active')), true);
    check('stylesheet applied (not just parsed)', await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor), 'rgb(18, 20, 42)');
    check('script ran inside its IIFE', await page.evaluate(
      () => !!window.__ifTest), true);

    console.log('\n  Service worker');
    check('a worker took control', await waitForController(page), true);
    check('scope is the subpath', await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? reg.scope : null;
    }), `http://localhost:${PORT}${MOUNT}/`);

    // The precache is atomic: had any entry been root-absolute, addAll() would
    // have rejected and this cache would be missing or short.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      if (!names.length) return null;
      const cache = await caches.open(names[0]);
      return (await cache.keys()).map((r) => new URL(r.url).pathname).sort();
    });
    check('precache populated', Array.isArray(cached) && cached.length >= 15, true);
    check('cached the directory URL', cached.includes(`${MOUNT}/`), true);
    check('cached index.html', cached.includes(`${MOUNT}/index.html`), true);
    check('cached the font', cached.includes(`${MOUNT}/fonts/outfit.woff2`), true);
    // Guard against passing vacuously: an empty cache would satisfy every()
    // trivially, and an empty cache is precisely the failure being tested for.
    check('nothing cached above the subpath',
      Array.isArray(cached) && cached.length > 0
        && cached.every((p) => p.startsWith(`${MOUNT}/`)), true);

    console.log('\n  Airplane mode: server refuses every request');
    ctx.state.offline = true;
    await page.goto(ctx.base, { waitUntil: 'domcontentloaded' });

    check('app still loads offline', await page.evaluate(
      () => !!document.querySelector('#timer-view.is-active')), true);
    check('styles survived offline', await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor), 'rgb(18, 20, 42)');
    check('script survived offline', await page.evaluate(
      () => !!window.__ifTest), true);
    check('self-hosted font loaded offline', await page.evaluate(
      () => document.fonts.check('16px Outfit')), true);

    console.log('\n  View switching works offline');
    await page.evaluate(() => window.__ifTest.showView('stats'));
    check('stats view shown', await page.evaluate(
      () => !!document.querySelector('#stats-view.is-active')), true);
    check('heatmap rendered', await page.evaluate(
      () => document.querySelectorAll('#heatmap .heat-cell').length), 91);
    check('timer view hidden', await page.evaluate(
      () => !!document.querySelector('#timer-view.is-active')), false);
  } finally {
    await ctx.close();
  }

  process.exit(report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

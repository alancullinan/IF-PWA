/**
 * Phase 0 gate: the app installs and runs OFFLINE, served from a SUBPATH.
 *
 * This is the test the whole path discipline exists for. The app is served
 * under /IF-PWA/ rather than at a domain root, so a single root-absolute path
 * ('/index.html') in sw.js would resolve above the app. Because cache.addAll()
 * is atomic, one bad entry rejects the entire install and the app silently has
 * no offline support - while looking perfect online. That split is exactly why
 * eyeballing it in a browser is not enough.
 *
 * Safety: serves a TEMP COPY of the repo, never the working tree.
 *
 * Run with:  npm test
 */

const puppeteer = require('puppeteer');
const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const PORT = 8231;
const MOUNT = '/IF-PWA';               // the subpath the real deploy uses
const BASE = `http://localhost:${PORT}${MOUNT}/`;

// Chromium ships with this image; puppeteer's own download is skipped.
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

let passes = 0;
let failures = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    passes++;
    console.log(`    PASS  ${label}`);
  } else {
    failures++;
    console.log(`    FAIL  ${label}\n            expected: ${expected}\n            actual:   ${actual}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Copy the app's runtime files into a scratch dir, mounted under MOUNT. */
async function materialise(dir) {
  const root = path.join(dir, MOUNT);
  await fsp.mkdir(root, { recursive: true });
  for (const f of ['index.html', 'script.js', 'styles.css', 'sw.js', 'manifest.json']) {
    await fsp.copyFile(path.join(REPO, f), path.join(root, f));
  }
  for (const d of ['icons', 'fonts']) {
    await fsp.cp(path.join(REPO, d), path.join(root, d), { recursive: true });
  }
  return root;
}

/**
 * Static server rooted at `dir`. `state.offline` flips every response to a
 * network error, which is how we simulate airplane mode: the service worker
 * must serve the app from cache with the server refusing to answer.
 */
function startServer(state) {
  const server = http.createServer(async (req, res) => {
    if (state.offline) { req.socket.destroy(); return; }

    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    // Directory URLs (…/IF-PWA/) are served from index.html, as GitHub Pages does.
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
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

/** Wait until a service worker actually controls the page. */
async function waitForController(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    if (controlled) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fasting-offline-'));
  const dir = await materialise(tmp);
  const state = { dir: tmp, offline: false };
  const server = await startServer(state);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();

    console.log('\n  Serving from a subpath, first visit');
    await page.goto(BASE, { waitUntil: 'networkidle2' });

    check('app shell rendered', await page.evaluate(
      () => !!document.querySelector('#timer-view.is-active')), true);
    check('stylesheet applied (not just parsed)', await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor), 'rgb(18, 20, 42)');
    check('script ran inside its IIFE', await page.evaluate(
      () => !!window.__ifTest), true);

    console.log('\n  Service worker');
    check('a worker took control', await waitForController(page), true);

    const scope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? reg.scope : null;
    });
    // The worker must own the SUBPATH, not the origin root.
    check('scope is the subpath', scope, `http://localhost:${PORT}${MOUNT}/`);

    // The precache is atomic: if any entry had been root-absolute, addAll()
    // would have rejected and this cache would be missing or short.
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
    state.offline = true;
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

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
    await browser.close();
    server.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n  ${passes} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

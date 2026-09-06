/**
 * Shared test harness.
 *
 * Both suites need the same three things: a pass/fail reporter, a static
 * server that can be told to go offline, and a temp copy of the app served
 * from a SUBPATH (never the working tree, so an interrupted run cannot leave
 * your files modified).
 */

const puppeteer = require('puppeteer');
const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');

// The subpath the real deploy uses. Serving from here rather than a domain
// root is what keeps the relative-path discipline honest.
const MOUNT = '/IF-PWA';

// Chromium ships with this image; puppeteer's own download is skipped.
const CHROME = process.env.CHROME_PATH
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const APP_FILES = ['index.html', 'script.js', 'styles.css', 'sw.js', 'manifest.json'];
const APP_DIRS = ['icons', 'fonts'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pass/fail reporter. Returns { check, report } so counts stay per-suite. */
function makeChecker() {
  let passes = 0;
  let failures = 0;
  return {
    check(label, actual, expected) {
      if (actual === expected) {
        passes++;
        console.log(`    PASS  ${label}`);
      } else {
        failures++;
        console.log(`    FAIL  ${label}\n            expected: ${expected}\n            actual:   ${actual}`);
      }
    },
    report() {
      console.log(`\n  ${passes} passed, ${failures} failed\n`);
      return failures;
    },
  };
}

/** Copy the app's runtime files into a scratch dir, mounted under MOUNT. */
async function materialise(tmpDir) {
  const root = path.join(tmpDir, MOUNT);
  await fsp.mkdir(root, { recursive: true });
  for (const f of APP_FILES) {
    await fsp.copyFile(path.join(REPO, f), path.join(root, f));
  }
  for (const d of APP_DIRS) {
    await fsp.cp(path.join(REPO, d), path.join(root, d), { recursive: true });
  }
  return root;
}

/**
 * Static server rooted at `state.dir`. Setting `state.offline` makes every
 * response a network error, which is how airplane mode is simulated.
 */
function startServer(state, port) {
  const server = http.createServer(async (req, res) => {
    if (state.offline) { req.socket.destroy(); return; }

    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    // Directory URLs are served from index.html, as GitHub Pages does.
    const rel = urlPath.endsWith('/') ? path.join(urlPath, 'index.html') : urlPath;
    const file = path.join(state.dir, rel);
    if (!file.startsWith(state.dir)) { res.writeHead(403).end(); return; }

    try {
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        // No HTTP caching: we are testing the service worker and IndexedDB,
        // and the browser cache would confound which layer served a response.
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/** Boot a temp copy of the app on `port`. Caller must call ctx.close(). */
async function boot(port) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fasting-test-'));
  const root = await materialise(tmp);
  const state = { dir: tmp, offline: false };
  const server = await startServer(state, port);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return {
    state,
    browser,
    // The served copy of the app, which a test may rewrite to fake a deploy.
    root,
    base: `http://localhost:${port}${MOUNT}/`,
    async close() {
      await browser.close();
      server.close();
      await fsp.rm(tmp, { recursive: true, force: true });
    },
  };
}

module.exports = { boot, makeChecker, sleep, MOUNT, REPO };

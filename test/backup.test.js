/**
 * Export and import.
 *
 * This is the only thing that survives a lost, wiped or replaced phone. iOS
 * clears storage for sites unused about a week, and nothing in a PWA's
 * IndexedDB reliably follows you to new hardware - so a backup that silently
 * did not happen is worse than no backup feature at all, because the app would
 * be claiming safety it has not delivered.
 *
 * The assertions are therefore mostly about the ways an export can appear to
 * succeed without succeeding, and the ways an import can damage what is
 * already on the device.
 *
 * Run with:  npm test
 */

const { boot, makeChecker } = require('./harness');

const PORT = 8237;
const HOUR = 3600000;

const fast = (over) => Object.assign({
  id: 'f1', startedAt: Date.now() - 20 * HOUR, endedAt: Date.now() - 4 * HOUR,
  goalHours: 16, planId: '16-8', editedAt: null,
}, over);

/**
 * Replace the share sheet with a stub that records what it was given.
 * `outcome` is 'ok', 'abort' (the user dismissed it) or 'unavailable'.
 */
async function stubShare(page, outcome) {
  await page.evaluate((mode) => {
    window.__shared = null;
    if (mode === 'unavailable') {
      delete navigator.share;
      navigator.canShare = () => false;
      return;
    }
    navigator.canShare = () => true;
    navigator.share = (data) => {
      window.__shared = {
        keys: Object.keys(data),
        fileCount: data.files ? data.files.length : 0,
        name: data.files && data.files[0] ? data.files[0].name : null,
      };
      if (mode === 'abort') {
        const err = new Error('dismissed');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      return Promise.resolve();
    };
  }, outcome);
}

/** Build a File in the page, as the file picker would hand us. */
async function fileFrom(page, contents) {
  await page.evaluate((text) => {
    window.__file = new File([text], 'backup.json', { type: 'application/json' });
  }, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

const text = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : null;
}, sel);

async function main() {
  const { check, report } = makeChecker();
  const ctx = await boot(PORT);

  try {
    const page = await ctx.browser.newPage();
    page.on('pageerror', (e) => console.log('    page error:', e.message));
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });

    await page.evaluate(async (f) => {
      await window.__ifTest.StorageManager.saveData('fasts', [f]);
    }, fast({}));
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });

    console.log('\n  The payload carries everything');
    const payload = await page.evaluate(() => window.__ifTest.DataManager.buildPayload());
    check('the fasts are in it', payload.fasts.length, 1);
    check('settings too', typeof payload.settings.activePlanId, 'string');
    check('it names the app, so a foreign file can be refused', payload.app, 'fasting-timer');
    check('and stamps when it was made', typeof payload.exportedAt, 'string');

    console.log('\n  Filenames cannot collide on the same day');
    const names = await page.evaluate(() => {
      const d = window.__ifTest.DataManager;
      const base = new Date(2026, 8, 6, 9, 33).getTime();
      return [d.filename(base), d.filename(base + 60000), d.filename(base)];
    });
    check('minute precision, not just the date', names[0] !== names[1], true);
    check('and stable for the same minute', names[0], names[2]);
    check('named recognisably', names[0].startsWith('fasting-backup-'), true);

    console.log('\n  Sharing hands over exactly one file and nothing else');
    await stubShare(page, 'ok');
    check('the share reports success', await page.evaluate(
      () => window.__ifTest.DataManager.exportData()), 'shared');
    const shared = await page.evaluate(() => window.__shared);
    // iOS "Save to Files" turns any title or text into its own document,
    // leaving a stray file beside every backup.
    check('files only, no title or text', shared.keys.join(','), 'files');
    check('exactly one file', shared.fileCount, 1);
    check('with the backup name', shared.name.startsWith('fasting-backup-'), true);
    check('and it counts as a backup', await page.evaluate(
      () => window.__ifTest.appState.lastBackupAt !== null), true);

    console.log('\n  A dismissed share is NOT a backup');
    await page.evaluate(async () => {
      await window.__ifTest.StorageManager.saveData('lastBackupAt', null);
      window.__ifTest.appState.lastBackupAt = null;
    });
    await stubShare(page, 'abort');
    check('it reports the cancellation', await page.evaluate(
      () => window.__ifTest.DataManager.exportData()), 'cancelled');
    // Recording this would make the staleness line claim a backup that never
    // left the device - worse than showing nothing.
    check('nothing is recorded', await page.evaluate(
      () => window.__ifTest.appState.lastBackupAt), null);
    check('and nothing was stored either', await page.evaluate(
      () => window.__ifTest.StorageManager.loadData('lastBackupAt')), null);

    console.log('\n  Without a share sheet it falls back to a download');
    await stubShare(page, 'unavailable');
    check('the download path runs', await page.evaluate(
      () => window.__ifTest.DataManager.exportData()), 'downloaded');
    check('and that does count', await page.evaluate(
      () => window.__ifTest.appState.lastBackupAt !== null), true);

    console.log('\n  Staleness is stated plainly');
    const age = (days) => page.evaluate((d) => {
      const now = Date.now();
      const then = new Date(now - d * 86400000).toISOString();
      return window.__ifTest.formatBackupAge(then, now);
    }, days);
    check('never backed up reads as such', await page.evaluate(
      () => window.__ifTest.formatBackupAge(null, Date.now()).text), 'No backup yet');
    check('and counts as stale', await page.evaluate(
      () => window.__ifTest.formatBackupAge(null, Date.now()).stale), true);
    check('today', (await age(0)).text, 'Last backup today');
    check('yesterday', (await age(1)).text, 'Last backup yesterday');
    check('a week ago', (await age(9)).text, 'Last backup 9 days ago');
    // iOS evicts storage for sites unused about a week, so that is the line.
    check('fresh is not stale', (await age(2)).stale, false);
    check('a week old is', (await age(7)).stale, true);

    console.log('\n  A damaged or foreign file is refused, untouched');
    const reject = async (contents) => {
      await fileFrom(page, contents);
      return page.evaluate(async () => {
        const r = await window.__ifTest.DataManager.analyzeImport(window.__file);
        return r.ok ? 'ACCEPTED' : r.error;
      });
    };
    check('not JSON', await reject('this is not json'), 'That file is not readable JSON.');
    check('JSON but not an object', await reject([1, 2, 3]),
      'That does not look like a backup file.');
    check('another app\'s backup', await reject({ app: 'match-tracker', fasts: [] }),
      'That backup is from a different app.');
    check('no fasts array', await reject({ app: 'fasting-timer' }),
      'That backup has no fasts in it.');
    check('a fast missing its start', await reject({
      app: 'fasting-timer', fasts: [{ id: 'x', endedAt: 2, goalHours: 16 }],
    }), 'That backup contains a damaged fast.');
    check('the device is untouched by any of that', await page.evaluate(
      () => window.__ifTest.appState.fasts.length), 1);

    console.log('\n  Importing replaces everything, and says so first');
    const backup = {
      app: 'fasting-timer', format: 1, exportedAt: new Date().toISOString(),
      fasts: [fast({ id: 'in1' }), fast({ id: 'in2', startedAt: Date.now() - 60 * HOUR,
        endedAt: Date.now() - 44 * HOUR })],
      weights: [{ id: 'w1', at: Date.now(), kg: 78.4 }],
      settings: { activePlanId: '18-6' },
    };
    await fileFrom(page, backup);
    await page.evaluate(() => window.__ifTest.offerImport(window.__file));
    check('the sheet opens', await page.evaluate(
      () => document.getElementById('import-sheet').classList.contains('is-open')), true);
    const summary = await text(page, '#import-summary');
    check('it names what arrives', summary.includes('2 fasts'), true);
    check('and what is lost', summary.includes('replaces the 1 fast'), true);

    console.log('\n  Cancelling writes nothing at all');
    await page.evaluate(() => window.__ifTest.closeImportSheet());
    check('the device still has its own fast', await page.evaluate(
      () => window.__ifTest.appState.fasts.map((f) => f.id).join(',')), 'f1');
    check('even after a reload', await page.evaluate(async () => {
      const stored = await window.__ifTest.StorageManager.loadData('fasts');
      return stored.map((f) => f.id).join(',');
    }), 'f1');

    console.log('\n  Confirming does what it said');
    await fileFrom(page, backup);
    await page.evaluate(() => window.__ifTest.offerImport(window.__file));
    await page.evaluate(() => document.getElementById('import-confirm').click());
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    check('the backup replaced what was there', await page.evaluate(
      () => window.__ifTest.appState.fasts.map((f) => f.id).join(',')), 'in1,in2');
    check('weights came across', await page.evaluate(
      () => window.__ifTest.appState.weights.length), 1);
    check('so did the plan', await page.evaluate(
      () => window.__ifTest.appState.settings.activePlanId), '18-6');
    check('the sheet closed', await page.evaluate(
      () => document.getElementById('import-sheet').classList.contains('is-open')), false);

    console.log('\n  …and it is really on the device, not just in memory');
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });
    check('fasts survived the relaunch', await page.evaluate(
      () => window.__ifTest.appState.fasts.map((f) => f.id).join(',')), 'in1,in2');
    check('history shows them', await page.evaluate(
      () => document.querySelectorAll('#history-list .fast-row').length), 2);
    check('the plan stuck too', await page.evaluate(
      () => window.__ifTest.appState.settings.activePlanId), '18-6');

    console.log('\n  A backup round-trips through its own export');
    await stubShare(page, 'unavailable');
    const roundTrip = await page.evaluate(async () => {
      const payload = window.__ifTest.DataManager.buildPayload();
      const file = new File([JSON.stringify(payload)], 'rt.json', { type: 'application/json' });
      const analysis = await window.__ifTest.DataManager.analyzeImport(file);
      return { ok: analysis.ok, fasts: analysis.fasts };
    });
    check('our own export is accepted', roundTrip.ok, true);
    check('with every fast intact', roundTrip.fasts, 2);
  } finally {
    await ctx.close();
  }

  process.exit(report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

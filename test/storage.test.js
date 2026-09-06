/**
 * Storage-layer tests.
 *
 * The bug these exist to prevent is not a crash - it is SILENT data loss. The
 * reference app for this project kept two stores (localStorage-first writes,
 * localStorage-first reads) which diverged once localStorage hit quota: new
 * records went to IndexedDB while every launch kept returning the older
 * localStorage copy. Nothing threw. Nothing logged. Recent data just vanished,
 * and only on devices that already held data - never on a fresh install.
 *
 * So these assertions are about the properties that make that class of bug
 * impossible, not about the happy path:
 *   - there is exactly ONE store, and saving never touches localStorage
 *   - a write that fails REPORTS failure rather than returning undefined
 *   - a failed write tells the user, because a fasting history is not
 *     recoverable from anywhere else
 *
 * Run with:  npm test
 */

const { boot, makeChecker } = require('./harness');

const PORT = 8232;

async function main() {
  const { check, report } = makeChecker();
  const ctx = await boot(PORT);

  try {
    const page = await ctx.browser.newPage();
    page.on('pageerror', (e) => console.log('    page error:', e.message));
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });

    console.log('\n  Round trip');
    check('saveData reports success', await page.evaluate(
      () => window.__ifTest.StorageManager.saveData('fasts', [{ id: 'a', goalHours: 16 }])), true);
    check('loadData returns what was written', await page.evaluate(
      async () => JSON.stringify(await window.__ifTest.StorageManager.loadData('fasts'))),
      JSON.stringify([{ id: 'a', goalHours: 16 }]));
    check('a missing key is null, not undefined', await page.evaluate(
      async () => (await window.__ifTest.StorageManager.loadData('nope')) === null), true);

    console.log('\n  Single store');
    // The heart of it: if a second store ever creeps back in, this fails.
    check('saving wrote nothing to localStorage', await page.evaluate(
      () => window.localStorage.length), 0);
    check('IndexedDB holds exactly one database', await page.evaluate(
      async () => (await indexedDB.databases()).length), 1);
    check('…named FastingDB', await page.evaluate(
      async () => (await indexedDB.databases())[0].name), 'FastingDB');

    console.log('\n  Overwrite replaces, never duplicates');
    await page.evaluate(() => window.__ifTest.StorageManager.saveData('fasts', [{ id: 'b' }]));
    check('one record after overwrite', await page.evaluate(
      async () => (await window.__ifTest.StorageManager.loadData('fasts')).length), 1);
    check('and it is the new one', await page.evaluate(
      async () => (await window.__ifTest.StorageManager.loadData('fasts'))[0].id), 'b');

    console.log('\n  Survives a reload (really persisted, not in memory)');
    await page.evaluate(() => window.__ifTest.StorageManager.saveData(
      'settings', { activePlanId: '18-6' }));
    await page.reload({ waitUntil: 'networkidle2' });
    check('settings survived', await page.evaluate(
      async () => (await window.__ifTest.StorageManager.loadData('settings')).activePlanId), '18-6');
    check('loadAppState picks it up', await page.evaluate(
      async () => (await window.__ifTest.loadAppState()).settings.activePlanId), '18-6');

    console.log('\n  A failing write reports failure');
    // Make IndexedDB unusable. defineProperty because window.indexedDB is an
    // accessor - a plain assignment fails silently and the test would pass
    // against a working store, proving nothing.
    const result = await page.evaluate(async () => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        value: { open() { const r = {}; setTimeout(() => r.onerror && r.onerror(), 0); return r; } },
      });
      const saved = await window.__ifTest.StorageManager.saveData('fasts', [{ id: 'c' }]);
      return { saved, warned: !!document.getElementById('storage-warning'), type: typeof saved };
    });
    check('returns false, not undefined', result.saved, false);
    check('…and it is a real boolean', result.type, 'boolean');
    check('the user is told', result.warned, true);

    // Reload rather than restoring the property by hand: indexedDB is not an
    // own property of window, so a captured descriptor comes back undefined and
    // "restoring" it deletes the API for the rest of the run.
    await page.reload({ waitUntil: 'networkidle2' });

    console.log('\n  Fresh install defaults');
    const fresh = await page.evaluate(async () => {
      const names = await indexedDB.databases();
      await Promise.all(names.map((d) => new Promise((res) => {
        const req = indexedDB.deleteDatabase(d.name);
        req.onsuccess = req.onerror = req.onblocked = () => res();
      })));
      const state = await window.__ifTest.loadAppState();
      return {
        fasts: state.fasts.length,
        weights: state.weights.length,
        plan: state.settings.activePlanId,
        backup: state.lastBackupAt,
      };
    });
    check('no fasts', fresh.fasts, 0);
    check('no weights', fresh.weights, 0);
    check('a default plan rather than undefined', fresh.plan, '16-8');
    check('no backup recorded', fresh.backup, null);
  } finally {
    await ctx.close();
  }

  process.exit(report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

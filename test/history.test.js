/**
 * History and time editing.
 *
 * Editing the start time is the most-used feature after the timer itself,
 * because forgetting to hit start is the normal case rather than the edge
 * case. It is also the most dangerous: these are the only writes that change
 * a fast after the fact, so a bad edit silently rewrites recorded history.
 *
 * The assertions concentrate on the rules that keep that safe - no future
 * times, no end before start, and no two fasts covering the same hours, which
 * would quietly double-count in every statistic later.
 *
 * Run with:  npm test
 */

const { boot, makeChecker, sleep } = require('./harness');

const PORT = 8235;
const HOUR = 3600000;

const seed = async (page, base, fasts) => {
  await page.evaluate(async (f) => {
    await window.__ifTest.StorageManager.saveData('fasts', f);
  }, fasts);
  await page.goto(base, { waitUntil: 'networkidle2' });
};

const fast = (over) => Object.assign({
  id: 'f' + Math.random().toString(36).slice(2, 8),
  startedAt: Date.now() - 20 * HOUR,
  endedAt: Date.now() - 4 * HOUR,
  goalHours: 16,
  planId: '16-8',
  editedAt: null,
}, over);

const text = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : null;
}, sel);

/** Type into the sheet's datetime field the way a person would. */
async function setField(page, id, timestamp) {
  await page.evaluate((args) => {
    const el = document.getElementById(args.id);
    el.value = window.__ifTest.toLocalInputValue(args.ts);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id, ts: timestamp });
}

async function main() {
  const { check, report } = makeChecker();
  const ctx = await boot(PORT);

  try {
    const page = await ctx.browser.newPage();
    page.on('pageerror', (e) => console.log('    page error:', e.message));
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });

    console.log('\n  Nothing recorded yet');
    check('empty state shown', await page.evaluate(
      () => document.getElementById('history-empty').classList.contains('is-shown')), true);
    check('no rows', await page.evaluate(
      () => document.querySelectorAll('#history-list .fast-row').length), 0);
    check('count reads zero', await text(page, '#history-count'), '0 fasts');

    console.log('\n  Local time conversion survives the round trip');
    // Built from local components on purpose: toISOString() is UTC and would
    // show an Irish evening fast as starting an hour earlier in summer.
    check('a timestamp round-trips to the same minute', await page.evaluate(() => {
      const { toLocalInputValue, fromLocalInputValue } = window.__ifTest;
      const t = new Date(2026, 6, 15, 20, 12, 0, 0).getTime(); // July: Irish summer time
      return fromLocalInputValue(toLocalInputValue(t)) === t;
    }), true);
    check('and in winter too', await page.evaluate(() => {
      const { toLocalInputValue, fromLocalInputValue } = window.__ifTest;
      const t = new Date(2026, 0, 15, 20, 12, 0, 0).getTime();
      return fromLocalInputValue(toLocalInputValue(t)) === t;
    }), true);

    console.log('\n  Listing');
    const now = Date.now();
    await seed(page, ctx.base, [
      fast({ id: 'old', startedAt: now - 60 * HOUR, endedAt: now - 44 * HOUR }),
      fast({ id: 'mid', startedAt: now - 40 * HOUR, endedAt: now - 26 * HOUR }),
      fast({ id: 'new', startedAt: now - 20 * HOUR, endedAt: now - 2 * HOUR }),
    ]);
    check('all three listed', await page.evaluate(
      () => document.querySelectorAll('#history-list .fast-row').length), 3);
    check('newest first', await page.evaluate(
      () => document.querySelector('#history-list .fast-row').dataset.fastId), 'new');
    check('empty state hidden', await page.evaluate(
      () => document.getElementById('history-empty').classList.contains('is-shown')), false);
    check('count updated', await text(page, '#history-count'), '3 fasts');

    console.log('\n  Outcome is stated in words, not just colour');
    check('an 18h fast on a 16h goal met it', await page.evaluate(
      () => document.querySelector('[data-fast-id="new"] .chip').textContent), 'Goal met');
    check('a 14h fast says how short', await page.evaluate(
      () => document.querySelector('[data-fast-id="mid"] .chip').textContent), 'Short by 2h 00m');

    console.log('\n  Fixing a forgotten start (the gate)');
    await seed(page, ctx.base, [fast({ id: 'run', startedAt: now - 1 * HOUR, endedAt: null })]);
    check('timer shows the wrong hour first', await text(page, '#ring-elapsed'), '1h 00m');
    await page.evaluate(() => document.getElementById('edit-start-btn').click());
    check('sheet opened', await page.evaluate(
      () => document.getElementById('fast-editor').classList.contains('is-open')), true);
    check('end field hidden while running', await page.evaluate(
      () => document.getElementById('edit-ended-field').classList.contains('is-hidden')), true);
    check('and it says why', await page.evaluate(
      () => document.getElementById('edit-running-note').classList.contains('is-shown')), true);

    await setField(page, 'edit-started', now - 5 * HOUR);
    /*
     * Derived, not hard-coded. <input type="datetime-local"> has MINUTE
     * precision, so the seconds are truncated on the way in and the elapsed
     * time is 5h plus however far into a minute the test happened to start.
     * Asserting the literal "5h 00m" passed or failed depending on the clock.
     */
    check('summary previews the new duration', await page.evaluate(() => {
      const started = window.__ifTest.fromLocalInputValue(
        document.getElementById('edit-started').value);
      const expected = window.__ifTest.formatDuration(
        window.__ifTest.floorToMinute(Date.now() - started)) + ' so far';
      return document.getElementById('edit-summary').textContent.trim() === expected;
    }), true);
    check('save accepted', await page.evaluate(() => window.__ifTest.saveFastEdit()), true);
    check('the stored start really moved back five hours', await page.evaluate(() => {
      const f = window.__ifTest.activeFast();
      return Math.abs((Date.now() - f.startedAt) - 5 * 3600000) < 61000;
    }), true);
    check('timer now reads the corrected time', await page.evaluate(() => {
      const f = window.__ifTest.activeFast();
      const expected = window.__ifTest.formatDuration(
        window.__ifTest.floorToMinute(Date.now() - f.startedAt));
      return document.getElementById('ring-elapsed').textContent === expected;
    }), true);
    check('the change is marked as an edit', await page.evaluate(
      () => window.__ifTest.activeFast().editedAt !== null), true);
    check('sheet closed', await page.evaluate(
      () => document.getElementById('fast-editor').classList.contains('is-open')), false);

    console.log('\n  …and it survives a relaunch');
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });
    check('still five hours', await page.evaluate(() => {
      const f = window.__ifTest.activeFast();
      return Math.abs((Date.now() - f.startedAt) - 5 * 3600000) < 61000;
    }), true);
    check('still flagged as edited', await page.evaluate(
      () => document.querySelector('#history-list .plan').textContent.includes('edited')), true);

    console.log('\n  A running fast does not go stale in the list');
    /*
     * Reported from the app: a fast started at 18:24 read "15h 47m" at 12:12
     * the next day, which is two hours behind. renderHistory() ran on init and
     * on changes, the per-second tick only repainted the timer, and showView()
     * refreshed nothing - so a running row showed whatever it read when the app
     * was last launched.
     */
    await seed(page, ctx.base, [fast({ id: 'live', startedAt: now - 5 * HOUR, endedAt: null })]);
    await page.evaluate(() => window.__ifTest.showView('history'));
    const rowDuration = () => text(page, '.fast-row[data-fast-id="live"] .fast-duration');
    check('the row opens with the current elapsed time', await page.evaluate(() => {
      const f = window.__ifTest.activeFast();
      const expected = window.__ifTest.formatDuration(
        window.__ifTest.floorToMinute(Date.now() - f.startedAt));
      return document.querySelector('.fast-row[data-fast-id="live"] .fast-duration')
        .textContent === expected;
    }), true);

    // Move the start back and wait for the timer's own tick - calling the
    // refresh directly would pass even with it unwired from the interval,
    // which is exactly how the bug shipped.
    await page.evaluate(() => {
      window.__ifTest.activeFast().startedAt = Date.now() - 9 * 3600000;
    });
    await sleep(1400);
    check('and the running tick keeps it current',
      (await rowDuration()).startsWith('9h'), true);

    check('the count includes the running fast', await text(page, '#history-count'), '1 fast');

    // Re-entering the view recomputes rather than trusting the last render.
    await page.evaluate(() => {
      window.__ifTest.activeFast().startedAt = Date.now() - 12 * 3600000;
      window.__ifTest.showView('timer');
      window.__ifTest.showView('history');
    });
    check('re-opening History recomputes it',
      (await rowDuration()).startsWith('12h'), true);

    console.log('\n  Rules that keep an edit from corrupting history');
    const rule = (id, start, end) => page.evaluate(
      (a) => window.__ifTest.validateFastTimes(a.id, a.start, a.end), { id, start, end });
    check('a start in the future is refused', await rule('x', now + HOUR, null),
      'A fast cannot start in the future.');
    check('an end in the future is refused', await rule('x', now - HOUR, now + HOUR),
      'A fast cannot end in the future.');
    check('an end before the start is refused', await rule('x', now - HOUR, now - 2 * HOUR),
      'The end has to come after the start.');
    check('a zero-length fast is refused', await rule('x', now - HOUR, now - HOUR),
      'The end has to come after the start.');
    // Against the running fast itself: a fast never overlaps its own record,
    // so pulling its start back is allowed. Named explicitly because the block
    // above leaves that fast in place.
    check('a sensible edit is allowed', await rule('live', now - 6 * HOUR, null), null);

    console.log('\n  Overlaps are refused, because they would double-count');
    await seed(page, ctx.base, [
      fast({ id: 'a', startedAt: now - 40 * HOUR, endedAt: now - 24 * HOUR }),
      fast({ id: 'b', startedAt: now - 20 * HOUR, endedAt: now - 4 * HOUR }),
    ]);
    check('pulling one back over another is refused', await page.evaluate(
      (t) => (window.__ifTest.validateFastTimes('b', t - 30 * 3600000, t - 4 * 3600000) || '')
        .startsWith('That overlaps another fast'), now), true);
    check('a fast may still be edited against itself', await page.evaluate(
      (t) => window.__ifTest.validateFastTimes('b', t - 22 * 3600000, t - 4 * 3600000), now), null);
    check('touching end-to-start is fine', await page.evaluate(
      (t) => window.__ifTest.validateFastTimes('b', t - 24 * 3600000, t - 4 * 3600000), now), null);

    console.log('\n  A rejected edit changes nothing');
    await page.evaluate(() => window.__ifTest.openFastEditor('b'));
    await setField(page, 'edit-started', now - 30 * HOUR);
    check('save refused', await page.evaluate(() => window.__ifTest.saveFastEdit()), false);
    check('the reason is shown', await page.evaluate(
      () => document.getElementById('edit-error').classList.contains('is-shown')), true);
    check('the stored start is untouched', await page.evaluate(
      () => window.__ifTest.appState.fasts.find((f) => f.id === 'b').startedAt), now - 20 * HOUR);
    check('sheet stays open to fix it', await page.evaluate(
      () => document.getElementById('fast-editor').classList.contains('is-open')), true);

    console.log('\n  Deleting takes two taps');
    await page.evaluate(() => window.__ifTest.closeFastEditor());
    await page.evaluate(() => window.__ifTest.openFastEditor('a'));
    const del = () => page.evaluate(
      () => document.getElementById('fast-editor-delete').click());
    await del();
    check('one tap only arms it', await page.evaluate(
      () => window.__ifTest.appState.fasts.length), 2);
    check('and says what the next tap does', await text(page, '#fast-editor-delete'),
      'Tap again to delete for good');
    check('reopening disarms it', await page.evaluate(() => {
      window.__ifTest.closeFastEditor();
      window.__ifTest.openFastEditor('a');
      return document.getElementById('fast-editor-delete').textContent;
    }), 'Delete this fast');
    await del();
    await del();
    check('two taps delete', await page.evaluate(
      () => window.__ifTest.appState.fasts.length), 1);
    check('one row left', await page.evaluate(
      () => document.querySelectorAll('#history-list .fast-row').length), 1);
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });
    check('and it stays deleted', await page.evaluate(
      () => window.__ifTest.appState.fasts.length), 1);
  } finally {
    await ctx.close();
  }

  process.exit(report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

/**
 * Statistics and the calendar heatmap.
 *
 * Almost everything here turns on one decision: a fast belongs to the local day
 * it STARTED on. A 16:8 fast normally crosses midnight, so attributing it by
 * the end would move most fasts to the following day, and deriving the day from
 * toISOString() would file an Irish evening fast under tomorrow for half the
 * year. The whole suite therefore runs in Europe/Dublin rather than UTC, so a
 * UTC-shaped bug cannot hide behind the test environment's timezone.
 *
 * Run with:  npm test
 */

const { boot, makeChecker } = require('./harness');

const PORT = 8238;
const HOUR = 3600000;
const DAY = 86400000;

/** Put fasts straight into memory and recompute, with a fixed "now". */
async function withFasts(page, fasts, fn) {
  return page.evaluate((args) => {
    window.__ifTest.appState.fasts = args.fasts;
    return args.expr === 'stats'
      ? window.__ifTest.computeStats(args.now)
      : window.__ifTest.heatLevels(args.fasts, args.now);
  }, { fasts, now: fn.now, expr: fn.expr });
}

/** A completed fast: started `startAgo` days back at `hour`, lasting `hours`. */
function fastAt(page, spec) {
  return spec;
}

async function main() {
  const { check, report } = makeChecker();
  const ctx = await boot(PORT);

  try {
    const page = await ctx.browser.newPage();
    // Irish time, so the local-day logic is exercised properly - and so the
    // DST cases below are real rather than nominal.
    await page.emulateTimezone('Europe/Dublin');
    page.on('pageerror', (e) => console.log('    page error:', e.message));
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });

    // Build fasts in the PAGE's timezone so the fixtures mean what they say.
    const build = (specs, nowSpec) => page.evaluate((args) => {
      const at = (s) => new Date(s.y, s.m - 1, s.d, s.h, s.min || 0).getTime();
      window.__now = at(args.nowSpec);
      return args.specs.map((s, i) => {
        const started = at(s);
        return {
          id: 'f' + i,
          startedAt: started,
          endedAt: s.hours === null ? null : started + s.hours * 3600000,
          goalHours: s.goal || 16,
          planId: '16-8',
          editedAt: null,
        };
      });
    }, { specs, nowSpec });

    console.log('\n  Nothing recorded yet');
    const empty = await page.evaluate(() => {
      window.__ifTest.appState.fasts = [];
      return window.__ifTest.computeStats(Date.now());
    });
    check('no streak', empty.streak, 0);
    check('no rate to report', empty.goalRate, null);
    check('no average', empty.average30, null);
    check('no longest', empty.longest, null);

    console.log('\n  A streak is consecutive days that met the goal');
    // 10-13 June 2026, each an 17h fast against a 16h goal. "Now" is the 13th.
    let fasts = await build(
      [{ y: 2026, m: 6, d: 10, h: 20, hours: 17 },
       { y: 2026, m: 6, d: 11, h: 20, hours: 17 },
       { y: 2026, m: 6, d: 12, h: 20, hours: 17 },
       { y: 2026, m: 6, d: 13, h: 20, hours: 17 }],
      { y: 2026, m: 6, d: 13, h: 23 });
    let now = await page.evaluate(() => window.__now);
    check('four days running', (await withFasts(page, fasts, { now, expr: 'stats' })).streak, 4);

    console.log('\n  Today being unfinished does not break it');
    // Same run, but nothing recorded yet on the 13th and it is only 09:00.
    fasts = await build(
      [{ y: 2026, m: 6, d: 10, h: 20, hours: 17 },
       { y: 2026, m: 6, d: 11, h: 20, hours: 17 },
       { y: 2026, m: 6, d: 12, h: 20, hours: 17 }],
      { y: 2026, m: 6, d: 13, h: 9 });
    now = await page.evaluate(() => window.__now);
    check('counts back from yesterday', (await withFasts(page, fasts, { now, expr: 'stats' })).streak, 3);

    console.log('\n  A missed day ends it, a short fast does not count');
    fasts = await build(
      [{ y: 2026, m: 6, d: 9, h: 20, hours: 17 },
       { y: 2026, m: 6, d: 11, h: 20, hours: 17 },
       { y: 2026, m: 6, d: 12, h: 20, hours: 17 }],
      { y: 2026, m: 6, d: 12, h: 23 });
    now = await page.evaluate(() => window.__now);
    check('the gap on the 10th cuts it to two', (await withFasts(page, fasts, { now, expr: 'stats' })).streak, 2);

    fasts = await build(
      [{ y: 2026, m: 6, d: 11, h: 20, hours: 17 },
       { y: 2026, m: 6, d: 12, h: 20, hours: 14 }],
      { y: 2026, m: 6, d: 12, h: 23 });
    now = await page.evaluate(() => window.__now);
    check('a 14h fast against a 16h goal breaks it',
      (await withFasts(page, fasts, { now, expr: 'stats' })).streak, 0);

    // The distinction the previous rule could not make: a fast still RUNNING
    // today has not fallen short yet, so it must not break anything.
    const running = await page.evaluate((args) => {
      const started = new Date(2026, 5, 12, 20, 0).getTime();
      const done = { id: 'a', startedAt: new Date(2026, 5, 11, 20, 0).getTime(),
        endedAt: new Date(2026, 5, 12, 13, 0).getTime(), goalHours: 16,
        planId: '16-8', editedAt: null };
      const live = { id: 'b', startedAt: started, endedAt: null, goalHours: 16,
        planId: '16-8', editedAt: null };
      window.__ifTest.appState.fasts = [done, live];
      return window.__ifTest.computeStats(args.now).streak;
    }, { now });
    check('a fast still running today keeps yesterday\'s streak', running, 1);

    console.log('\n  Rate, average and longest');
    fasts = await build(
      [{ y: 2026, m: 6, d: 10, h: 20, hours: 18 },
       { y: 2026, m: 6, d: 11, h: 20, hours: 14 },
       { y: 2026, m: 6, d: 12, h: 20, hours: 16 },
       { y: 2026, m: 6, d: 13, h: 20, hours: 20 }],
      { y: 2026, m: 6, d: 13, h: 23 });
    now = await page.evaluate(() => window.__now);
    let stats = await withFasts(page, fasts, { now, expr: 'stats' });
    check('three of four met the goal', stats.goalRate, 75);
    check('the average is of all four', Math.round(stats.average30 / HOUR), 17);
    check('longest is the 20h one', Math.round(stats.longest / HOUR), 20);
    check('four completed', stats.total, 4);

    console.log('\n  The 30-day window excludes older fasts');
    fasts = await build(
      [{ y: 2026, m: 4, d: 1, h: 20, hours: 24 },
       { y: 2026, m: 6, d: 12, h: 20, hours: 16 }],
      { y: 2026, m: 6, d: 13, h: 23 });
    now = await page.evaluate(() => window.__now);
    stats = await withFasts(page, fasts, { now, expr: 'stats' });
    check('the April fast is out of the average', Math.round(stats.average30 / HOUR), 16);
    check('but still counts as the longest', Math.round(stats.longest / HOUR), 24);
    check('and still counts toward the rate', stats.goalRate, 100);

    console.log('\n  Heatmap grid');
    const levels = await withFasts(page, fasts, { now, expr: 'heat' });
    check('thirteen weeks of seven days', levels.length, 91);
    check('days after today are blank', await page.evaluate((args) => {
      const l = window.__ifTest.heatLevels([], args.now);
      return l.every((x) => x === 0);
    }, { now }), true);

    console.log('\n  Levels follow the hours fasted');
    const level = (h) => page.evaluate((x) => window.__ifTest.heatLevel(x * 3600000), h);
    check('nothing recorded', await level(0), 0);
    check('a short fast', await level(10), 1);
    check('a middling one', await level(13), 2);
    check('a full 16:8', await level(17), 3);
    check('a very long one', await level(21), 4);

    console.log('\n  A fast is filed under the day it STARTED');
    // 20:00 on the 12th, ending 12:00 on the 13th. It belongs to the 12th.
    const crossing = await page.evaluate(() => {
      const started = new Date(2026, 5, 12, 20, 0).getTime();
      const fast = { id: 'x', startedAt: started, endedAt: started + 16 * 3600000,
        goalHours: 16, planId: '16-8', editedAt: null };
      const byDay = window.__ifTest.fastsByDay([fast]);
      const twelfth = new Date(2026, 5, 12).getTime();
      const thirteenth = new Date(2026, 5, 13).getTime();
      return { on12: byDay.has(twelfth), on13: byDay.has(thirteenth) };
    });
    check('counted on the start day', crossing.on12, true);
    check('not the day it ended', crossing.on13, false);

    console.log('\n  Irish summer time does not shift the day');
    // 23:30 on 28 June is 22:30 UTC, so slicing an ISO string would file this
    // under the 28th correctly - but 00:30 on the 29th local is 23:30 UTC on
    // the 28th, which the UTC route gets WRONG. Both are checked.
    const dst = await page.evaluate(() => {
      const late = new Date(2026, 5, 28, 23, 30).getTime();
      const early = new Date(2026, 5, 29, 0, 30).getTime();
      const day = (ts) => new Date(window.__ifTest.startOfLocalDay(ts)).getDate();
      return { late: day(late), early: day(early),
               utcWouldSay: new Date(early).toISOString().slice(8, 10) };
    });
    check('23:30 stays on the 28th', dst.late, 28);
    check('00:30 belongs to the 29th', dst.early, 29);
    check('while the UTC route would have said the 28th', dst.utcWouldSay, '28');

    console.log('\n  The screen shows it');
    await page.evaluate(async (f) => {
      await window.__ifTest.StorageManager.saveData('fasts', f);
    }, fasts);
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });
    await page.evaluate(() => window.__ifTest.showView('stats'));
    check('the heatmap is drawn', await page.evaluate(
      () => document.querySelectorAll('#heatmap .heat-cell').length), 91);
    check('some cells are filled', await page.evaluate(
      () => [...document.querySelectorAll('#heatmap .heat-cell')]
        .some((c) => c.className !== 'heat-cell')), true);
    check('the longest tile is populated', await page.evaluate(
      () => document.getElementById('stat-longest').textContent.includes('24')), true);
  } finally {
    await ctx.close();
  }

  process.exit(report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

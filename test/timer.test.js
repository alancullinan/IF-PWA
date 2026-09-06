/**
 * Timer tests.
 *
 * The property under test is that elapsed time is DERIVED from the fast's
 * start timestamp rather than accumulated by the app. A fast runs 16-24+ hours
 * across screen locks, backgrounding, force quits and reboots. Any counter the
 * app increments itself would drift when iOS throttles the page, reset when
 * the app is killed, or double-count if a resume path ran twice - and every
 * one of those failures produces a plausible-looking wrong number rather than
 * an error, which is the worst kind for a number you are trying to trust.
 *
 * So the assertions are mostly about time passing in awkward ways: a relaunch
 * mid-fast, several relaunches, and a fast that has run past its goal.
 *
 * Run with:  npm test
 */

const { boot, makeChecker, sleep } = require('./harness');

const PORT = 8233;
const HOUR = 3600000;

/** Put a fast straight into storage, then relaunch onto it. */
async function seedFast(page, base, fast) {
  await page.evaluate(async (f) => {
    await window.__ifTest.StorageManager.saveData('fasts', [f]);
  }, fast);
  await page.goto(base, { waitUntil: 'networkidle2' });
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

    console.log('\n  Duration formatting');
    const fmt = (ms) => page.evaluate((m) => window.__ifTest.formatDuration(m), ms);
    check('under an hour drops the hours', await fmt(42 * 60000), '42m');
    check('59 minutes is not yet an hour', await fmt(59 * 60000), '59m');
    check('an exact hour pads the minutes', await fmt(HOUR), '1h 00m');
    check('a long fast reads naturally', await fmt(13 * HOUR + 24 * 60000), '13h 24m');
    check('seconds never round a minute up', await fmt(59 * 60000 + 59000), '59m');
    check('negative clamps to zero', await fmt(-5000), '0m');

    console.log('\n  Nothing running');
    check('button offers to start', await text(page, '#fast-toggle-btn'), 'Start fast');
    check('centre shows the goal', await text(page, '#ring-elapsed'), '16h');
    check('no start time yet', await text(page, '#started-at'), '--:--');
    check('ring empty', await page.evaluate(
      () => document.getElementById('ring-progress').getAttribute('stroke-dasharray').startsWith('0 ')), true);

    console.log('\n  Starting a fast');
    await page.evaluate(() => window.__ifTest.startFast());
    check('button flips to end', await text(page, '#fast-toggle-btn'), 'End fast');
    check('one active fast', await page.evaluate(
      () => !!window.__ifTest.activeFast()), true);
    check('starting twice does not stack', await page.evaluate(async () => {
      await window.__ifTest.startFast();
      return window.__ifTest.appState.fasts.length;
    }), 1);

    console.log('\n  Force quit five hours in (the gate)');
    const startedAt = Date.now() - 5 * HOUR;
    await seedFast(page, ctx.base, {
      id: 'relaunch', startedAt, endedAt: null, goalHours: 16, planId: '16-8', editedAt: null,
    });
    check('elapsed derived from the start, not reset', await text(page, '#ring-elapsed'), '5h 00m');
    check('remaining follows from it', await text(page, '#ring-sub'), '11h 00m to go');
    check('the fast is still running', await page.evaluate(
      () => !!window.__ifTest.activeFast()), true);

    // The invariant behind that pair: whatever the offset into the minute,
    // the two lines on screen must always add up to the goal.
    check('elapsed + remaining always equals the goal', await page.evaluate(() => {
      const { floorToMinute, formatDuration } = window.__ifTest;
      const goal = 16 * 3600000;
      for (let extraMs = 0; extraMs < 60000; extraMs += 1237) {
        const ms = 5 * 3600000 + extraMs;
        const shown = floorToMinute(ms);
        if (formatDuration(shown) !== '5h 00m') return `elapsed drifted at +${extraMs}ms`;
        if (formatDuration(goal - shown) !== '11h 00m') return `remaining drifted at +${extraMs}ms`;
      }
      return 'ok';
    }), 'ok');

    console.log('\n  Relaunching repeatedly does not accumulate');
    for (let i = 0; i < 3; i++) await page.goto(ctx.base, { waitUntil: 'networkidle2' });
    check('still five hours after three relaunches', await text(page, '#ring-elapsed'), '5h 00m');
    check('start time unchanged', await page.evaluate(
      () => window.__ifTest.activeFast().startedAt), startedAt);

    console.log('\n  The clock actually advances');
    const before = await page.evaluate(() => window.__ifTest.elapsedMs(window.__ifTest.activeFast()));
    await sleep(2100);
    const after = await page.evaluate(() => window.__ifTest.elapsedMs(window.__ifTest.activeFast()));
    const delta = after - before;
    check('by roughly the wall time, not a jump', delta >= 1500 && delta <= 4000, true);

    console.log('\n  Past the goal it keeps counting');
    await seedFast(page, ctx.base, {
      id: 'over', startedAt: Date.now() - 18 * HOUR, endedAt: null,
      goalHours: 16, planId: '16-8', editedAt: null,
    });
    check('elapsed keeps going past 16h', await text(page, '#ring-elapsed'), '18h 00m');
    check('framed as success, not failure', await text(page, '#ring-sub'), '2h 00m past goal');
    check('ring caps at full', await page.evaluate(() => {
      const [drawn, total] = document.getElementById('ring-progress')
        .getAttribute('stroke-dasharray').split(' ').map(Number);
      return Math.abs(drawn - total) < 0.01;
    }), true);
    check('and is marked over', await page.evaluate(
      () => document.getElementById('ring').classList.contains('is-over')), true);

    console.log('\n  Ending a fast freezes it');
    const ended = await page.evaluate(async () => {
      const f = await window.__ifTest.endFast();
      return { endedAt: f.endedAt, ms: window.__ifTest.elapsedMs(f) };
    });
    check('an end time is recorded', typeof ended.endedAt === 'number', true);
    await sleep(1200);
    check('duration stops growing once ended', await page.evaluate(
      () => window.__ifTest.elapsedMs(window.__ifTest.appState.fasts[0])), ended.ms);
    check('nothing is active now', await page.evaluate(
      () => window.__ifTest.activeFast()), null);
    check('button offers to start again', await text(page, '#fast-toggle-btn'), 'Start fast');

    console.log('\n  A finished fast survives relaunch unchanged');
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });
    check('duration identical after reload', await page.evaluate(
      () => window.__ifTest.elapsedMs(window.__ifTest.appState.fasts[0])), ended.ms);

    console.log('\n  Plans');
    check('choosing a plan persists it', await page.evaluate(async () => {
      await window.__ifTest.setActivePlan('18-6');
      return (await window.__ifTest.StorageManager.loadData('settings')).activePlanId;
    }), '18-6');
    check('the new goal applies to the next fast', await page.evaluate(async () => {
      const f = await window.__ifTest.startFast();
      return f.goalHours;
    }), 18);
    check('a running fast keeps the goal it began with', await page.evaluate(async () => {
      await window.__ifTest.setActivePlan('20-4');
      return window.__ifTest.activeFast().goalHours;
    }), 18);

    console.log('\n  The stage timeline places you on the whole sequence');
    // 13h into a 16h fast: fed and post-meal are behind, burning fat is now,
    // ketosis and deep fast are still ahead.
    const timeline = await page.evaluate((h) => {
      const started = Date.now() - h * 3600000;
      const fast = { id: 't', startedAt: started, endedAt: null, goalHours: 16,
        planId: '16-8', editedAt: null };
      return window.__ifTest.stageTimeline(fast).map((r) => ({
        name: r.name, state: r.state, at: r.at, fromHours: r.fromHours }));
    }, 13);
    check('every stage is listed', timeline.length, 5);
    check('states run past then current then upcoming',
      timeline.map((r) => r.state).join(','),
      'past,past,current,upcoming,upcoming');
    check('exactly one is current',
      timeline.filter((r) => r.state === 'current').length, 1);
    check('times are anchored to the start', await page.evaluate((h) => {
      const started = Date.now() - h * 3600000;
      const fast = { id: 't', startedAt: started, endedAt: null, goalHours: 16,
        planId: '16-8', editedAt: null };
      const rows = window.__ifTest.stageTimeline(fast);
      return rows[3].at - fast.startedAt === 16 * 3600000;
    }, 13), true);

    console.log('\n  With nothing running the stages still make sense');
    const idle = await page.evaluate(
      () => window.__ifTest.stageTimeline(null).map((r) => r.state + ':' + r.at));
    check('none is current or past', idle.join(','),
      'upcoming:null,upcoming:null,upcoming:null,upcoming:null,upcoming:null');

    console.log('\n  Ring ticks only mark boundaries inside the goal');
    // A 16h goal contains the 4h and 12h boundaries; 24h has nowhere to sit.
    check('two ticks on a 16h fast', await page.evaluate(() => {
      const fast = { id: 'r', startedAt: Date.now() - 13 * 3600000, endedAt: null,
        goalHours: 16, planId: '16-8', editedAt: null };
      window.__ifTest.renderRingTicks(fast);
      return document.querySelectorAll('#ring-ticks .ring-tick').length;
    }), 2);
    check('both are marked as passed at 13h', await page.evaluate(
      () => document.querySelectorAll('#ring-ticks .ring-tick.is-passed').length), 2);
    check('a 20h goal fits three', await page.evaluate(() => {
      const fast = { id: 'r', startedAt: Date.now() - 2 * 3600000, endedAt: null,
        goalHours: 20, planId: '20-4', editedAt: null };
      window.__ifTest.renderRingTicks(fast);
      return document.querySelectorAll('#ring-ticks .ring-tick').length;
    }), 3);
    check('and only the passed one is filled in', await page.evaluate(
      () => document.querySelectorAll('#ring-ticks .ring-tick.is-passed').length), 0);
    check('no ticks when nothing is running', await page.evaluate(() => {
      window.__ifTest.renderRingTicks(null);
      return document.querySelectorAll('#ring-ticks .ring-tick').length;
    }), 0);

    console.log('\n  Opening the timeline from the timer');
    await page.evaluate(() => window.__ifTest.startFast());
    await page.evaluate(() => document.getElementById('stage-card').click());
    check('the sheet opens', await page.evaluate(
      () => document.getElementById('stages-sheet').classList.contains('is-open')), true);
    check('it lists every stage', await page.evaluate(
      () => document.querySelectorAll('#stage-list .stage-item').length), 5);
    check('the first stage is current on a fresh fast', await page.evaluate(
      () => document.querySelector('#stage-list .stage-item').className
        .includes('is-current')), true);
    check('and reads as now rather than a clock time', await page.evaluate(
      () => document.querySelector('#stage-list .stage-when').textContent), 'now');
    // A clock time alone is ambiguous across midnight: a 24h stage on a fast
    // begun at 00:06 also reads 00:06. Upcoming stages say how far off they are.
    check('upcoming stages say how far away they are', await page.evaluate(
      () => [...document.querySelectorAll('#stage-list .stage-item.is-upcoming .stage-when')]
        .every((el) => el.textContent.startsWith('in '))), true);
    // Matched loosely: the 24h stage on a fast started moments ago floors to
    // 23h 59m, and pinning the exact minute would drift with the clock.
    check('and the furthest stage is roughly a day out', await page.evaluate(
      () => /^in 23h \d\dm$/.test(
        document.querySelector('#stage-list .stage-item:last-child .stage-when')
          .textContent)), true);
    await page.evaluate(() => window.__ifTest.closeStageSheet());
    check('and closes again', await page.evaluate(
      () => document.getElementById('stages-sheet').classList.contains('is-open')), false);
    await page.evaluate(() => window.__ifTest.endFast());

    console.log('\n  Custom fast length');
    // This row existed in the markup from the scaffold but was never wired,
    // and no test covered it - so the app shipped a settings row that did
    // nothing at all.
    check('the row starts off', await page.evaluate(async () => {
      await window.__ifTest.setActivePlan('16-8');
      return document.getElementById('custom-plan-value').textContent;
    }), 'Off');

    check('opening it starts from the current preset', await page.evaluate(() => {
      window.__ifTest.openCustomSheet();
      return document.getElementById('custom-hours').textContent;
    }), '16');
    check('the sheet is open', await page.evaluate(
      () => document.getElementById('custom-sheet').classList.contains('is-open')), true);
    check('stepping changes the draft', await page.evaluate(
      () => window.__ifTest.nudgeCustomHours(1)), 17);
    check('the note explains the eating window', await page.evaluate(
      () => document.getElementById('custom-note').textContent),
      'Leaves a 7h eating window');

    check('saving selects it', await page.evaluate(async () => {
      await window.__ifTest.setCustomPlan(17);
      return window.__ifTest.appState.settings.activePlanId;
    }), 'custom');
    check('the row now shows the length', await page.evaluate(
      () => document.getElementById('custom-plan-value').textContent), '17h');
    check('no preset is selected', await page.evaluate(
      () => [...document.querySelectorAll('.preset')]
        .some((el) => el.getAttribute('aria-pressed') === 'true')), false);
    check('the timer chip shows the ratio', await page.evaluate(
      () => document.getElementById('plan-chip').textContent), '17:7');

    console.log('\n  A custom length is a real goal, and it persists');
    check('a new fast takes the custom hours', await page.evaluate(async () => {
      const f = await window.__ifTest.startFast();
      return { goal: f.goalHours, plan: f.planId };
    }).then((r) => r.goal + '/' + r.plan), '17/custom');
    await page.goto(ctx.base, { waitUntil: 'networkidle2' });
    check('it survives a relaunch', await page.evaluate(
      () => window.__ifTest.appState.settings.customHours), 17);
    check('and is still selected', await page.evaluate(
      () => document.getElementById('custom-plan-value').textContent), '17h');
    check('history labels it from its own hours', await page.evaluate(async () => {
      await window.__ifTest.endFast();
      return document.querySelector('#history-list .plan').textContent;
    }), '17:7');

    console.log('\n  Switching back to a preset');
    check('choosing a preset clears custom', await page.evaluate(async () => {
      await window.__ifTest.setActivePlan('18-6');
      return document.getElementById('custom-plan-value').textContent;
    }), 'Off');
    // The recorded fast must keep saying what it actually was.
    check('the old custom fast keeps its label', await page.evaluate(
      () => document.querySelector('#history-list .plan').textContent), '17:7');

    console.log('\n  Lengths stay sane');
    const clamp = (h) => page.evaluate((x) => window.__ifTest.clampCustomHours(x), h);
    check('zero is refused', await clamp(0), 1);
    check('and so is a fortnight', await clamp(400), 48);
    check('fractions round', await clamp(16.6), 17);
    check('nonsense falls back', await clamp('abc'), 16);
    check('beyond a day drops the ratio', await page.evaluate(
      () => window.__ifTest.customLabel(30)), '30h');

    console.log('\n  Each stage description describes that stage');
    /*
     * The notes were written for the single stage card, where a forward-looking
     * hint made sense, and reused verbatim as timeline rows - where "Ketosis
     * usually begins near 16h" sat under the heading "Burning fat" and simply
     * described the wrong stage. A row's description naming a DIFFERENT stage
     * is the shape of that mistake, so it is worth catching structurally.
     */
    check('no note names a different stage', await page.evaluate(() => {
      const rows = window.__ifTest.stageTimeline(null);
      const names = rows.map((r) => r.name);
      const offenders = rows.filter((row) => names
        .filter((n) => n !== row.name)
        .some((other) => new RegExp('\\b' + other + '\\b', 'i').test(row.note)));
      return offenders.map((r) => r.name).join(',');
    }), '');
    check('every stage has a description', await page.evaluate(
      () => window.__ifTest.stageTimeline(null)
        .every((r) => typeof r.note === 'string' && r.note.length > 8)), true);

    console.log('\n  Stages are approximate but ordered');
    const stage = (h) => page.evaluate((x) => window.__ifTest.stageFor(x).name, h);
    check('just eaten', await stage(0.5), 'Fed');
    check('mid-morning', await stage(6), 'Post-meal');
    check('twelve hours', await stage(12), 'Burning fat');
    check('sixteen hours', await stage(16), 'Ketosis');
    check('a full day', await stage(30), 'Deep fast');
  } finally {
    await ctx.close();
  }

  process.exit(report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

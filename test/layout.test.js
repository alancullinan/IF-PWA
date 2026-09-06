/**
 * Layout fit on real phone sizes.
 *
 * This exists because of a bug that every other suite was blind to: the app
 * was functionally perfect and the primary action was below the fold. The
 * "Start fast" button could not be reached without scrolling, and the tab bar
 * floated ~58px off the bottom edge.
 *
 * The cause was the bottom safe-area inset being counted twice - once as
 * padding on <body> and again as the tab bar's own margin - so the home
 * indicator's 34px became 58px of dead space, taken out of the view above it.
 *
 * env() reports 0 in headless Chrome, so each size injects the insets that a
 * real device would supply. Without that this suite would pass on a bug that
 * only appears on hardware, which is the exact failure it is here to prevent.
 *
 * Run with:  npm test
 */

const fsSync = require('fs');
const path = require('path');
const { boot, makeChecker, sleep, REPO } = require('./harness');

const PORT = 8236;

// width, height, and the safe-area insets iOS reports for each.
const DEVICES = [
  { name: 'iPhone SE',      w: 375, h: 667, top: 0,  bottom: 0 },
  { name: 'iPhone 13 mini', w: 375, h: 812, top: 50, bottom: 34 },
  { name: 'iPhone 15',      w: 390, h: 844, top: 59, bottom: 34 },
  { name: 'iPhone 15 Pro Max', w: 430, h: 932, top: 59, bottom: 34 },
  { name: 'small Android',  w: 360, h: 740, top: 0,  bottom: 0 },
];

/**
 * The double-count, checked statically.
 *
 * env(safe-area-inset-bottom) reports 0 in headless Chrome, so re-adding it as
 * padding on <body> would be invisible to the measurements below and would
 * only reappear on a real phone. The rule is that exactly one element consumes
 * the bottom inset, and it is the tab bar.
 */
function checkBottomInsetOwnedOnce(check) {
  const css = fsSync.readFileSync(path.join(REPO, 'styles.css'), 'utf8');
  const bodyBlock = (css.match(/\nbody \{[^}]*\}/) || [''])[0];
  const tabbarBlock = (css.match(/\n\.tabbar \{[^}]*\}/) || [''])[0];

  check('body does not also consume the bottom inset',
    /padding-bottom:\s*env\(safe-area-inset-bottom/.test(bodyBlock), false);
  check('the tab bar is what consumes it',
    /env\(safe-area-inset-bottom/.test(tabbarBlock), true);
  // max(), not addition - otherwise the inset and the margin stack again.
  // Matched loosely on purpose: the argument before env() is itself a var(),
  // so anything excluding ')' stops at the wrong paren.
  const insetMargin = (tabbarBlock.match(/margin:[^;]*;/) || [''])[0];
  check('and takes the larger of margin or inset, never the sum',
    /max\(/.test(insetMargin) && /env\(safe-area-inset-bottom/.test(insetMargin), true);
}

async function main() {
  const { check, report } = makeChecker();

  console.log('\n  The bottom inset is owned by exactly one element');
  checkBottomInsetOwnedOnce(check);

  const ctx = await boot(PORT);

  try {
    const page = await ctx.browser.newPage();

    for (const d of DEVICES) {
      console.log(`\n  ${d.name} (${d.w}x${d.h})`);
      await page.setViewport({ width: d.w, height: d.h });
      await page.goto(ctx.base, { waitUntil: 'networkidle2' });
      await page.addStyleTag({ content:
        `body{padding-top:${d.top}px!important}` +
        `.tabbar{margin-bottom:${Math.max(8, d.bottom)}px!important}` });
      await sleep(200);

      const m = await page.evaluate(() => {
        const view = document.getElementById('timer-view');
        const btn = document.getElementById('fast-toggle-btn').getBoundingClientRect();
        const nav = document.querySelector('.tabbar').getBoundingClientRect();
        return {
          overflow: view.scrollHeight - view.clientHeight,
          buttonHidden: btn.bottom > nav.top + 1,
          navGap: Math.round(window.innerHeight - nav.bottom),
          buttonHeight: Math.round(btn.height),
        };
      });

      check('timer view fits without scrolling', m.overflow <= 0, true);
      check('the start/end button is reachable', m.buttonHidden, false);
      // The gap below the nav must be the inset itself, never inset + margin.
      check('nav sits on the safe-area edge, not above it',
        m.navGap <= Math.max(8, d.bottom) + 1, true);
      check('the button keeps a full touch target', m.buttonHeight >= 44, true);
    }
  } finally {
    await ctx.close();
  }

  process.exit(report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

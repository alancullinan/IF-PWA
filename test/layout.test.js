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
  { name: 'iPhone 15 Pro',  w: 393, h: 852, top: 59, bottom: 34 },
  { name: 'iPhone 15 Pro Max', w: 430, h: 932, top: 59, bottom: 34 },
  { name: 'small Android',  w: 360, h: 740, top: 0,  bottom: 0 },
  // Measured from a real iPhone 15 Pro, which reported a bottom inset far
  // larger than the home indicator needs and floated the nav ~93pt up.
  { name: 'iPhone 15 Pro, oversized inset', w: 393, h: 852, top: 59, bottom: 93 },
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
  const viewBlock = (css.match(/\n\.view \{[^}]*\}/) || [''])[0];
  const htmlBody = (css.match(/\nhtml, body \{[^}]*\}/) || [''])[0];

  /*
   * The shell must be one LARGE viewport tall.
   *
   * Three ways of saying "full height" disagree on an installed iOS app:
   * 100vh is the large viewport (the whole screen), position:fixed inset:0
   * resolves to the visual viewport (measured at 793pt on an 852pt screen),
   * and height:100% resolves against a box that already excludes the status
   * bar. The last two both leave a strip of screen the app never draws on.
   */
  check('the shell is sized with 100vh', /height:\s*100vh/.test(bodyBlock), true);
  check('not with a percentage height',
    /height:\s*100%/.test(htmlBody) || /height:\s*100%/.test(bodyBlock), false);
  check('and not pinned to the visual viewport',
    /position:\s*fixed/.test(bodyBlock), false);
  check('body cannot scroll itself', /overflow:\s*hidden/.test(bodyBlock), true);
  check('body does not drag or bounce',
    /overscroll-behavior:\s*none/.test(bodyBlock), true);

  // Each inset is handled by the element that touches that edge, and only it.
  check('body takes neither inset',
    /env\(safe-area-inset/.test(bodyBlock), false);
  check('the view takes the top inset',
    /env\(safe-area-inset-top/.test(viewBlock), true);
  check('the view contains its own scrolling',
    /overscroll-behavior:\s*contain/.test(viewBlock), true);
  check('body does not also consume the bottom inset',
    /padding-bottom:\s*env\(safe-area-inset-bottom/.test(bodyBlock), false);
  check('the tab bar is what consumes it',
    /env\(safe-area-inset-bottom/.test(tabbarBlock), true);
  // clamp(), not addition and not an unbounded max: the inset is both floored
  // (phones reporting none still get a margin) and capped (a phone reporting
  // far more than a home indicator needs cannot drag the app upward).
  // Matched loosely on purpose: the argument before env() is itself a var(),
  // so anything excluding ')' stops at the wrong paren.
  const insetMargin = (tabbarBlock.match(/margin:[^;]*;/) || [''])[0];
  check('the bottom gap is clamped, not summed or unbounded',
    /clamp\(/.test(insetMargin) && /env\(safe-area-inset-bottom/.test(insetMargin), true);
}

/**
 * The full-screen recipe, checked statically.
 *
 * black-translucent plus viewport-fit=cover is what makes the web view cover
 * the whole display - this is the combination Match Tracker uses on the same
 * hardware, where it demonstrably fills the screen. I briefly blamed
 * black-translucent for the gap and removed it; that was wrong, and the real
 * culprit was how the shell was SIZED (below).
 */
function checkFullScreenRecipe(check) {
  const html = fsSync.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const style = (html.match(/apple-mobile-web-app-status-bar-style"\s+content="([^"]+)"/) || [])[1];
  const viewport = (html.match(/name="viewport"\s+content="([^"]+)"/) || [])[1] || '';
  check('the status bar style is black-translucent', style, 'black-translucent');
  check('and the viewport covers the display', viewport.includes('viewport-fit=cover'), true);
}

async function main() {
  const { check, report } = makeChecker();

  console.log('\n  The web view fills the screen');
  checkFullScreenRecipe(check);

  console.log('\n  The bottom inset is owned by exactly one element');
  checkBottomInsetOwnedOnce(check);

  const ctx = await boot(PORT);

  try {
    const page = await ctx.browser.newPage();

    for (const d of DEVICES) {
      console.log(`\n  ${d.name} (${d.w}x${d.h})`);
      await page.setViewport({ width: d.w, height: d.h });
      await page.goto(ctx.base, { waitUntil: 'networkidle2' });
      // env() reports 0 here, so feed each inset to the element that owns it,
      // through the same clamp the stylesheet applies.
      const navGap = Math.min(Math.max(8, d.bottom), 34);
      await page.addStyleTag({ content:
        `.view{padding-top:${32 + d.top}px!important}` +
        `.tabbar{margin-bottom:${navGap}px!important}` });
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
      // The gap below the nav is the inset, floored at 8 and capped at 34 -
      // never inset + margin, and never an over-large inset taken at face value.
      check('nav sits on the safe-area edge, not above it',
        m.navGap <= 35, true);
      check('the button keeps a full touch target', m.buttonHeight >= 44, true);
    }
  } finally {
    await ctx.close();
  }

  process.exit(report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

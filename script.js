/*
 * Fasting Timer — all application logic.
 *
 * Single IIFE, no build step, no runtime dependencies. Phase 0 is the shell:
 * view switching, the service worker registration, and the render helpers the
 * later phases fill with real data.
 */
(function () {
  'use strict';

  const APP_VERSION = '0.1.0';

  // ---------------------------------------------------------------- views

  const VIEWS = ['timer', 'history', 'stats', 'settings'];

  /** Show one view and mark its tab current. Unknown names are ignored. */
  function showView(name) {
    if (!VIEWS.includes(name)) return;

    VIEWS.forEach((v) => {
      const section = document.getElementById(v + '-view');
      if (section) section.classList.toggle('is-active', v === name);
    });

    document.querySelectorAll('.tab').forEach((tab) => {
      const isCurrent = tab.dataset.view === name;
      tab.classList.toggle('is-active', isCurrent);
      // aria-current is the accessible signal; the colour alone is not enough.
      if (isCurrent) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });

    // A fresh view starts at the top rather than inheriting the last scroll.
    const active = document.getElementById(name + '-view');
    if (active) active.scrollTop = 0;
  }

  function wireNav() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => showView(tab.dataset.view));
    });
  }

  // ---------------------------------------------------------------- heatmap

  const HEAT_WEEKS = 13;
  const DAYS_PER_WEEK = 7;

  /**
   * Render the calendar heatmap from an array of levels (0-4, oldest first),
   * laid out as columns of weeks. Level 0 is "no fast recorded".
   *
   * Phase 5 supplies real levels; until then the caller passes a placeholder.
   */
  function renderHeatmap(levels) {
    const host = document.getElementById('heatmap');
    if (!host) return;

    host.textContent = '';
    for (let w = 0; w < HEAT_WEEKS; w++) {
      const col = document.createElement('div');
      col.className = 'heat-week';
      for (let d = 0; d < DAYS_PER_WEEK; d++) {
        const level = levels[w * DAYS_PER_WEEK + d] || 0;
        const cell = document.createElement('div');
        cell.className = 'heat-cell' + (level > 0 ? ' heat-' + level : '');
        col.appendChild(cell);
      }
      host.appendChild(col);
    }
  }

  /**
   * Deterministic stand-in so the shell renders something. Replaced in phase 5.
   *
   * Uses a small LCG rather than a repeating literal: any fixed-length cycle
   * lands on the same weekday every week and paints diagonal stripes across a
   * 7-row grid, which reads as a rendering fault rather than as data.
   */
  function placeholderHeatLevels() {
    const levels = [];
    let seed = 20260906;
    for (let i = 0; i < HEAT_WEEKS * DAYS_PER_WEEK; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const r = seed / 2147483648;
      // Weighted towards completed fasts, with the occasional missed day.
      levels.push(r < 0.12 ? 0 : r < 0.3 ? 2 : r < 0.55 ? 3 : 4);
    }
    return levels;
  }

  // ---------------------------------------------------------------- ring

  const RING_RADIUS = 100;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  /**
   * Paint the progress ring. `fraction` is elapsed/goal and may exceed 1 -
   * fasting past the goal is a success, not an error, so the arc caps at full
   * while the clock keeps counting.
   */
  function setRingProgress(fraction) {
    const arc = document.getElementById('ring-progress');
    const ring = document.getElementById('ring');
    if (!arc) return;

    const clamped = Math.max(0, Math.min(1, fraction));
    const drawn = clamped * RING_CIRCUMFERENCE;
    arc.setAttribute('stroke-dasharray', drawn + ' ' + RING_CIRCUMFERENCE);
    if (ring) ring.classList.toggle('is-over', fraction >= 1);
  }

  // ---------------------------------------------------------------- sw

  /**
   * Register the service worker.
   *
   * 'sw.js' is deliberately relative: from …/IF-PWA/ it resolves to
   * …/IF-PWA/sw.js and takes a default scope of …/IF-PWA/, which is exactly
   * the app. A leading slash would ask for a worker at the origin root, which
   * 404s here and would control the wrong scope if it did not.
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.error('Service worker registration failed:', err);
      });
    });
  }

  // ---------------------------------------------------------------- init

  function init() {
    wireNav();
    showView('timer');
    renderHeatmap(placeholderHeatLevels());
    setRingProgress(13.4 / 16);
  }

  registerServiceWorker();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /*
   * Test seam. Everything above lives inside this IIFE, so the Puppeteer suites
   * would otherwise have no way to reach it. Deliberately small: it exposes
   * behaviour under test, not the whole module.
   */
  window.__ifTest = {
    APP_VERSION,
    showView,
    setRingProgress,
    renderHeatmap,
  };
})();

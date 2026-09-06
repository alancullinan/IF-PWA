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

  // ---------------------------------------------------------------- storage

  /**
   * Persistence. IndexedDB ONLY.
   *
   * There is deliberately no localStorage tier, not even as a fallback. The
   * reference app for this project shipped a dual store - writing localStorage
   * first with an IndexedDB fallback, but READING localStorage first - and the
   * two silently diverged once localStorage hit quota: new records landed in
   * IndexedDB while every launch kept returning the older localStorage copy,
   * so recent data vanished without an error. A single store cannot have that
   * bug, because there is no second copy to disagree with.
   *
   * This app has no legacy data, so there is also no migration path to write.
   * Keep it that way: do not add a second store.
   */
  const StorageManager = {
    DB_NAME: 'FastingDB',
    DB_VERSION: 1,
    STORE_NAME: 'records',

    async initDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(this.STORE_NAME)) {
            db.createObjectStore(this.STORE_NAME, { keyPath: 'key' });
          }
        };
      });
    },

    /**
     * Save one key.
     *
     * @returns {Promise<boolean>} true only if the data is durably stored.
     *   Callers that care can react. Never swallow the error and return
     *   undefined: that makes a failed write indistinguishable from a
     *   successful one, which is how silent data loss starts.
     */
    async saveData(key, data) {
      try {
        const db = await this.initDB();
        const tx = db.transaction([this.STORE_NAME], 'readwrite');
        tx.objectStore(this.STORE_NAME).put({ key, data, timestamp: Date.now() });
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        return true;
      } catch (err) {
        console.error('Failed to save ' + key + ':', err);
        this.showStorageWarning();
        return false;
      }
    },

    /** Load one key, or null when absent or unreadable. */
    async loadData(key) {
      try {
        const db = await this.initDB();
        const tx = db.transaction([this.STORE_NAME], 'readonly');
        const request = tx.objectStore(this.STORE_NAME).get(key);
        return await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result ? request.result.data : null);
          request.onerror = () => reject(request.error);
        });
      } catch (err) {
        console.error('Failed to load ' + key + ':', err);
        return null;
      }
    },

    /** Real usage and quota, or null where the browser will not say. */
    async getStorageInfo() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      try {
        const { usage, quota } = await navigator.storage.estimate();
        return { usage: usage || 0, quota: quota || 0 };
      } catch {
        return null;
      }
    },

    /**
     * Ask the browser not to evict us. Best-effort and NOT eviction-proof:
     * iOS clears storage for sites unused for about a week regardless. Only an
     * off-device export actually survives that, which is why the backup phase
     * exists and why the app nags about a stale one.
     */
    async requestPersistence() {
      if (!navigator.storage || !navigator.storage.persist) return false;
      try {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      } catch {
        return false;
      }
    },

    showStorageWarning() {
      if (document.getElementById('storage-warning')) return;
      const el = document.createElement('div');
      el.id = 'storage-warning';
      el.className = 'storage-warning';
      el.setAttribute('role', 'alert');
      el.textContent = 'Could not save to this device. Export a backup before closing the app.';
      document.body.appendChild(el);
    },
  };

  // ---------------------------------------------------------------- state

  const STORAGE_KEYS = ['fasts', 'weights', 'settings', 'lastBackupAt'];

  const DEFAULT_SETTINGS = { activePlanId: '16-8' };

  const appState = {
    fasts: [],
    weights: [],
    settings: { ...DEFAULT_SETTINGS },
    lastBackupAt: null,
  };

  /** Read every key into appState, falling back to empty defaults. */
  async function loadAppState() {
    const [fasts, weights, settings, lastBackupAt] = await Promise.all(
      STORAGE_KEYS.map((k) => StorageManager.loadData(k))
    );
    appState.fasts = Array.isArray(fasts) ? fasts : [];
    appState.weights = Array.isArray(weights) ? weights : [];
    appState.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    appState.lastBackupAt = lastBackupAt || null;
    return appState;
  }

  /** Persist one slice of appState. Returns whether the write stuck. */
  async function saveAppState(key) {
    if (!STORAGE_KEYS.includes(key)) return false;
    return StorageManager.saveData(key, appState[key]);
  }

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

  // ---------------------------------------------------------------- plans

  const PLANS = [
    { id: '12-12', label: '12:12', goalHours: 12 },
    { id: '14-10', label: '14:10', goalHours: 14 },
    { id: '16-8',  label: '16:8',  goalHours: 16 },
    { id: '18-6',  label: '18:6',  goalHours: 18 },
    { id: '20-4',  label: '20:4',  goalHours: 20 },
    { id: 'omad',  label: 'OMAD',  goalHours: 23 },
  ];

  const planById = (id) => PLANS.find((p) => p.id === id) || PLANS[2];

  /**
   * Metabolic stages, by hours elapsed.
   *
   * These boundaries are approximate and vary a lot by person, last meal and
   * activity - the commercial apps state them as fact, which is worth not
   * copying. The copy says "usually" and "around" on purpose.
   */
  const STAGES = [
    { fromHours: 0,  name: 'Fed',          note: 'Digesting your last meal' },
    { fromHours: 4,  name: 'Post-meal',    note: 'Running on stored glucose' },
    { fromHours: 12, name: 'Burning fat',  note: 'Ketosis usually begins near 16h' },
    { fromHours: 16, name: 'Ketosis',      note: 'Roughly - it varies by person' },
    { fromHours: 24, name: 'Deep fast',    note: 'Autophagy markers rise around here' },
  ];

  function stageFor(hours) {
    let current = STAGES[0];
    for (const stage of STAGES) if (hours >= stage.fromHours) current = stage;
    return current;
  }

  // ---------------------------------------------------------------- time

  const HOUR_MS = 3600000;

  /** "13h 24m", or "42m" under an hour. Always floors: 59m is not yet an hour. */
  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm';
  }

  /**
   * Round an elapsed time down to the whole minute the UI actually shows.
   *
   * The remaining time must be derived from THIS, not from the raw elapsed
   * time: flooring the two independently lets them disagree, so five hours
   * into a sixteen-hour fast displayed "5h 00m" beside "10h 59m to go". Both
   * numbers were individually right and the pair was visibly wrong.
   */
  function floorToMinute(ms) {
    return Math.max(0, Math.floor(ms / 60000) * 60000);
  }

  /** Local wall clock, 24-hour. */
  function formatClock(timestamp) {
    const d = new Date(timestamp);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ---------------------------------------------------------------- fasts

  function newId() {
    return Date.now() + '-' + Math.floor(Math.random() * 1000000);
  }

  /** The one unfinished fast, or null. */
  function activeFast() {
    return appState.fasts.find((f) => f.endedAt === null) || null;
  }

  /**
   * Elapsed milliseconds for a fast.
   *
   * DERIVED, never accumulated. This is the single most important line in the
   * app: a fast runs 16-24+ hours across screen locks, backgrounding, force
   * quits and reboots, and any counter we increment ourselves would drift or
   * reset across all of those. Recomputing from the stored start timestamp is
   * correct by construction - there is no state to corrupt.
   */
  function elapsedMs(fast, now) {
    if (!fast) return 0;
    return (fast.endedAt !== null ? fast.endedAt : (now || Date.now())) - fast.startedAt;
  }

  async function startFast() {
    if (activeFast()) return null;
    const plan = planById(appState.settings.activePlanId);
    const fast = {
      id: newId(),
      startedAt: Date.now(),
      endedAt: null,
      goalHours: plan.goalHours,
      planId: plan.id,
      editedAt: null,
    };
    appState.fasts.push(fast);
    await saveAppState('fasts');
    startTicking();
    renderTimer();
    return fast;
  }

  async function endFast() {
    const fast = activeFast();
    if (!fast) return null;
    fast.endedAt = Date.now();
    await saveAppState('fasts');
    stopTicking();
    renderTimer();
    return fast;
  }

  async function setActivePlan(planId) {
    const plan = planById(planId);
    appState.settings.activePlanId = plan.id;
    await saveAppState('settings');
    renderPresets();
    renderTimer();
    return plan;
  }

  // ---------------------------------------------------------------- render

  function renderTimer() {
    const fast = activeFast();
    const plan = planById(appState.settings.activePlanId);

    const nameEl = document.getElementById('fast-name');
    const chipEl = document.getElementById('plan-chip');
    const elapsedEl = document.getElementById('ring-elapsed');
    const subEl = document.getElementById('ring-sub');
    const startedEl = document.getElementById('started-at');
    const endsEl = document.getElementById('ends-at');
    const stageNameEl = document.getElementById('stage-name');
    const stageNoteEl = document.getElementById('stage-note');
    const btn = document.getElementById('fast-toggle-btn');

    if (chipEl) chipEl.textContent = (fast ? planById(fast.planId) : plan).label;

    if (!fast) {
      if (nameEl) nameEl.textContent = 'Not fasting';
      if (elapsedEl) elapsedEl.textContent = plan.goalHours + 'h';
      if (subEl) subEl.textContent = 'Ready to start';
      if (startedEl) startedEl.textContent = '--:--';
      if (endsEl) endsEl.textContent = '--:--';
      if (stageNameEl) stageNameEl.textContent = 'Not fasting';
      if (stageNoteEl) stageNoteEl.textContent = 'Start a fast to track your stage';
      if (btn) btn.textContent = 'Start fast';
      setRingProgress(0);
      return;
    }

    const goalMs = fast.goalHours * HOUR_MS;
    const ms = elapsedMs(fast);
    // What the big number says; the sub-line is derived from it so the two
    // always add up to the goal exactly.
    const shownMs = floorToMinute(ms);
    const stage = stageFor(ms / HOUR_MS);

    if (nameEl) nameEl.textContent = 'Fasting';
    if (elapsedEl) elapsedEl.textContent = formatDuration(ms);
    // Past the goal is a success, not an error: keep counting and say so.
    if (subEl) {
      subEl.textContent = shownMs >= goalMs
        ? formatDuration(shownMs - goalMs) + ' past goal'
        : formatDuration(goalMs - shownMs) + ' to go';
    }
    if (startedEl) startedEl.textContent = formatClock(fast.startedAt);
    if (endsEl) endsEl.textContent = formatClock(fast.startedAt + goalMs);
    if (stageNameEl) stageNameEl.textContent = stage.name;
    if (stageNoteEl) stageNoteEl.textContent = stage.note;
    if (btn) btn.textContent = 'End fast';
    setRingProgress(ms / goalMs);
  }

  function renderPresets() {
    const active = appState.settings.activePlanId;
    document.querySelectorAll('.preset').forEach((el) => {
      el.setAttribute('aria-pressed', String(el.dataset.plan === active));
    });
  }

  // ---------------------------------------------------------------- ticking

  let tickHandle = null;

  /**
   * Drive the DISPLAY only. Nothing here writes state, so a missed, throttled
   * or coalesced tick - which iOS does freely to a backgrounded page - costs
   * one late repaint and never a wrong duration.
   */
  function startTicking() {
    stopTicking();
    tickHandle = setInterval(renderTimer, 1000);
  }

  function stopTicking() {
    if (tickHandle !== null) clearInterval(tickHandle);
    tickHandle = null;
  }

  function wireTimer() {
    const btn = document.getElementById('fast-toggle-btn');
    if (btn) btn.addEventListener('click', () => (activeFast() ? endFast() : startFast()));

    document.querySelectorAll('.preset').forEach((el) => {
      el.addEventListener('click', () => setActivePlan(el.dataset.plan));
    });

    // Returning to a backgrounded app: repaint at once rather than waiting up
    // to a second, since iOS will have stopped the interval entirely.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) renderTimer();
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

  async function init() {
    wireNav();
    wireTimer();
    showView('timer');
    renderHeatmap(placeholderHeatLevels());

    StorageManager.requestPersistence();
    await loadAppState();

    // Whatever was running before the app was closed picks straight back up:
    // the fast's start timestamp is all the state there is.
    renderPresets();
    renderTimer();
    if (activeFast()) startTicking();
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
    StorageManager,
    PLANS,
    appState,
    startFast,
    endFast,
    activeFast,
    elapsedMs,
    setActivePlan,
    renderTimer,
    formatDuration,
    formatClock,
    floorToMinute,
    stageFor,
    loadAppState,
    saveAppState,
    STORAGE_KEYS,
  };
})();

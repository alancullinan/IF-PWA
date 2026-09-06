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
    showView('timer');
    renderHeatmap(placeholderHeatLevels());
    setRingProgress(13.4 / 16);

    StorageManager.requestPersistence();
    await loadAppState();
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
    appState,
    loadAppState,
    saveAppState,
    STORAGE_KEYS,
  };
})();

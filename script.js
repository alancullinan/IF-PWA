/*
 * Fasting Timer — all application logic.
 *
 * Single IIFE, no build step, no runtime dependencies. Phase 0 is the shell:
 * view switching, the service worker registration, and the render helpers the
 * later phases fill with real data.
 */
(function () {
  'use strict';

  const APP_VERSION = '0.6.6';

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

    // Recompute on entry. History and Stats are both derived from the fasts,
    // and a running fast keeps changing while neither was being re-rendered -
    // so a running row showed whatever it read when the app was last launched.
    if (name === 'history') renderHistory();
    if (name === 'stats') renderStats();
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

  const CUSTOM_MIN_HOURS = 1;
  const CUSTOM_MAX_HOURS = 48;

  /** "17:7" while an eating window still makes sense, plain hours beyond a day. */
  function customLabel(hours) {
    return hours < 24 ? hours + ':' + (24 - hours) : hours + 'h';
  }

  /**
   * The plan a NEW fast would use.
   *
   * 'custom' is not in PLANS - it is a length the user set, kept in settings -
   * so it is resolved here rather than through planById(), which falls back to
   * 16:8 for anything it does not recognise.
   */
  function activePlan() {
    const settings = appState.settings;
    if (settings.activePlanId === 'custom') {
      const hours = clampCustomHours(settings.customHours);
      return { id: 'custom', label: customLabel(hours), goalHours: hours };
    }
    return planById(settings.activePlanId);
  }

  /**
   * The label for a fast that has already been recorded.
   *
   * A custom fast is labelled from its OWN goalHours, not from the current
   * setting: history has to keep saying what that fast actually was, even
   * after the custom length is changed or switched off.
   */
  function planLabelFor(fast) {
    return fast.planId === 'custom'
      ? customLabel(fast.goalHours)
      : planById(fast.planId).label;
  }

  function clampCustomHours(hours) {
    const n = Math.round(Number(hours));
    if (!Number.isFinite(n)) return 16;
    return Math.min(CUSTOM_MAX_HOURS, Math.max(CUSTOM_MIN_HOURS, n));
  }

  /**
   * Metabolic stages, by hours elapsed.
   *
   * These boundaries are approximate and vary a lot by person, last meal and
   * activity - the commercial apps state them as fact, which is worth not
   * copying. The copy says "usually" and "around" on purpose.
   */
  /*
   * Each note describes ITS OWN stage.
   *
   * These were first written for the single stage card, where only one stage is
   * visible and a forward-looking hint was useful - "Ketosis usually begins near
   * 16h" sat under "Burning fat". Read as a row in the timeline that is simply
   * wrong: it describes the next stage rather than this one. The timeline says
   * what is coming, with times, so no note needs to.
   *
   * The hedging lives in the sheet's closing line rather than in the rows, so a
   * row does not spend its one line of description on a caveat.
   */
  const STAGES = [
    { fromHours: 0,  name: 'Fed',         note: 'Digesting your last meal' },
    { fromHours: 4,  name: 'Post-meal',   note: 'Insulin falling, running on stored glucose' },
    { fromHours: 12, name: 'Burning fat', note: 'Glycogen low, so fat is broken down for fuel' },
    { fromHours: 16, name: 'Ketosis',     note: 'Ketones becoming a main fuel' },
    { fromHours: 24, name: 'Deep fast',   note: 'Autophagy markers rise' },
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
    const plan = activePlan();
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
    renderHistory();
    renderStats();
    return fast;
  }

  async function endFast() {
    const fast = activeFast();
    if (!fast) return null;
    fast.endedAt = Date.now();
    await saveAppState('fasts');
    stopTicking();
    renderTimer();
    renderHistory();
    renderStats();
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

  /** Switch to a custom length. Returns the hours actually stored. */
  async function setCustomPlan(hours) {
    const clamped = clampCustomHours(hours);
    appState.settings.activePlanId = 'custom';
    appState.settings.customHours = clamped;
    await saveAppState('settings');
    renderPresets();
    renderTimer();
    return clamped;
  }

  /**
   * The stages laid out against a fast, so the timer can show where you are on
   * the whole sequence rather than only which stage is current.
   *
   * With no fast running the stages still list, described by hour rather than
   * by clock time - there is no start to count from yet.
   */
  function stageTimeline(fast, now) {
    const when = now || Date.now();
    const hours = fast ? elapsedMs(fast, when) / HOUR_MS : null;

    return STAGES.map((stage, i) => {
      const next = STAGES[i + 1];
      const isCurrent = hours !== null
        && hours >= stage.fromHours
        && (!next || hours < next.fromHours);
      const isPast = hours !== null && !isCurrent && hours >= stage.fromHours;
      return {
        name: stage.name,
        note: stage.note,
        fromHours: stage.fromHours,
        at: fast ? fast.startedAt + stage.fromHours * HOUR_MS : null,
        state: isCurrent ? 'current' : isPast ? 'past' : 'upcoming',
      };
    });
  }

  /**
   * Stage boundaries marked on the ring band.
   *
   * Only boundaries that fall INSIDE the goal are drawn: the ring maps 0 to the
   * goal, so a 24h stage on a 16h fast has nowhere to sit and a tick crammed at
   * the end would misrepresent it. Marks the user has passed are drawn in the
   * ground colour so they read against the filled arc; the rest sit on the
   * track and take the muted tone.
   */
  function renderRingTicks(fast) {
    const host = document.getElementById('ring-ticks');
    if (!host) return;
    host.textContent = '';
    if (!fast) return;

    const goalHours = fast.goalHours;
    const elapsedHours = elapsedMs(fast) / HOUR_MS;
    const NS = 'http://www.w3.org/2000/svg';

    for (const stage of STAGES) {
      if (stage.fromHours <= 0 || stage.fromHours >= goalHours) continue;
      const fraction = stage.fromHours / goalHours;
      const angle = fraction * 2 * Math.PI - Math.PI / 2;
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', (120 + 100 * Math.cos(angle)).toFixed(2));
      dot.setAttribute('cy', (120 + 100 * Math.sin(angle)).toFixed(2));
      dot.setAttribute('r', '3');
      dot.setAttribute('class',
        'ring-tick' + (elapsedHours >= stage.fromHours ? ' is-passed' : ''));
      host.appendChild(dot);
    }
  }

  function renderStageSheet() {
    const list = document.getElementById('stage-list');
    if (!list) return;
    const fast = activeFast();
    const rows = stageTimeline(fast);

    list.textContent = '';
    rows.forEach((row, i) => {
      const item = document.createElement('li');
      item.className = 'stage-item is-' + row.state;

      const rail = document.createElement('div');
      rail.className = 'stage-rail';
      const dot = document.createElement('span');
      dot.className = 'stage-dot';
      rail.appendChild(dot);
      if (i < rows.length - 1) {
        const line = document.createElement('span');
        line.className = 'stage-line';
        rail.appendChild(line);
      }

      const label = document.createElement('div');
      label.className = 'stage-label';
      const title = document.createElement('div');
      title.className = 'stage-title';
      title.textContent = row.name;
      const detail = document.createElement('div');
      detail.className = 'stage-detail';
      detail.textContent = row.note;
      label.append(title, detail);

      const when = document.createElement('div');
      when.className = 'stage-when';
      when.textContent = describeStageTime(row, fast, Date.now());

      const body = document.createElement('div');
      body.className = 'stage-body';
      body.append(label, when);

      item.append(rail, body);
      list.appendChild(item);
    });
  }

  /**
   * When a stage happened, or how far off it is.
   *
   * Past stages take a clock time because "when did I pass it" is a fact;
   * upcoming ones take a relative time because "how long until ketosis" is the
   * actual question, and because a clock time alone is ambiguous across
   * midnight - a 24h stage on a fast begun at 00:06 also reads 00:06, which
   * looked like a bug rather than the next day.
   */
  function describeStageTime(row, fast, now) {
    if (row.state === 'current') return 'now';
    if (!fast) return row.fromHours === 0 ? 'at the start' : 'from ' + row.fromHours + 'h';
    if (row.state === 'past') return formatClock(row.at);
    return 'in ' + formatDuration(row.at - (now || Date.now()));
  }

  function openStageSheet() {
    renderStageSheet();
    document.getElementById('stages-sheet').classList.add('is-open');
  }

  function closeStageSheet() {
    document.getElementById('stages-sheet').classList.remove('is-open');
  }

  // ---------------------------------------------------------------- render

  function renderTimer() {
    const fast = activeFast();
    const plan = activePlan();

    const nameEl = document.getElementById('fast-name');
    const chipEl = document.getElementById('plan-chip');
    const elapsedEl = document.getElementById('ring-elapsed');
    const subEl = document.getElementById('ring-sub');
    const startedEl = document.getElementById('started-at');
    const endsEl = document.getElementById('ends-at');
    const stageNameEl = document.getElementById('stage-name');
    const stageNoteEl = document.getElementById('stage-note');
    const btn = document.getElementById('fast-toggle-btn');

    if (chipEl) chipEl.textContent = fast ? planLabelFor(fast) : plan.label;

    if (!fast) {
      if (nameEl) nameEl.textContent = 'Not fasting';
      if (elapsedEl) elapsedEl.textContent = plan.goalHours + 'h';
      if (subEl) subEl.textContent = 'Ready to start';
      if (startedEl) startedEl.textContent = '--:--';
      if (endsEl) endsEl.textContent = '--:--';
      if (btn) btn.textContent = 'Start fast';
      const card = document.getElementById('stage-card');
      if (card) card.classList.add('is-hidden');
      setRingProgress(0);
      renderRingTicks(null);
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
    const card = document.getElementById('stage-card');
    if (card) card.classList.remove('is-hidden');
    if (btn) btn.textContent = 'End fast';
    setRingProgress(ms / goalMs);
    renderRingTicks(fast);
    // Keep an open sheet honest as the fast advances past a boundary.
    if (document.getElementById('stages-sheet').classList.contains('is-open')) {
      renderStageSheet();
    }
  }

  /**
   * Refresh just the running fast's row, once a second, while History is open.
   *
   * The whole list is deliberately NOT rebuilt on the tick: it would discard
   * and recreate every row a second at a time for one changing number. The row
   * is rebuilt through buildFastRow() so its duration and chip stay
   * consistent with every other row rather than being formatted twice.
   */
  function refreshRunningRow() {
    const fast = activeFast();
    if (!fast) return;
    if (!document.querySelector('#history-view.is-active')) return;
    const existing = document.querySelector('.fast-row[data-fast-id="' + fast.id + '"]');
    if (existing) existing.replaceWith(buildFastRow(fast));
  }

  function renderPresets() {
    const active = appState.settings.activePlanId;
    document.querySelectorAll('.preset').forEach((el) => {
      el.setAttribute('aria-pressed', String(el.dataset.plan === active));
    });

    const row = document.getElementById('custom-plan-btn');
    const value = document.getElementById('custom-plan-value');
    const isCustom = active === 'custom';
    if (row) row.setAttribute('aria-pressed', String(isCustom));
    if (value) {
      value.textContent = isCustom
        ? clampCustomHours(appState.settings.customHours) + 'h'
        : 'Off';
    }
  }

  // ------------------------------------------------------------ custom sheet

  let customDraftHours = 16;

  function renderCustomSheet() {
    const hours = customDraftHours;
    document.getElementById('custom-hours').textContent = hours;
    document.getElementById('custom-note').textContent = hours < 24
      ? 'Leaves a ' + (24 - hours) + 'h eating window'
      : 'Longer than a day, so there is no daily eating window';
    document.getElementById('custom-minus').disabled = hours <= CUSTOM_MIN_HOURS;
    document.getElementById('custom-plus').disabled = hours >= CUSTOM_MAX_HOURS;
  }

  function openCustomSheet() {
    const settings = appState.settings;
    // Start from the custom length if there is one, otherwise from whatever
    // preset is selected - adjusting from where you are beats starting at 16.
    customDraftHours = settings.activePlanId === 'custom'
      ? clampCustomHours(settings.customHours)
      : activePlan().goalHours;
    renderCustomSheet();
    document.getElementById('custom-sheet').classList.add('is-open');
  }

  function closeCustomSheet() {
    document.getElementById('custom-sheet').classList.remove('is-open');
  }

  function nudgeCustomHours(delta) {
    customDraftHours = clampCustomHours(customDraftHours + delta);
    renderCustomSheet();
    return customDraftHours;
  }

  function wireCustomPlan() {
    const open = document.getElementById('custom-plan-btn');
    if (open) open.addEventListener('click', openCustomSheet);
    document.getElementById('custom-cancel').addEventListener('click', closeCustomSheet);
    document.getElementById('custom-minus').addEventListener('click', () => nudgeCustomHours(-1));
    document.getElementById('custom-plus').addEventListener('click', () => nudgeCustomHours(1));
    document.getElementById('custom-save').addEventListener('click', async () => {
      await setCustomPlan(customDraftHours);
      closeCustomSheet();
    });
    document.getElementById('custom-off').addEventListener('click', async () => {
      // Fall back to the nearest preset rather than a fixed one, so turning
      // custom off does not silently move the goal further than expected.
      const nearest = PLANS.reduce((best, plan) =>
        Math.abs(plan.goalHours - customDraftHours) < Math.abs(best.goalHours - customDraftHours)
          ? plan : best);
      await setActivePlan(nearest.id);
      closeCustomSheet();
    });
    document.getElementById('custom-sheet').addEventListener('click', (event) => {
      if (event.target.id === 'custom-sheet') closeCustomSheet();
    });
  }

  // ---------------------------------------------------------------- history

  /**
   * Local date/time in the form <input type="datetime-local"> expects.
   *
   * Built from local components deliberately: toISOString() is UTC and would
   * show an Irish evening fast as having started an hour earlier in summer.
   */
  function toLocalInputValue(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** Parse that back. A value with no zone is read as local time, which is what we want. */
  function fromLocalInputValue(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  const fastDurationMs = (fast) => elapsedMs(fast);

  /**
   * Check a proposed pair of timestamps.
   *
   * Returns an error string, or null when the edit is allowed. The overlap
   * rule matters more than it looks: two fasts covering the same hours would
   * quietly double-count in every statistic later.
   */
  function validateFastTimes(fastId, startedAt, endedAt) {
    const now = Date.now();
    if (startedAt === null) return 'Give a start time.';
    if (startedAt > now) return 'A fast cannot start in the future.';
    if (endedAt !== null) {
      if (endedAt > now) return 'A fast cannot end in the future.';
      if (endedAt <= startedAt) return 'The end has to come after the start.';
    }
    const finish = endedAt === null ? now : endedAt;
    const clash = appState.fasts.find((f) => {
      if (f.id === fastId) return false;
      const otherFinish = f.endedAt === null ? now : f.endedAt;
      return startedAt < otherFinish && f.startedAt < finish;
    });
    if (clash) return 'That overlaps another fast on ' + formatDayLabel(clash.startedAt) + '.';
    return null;
  }

  /** "Wed 3 Sep" */
  function formatDayLabel(timestamp) {
    return new Date(timestamp).toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
    });
  }

  /** "September", or "September 2025" when it is not the current year. */
  function formatMonthLabel(timestamp) {
    const d = new Date(timestamp);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear
      ? { month: 'long' }
      : { month: 'long', year: 'numeric' });
  }

  /** Newest first. */
  function fastsNewestFirst() {
    return appState.fasts.slice().sort((a, b) => b.startedAt - a.startedAt);
  }

  function renderHistory() {
    const list = document.getElementById('history-list');
    const empty = document.getElementById('history-empty');
    const count = document.getElementById('history-count');
    if (!list) return;

    const fasts = fastsNewestFirst();

    // Counts what the list shows, including a fast still running. Counting only
    // finished ones read "0 fasts" directly above a visible row.
    if (count) {
      count.textContent = fasts.length === 1 ? '1 fast' : fasts.length + ' fasts';
    }
    if (empty) empty.classList.toggle('is-shown', fasts.length === 0);

    list.textContent = '';
    let lastMonth = null;

    for (const fast of fasts) {
      const month = formatMonthLabel(fast.startedAt);
      if (month !== lastMonth) {
        const heading = document.createElement('div');
        heading.className = 'section-label';
        heading.textContent = month;
        list.appendChild(heading);
        lastMonth = month;
      }
      list.appendChild(buildFastRow(fast));
    }
  }

  function buildFastRow(fast) {
    const goalMs = fast.goalHours * HOUR_MS;
    const ms = fastDurationMs(fast);
    const running = fast.endedAt === null;
    const met = ms >= goalMs;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'card fast-row is-editable';
    row.dataset.fastId = fast.id;

    const top = document.createElement('div');
    top.className = 'fast-row-top';
    const duration = document.createElement('div');
    duration.className = 'fast-duration';
    duration.textContent = formatDuration(ms);
    const chip = document.createElement('div');
    // Never colour alone: the chip says what happened in words.
    if (running) {
      chip.className = 'chip chip-short';
      chip.textContent = 'Running';
    } else if (met) {
      chip.className = 'chip chip-met';
      chip.textContent = 'Goal met';
    } else {
      chip.className = 'chip chip-short';
      chip.textContent = 'Short by ' + formatDuration(goalMs - ms);
    }
    top.append(duration, chip);

    const foot = document.createElement('div');
    foot.className = 'fast-row-foot';
    const when = document.createElement('div');
    when.textContent = formatDayLabel(fast.startedAt) + ' · ' + formatClock(fast.startedAt)
      + ' → ' + (running ? 'now' : formatClock(fast.endedAt));
    const plan = document.createElement('div');
    plan.className = 'plan';
    plan.textContent = planLabelFor(fast) + (fast.editedAt ? ' · edited' : '');
    foot.append(when, plan);

    /*
     * Two lines, no progress bar. The bar said nothing the chip did not: it
     * was full for every fast that met its goal - the common case - and where
     * it was short the chip already gives the shortfall to the minute. It cost
     * a third line on every row, and the list is for scanning many rows.
     */
    row.append(top, foot);
    return row;
  }

  // ---------------------------------------------------------------- editing

  let editingFastId = null;
  // Delete is irreversible and there is no undo, so it takes two taps. The
  // button states the consequence on the second one rather than just arming.
  let deleteArmed = false;

  function openFastEditor(fastId) {
    const fast = appState.fasts.find((f) => f.id === fastId);
    if (!fast) return;
    editingFastId = fastId;

    const running = fast.endedAt === null;
    document.getElementById('edit-started').value = toLocalInputValue(fast.startedAt);
    document.getElementById('edit-ended').value = running ? '' : toLocalInputValue(fast.endedAt);
    document.getElementById('edit-ended-field').classList.toggle('is-hidden', running);
    document.getElementById('edit-running-note').classList.toggle('is-shown', running);
    document.getElementById('fast-editor-title').textContent = running
      ? 'Edit running fast' : 'Edit fast';

    showEditError(null);
    updateEditSummary();
    disarmDelete();
    document.getElementById('fast-editor').classList.add('is-open');
  }

  function closeFastEditor() {
    editingFastId = null;
    disarmDelete();
    document.getElementById('fast-editor').classList.remove('is-open');
  }

  function disarmDelete() {
    deleteArmed = false;
    const btn = document.getElementById('fast-editor-delete');
    if (btn) {
      btn.textContent = 'Delete this fast';
      btn.classList.remove('is-armed');
    }
  }

  function showEditError(message) {
    const el = document.getElementById('edit-error');
    el.textContent = message || '';
    el.classList.toggle('is-shown', !!message);
  }

  /** Live duration readout, so the effect of an edit is visible before saving. */
  function updateEditSummary() {
    const el = document.getElementById('edit-summary');
    if (!el) return;
    const startedAt = fromLocalInputValue(document.getElementById('edit-started').value);
    const endedRaw = document.getElementById('edit-ended').value;
    const endedAt = endedRaw ? fromLocalInputValue(endedRaw) : null;
    if (startedAt === null) { el.textContent = ''; return; }
    const finish = endedAt === null ? Date.now() : endedAt;
    el.textContent = finish > startedAt
      ? formatDuration(finish - startedAt) + (endedAt === null ? ' so far' : '')
      : '';
  }

  async function saveFastEdit() {
    const fast = appState.fasts.find((f) => f.id === editingFastId);
    if (!fast) return false;

    const startedAt = fromLocalInputValue(document.getElementById('edit-started').value);
    const running = fast.endedAt === null;
    const endedRaw = document.getElementById('edit-ended').value;
    const endedAt = running ? null : fromLocalInputValue(endedRaw);

    const error = validateFastTimes(fast.id, startedAt, endedAt);
    if (error) { showEditError(error); return false; }

    fast.startedAt = startedAt;
    if (!running) fast.endedAt = endedAt;
    // Mark it so history stays honest about which times were adjusted.
    fast.editedAt = Date.now();

    const saved = await saveAppState('fasts');
    if (!saved) { showEditError('Could not save that change.'); return false; }

    closeFastEditor();
    renderTimer();
    renderHistory();
    renderStats();
    return true;
  }

  async function deleteFast(fastId) {
    const index = appState.fasts.findIndex((f) => f.id === fastId);
    if (index === -1) return false;
    appState.fasts.splice(index, 1);
    const saved = await saveAppState('fasts');
    stopTicking();
    if (activeFast()) startTicking();
    renderTimer();
    renderHistory();
    renderStats();
    return saved;
  }

  /**
   * Show which build is actually running, and offer a manual update check.
   *
   * An installed PWA can sit on a cached version for a long time, and without
   * this there is no way to tell a bug from a stale copy - which cost a full
   * round trip of guessing once already.
   */
  function renderAbout() {
    const el = document.getElementById('app-version');
    if (el) el.textContent = APP_VERSION;
  }

  async function fetchDeployedVersion() {
    try {
      // Cache-busted and no-store so neither the HTTP cache nor our own worker
      // can answer with the copy we are trying to look past.
      const response = await fetch('sw.js?probe=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) return null;
      const text = await response.text();
      const match = text.match(/CACHE_NAME = 'fasting-v([^']+)'/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Last resort: drop the worker and every cache, then reload.
   *
   * IndexedDB is deliberately untouched, so fasts and settings survive - this
   * is the recovery that does NOT cost the user their history, unlike deleting
   * the app from the Home Screen.
   */
  async function forceRefresh() {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch (err) {
      console.error('Force refresh failed:', err);
    }
    window.location.reload();
  }

  async function checkForUpdate() {
    const status = document.getElementById('update-status');
    const say = (message, good) => {
      if (!status) return;
      status.textContent = message;
      status.classList.add('is-shown');
      status.classList.toggle('is-good', !!good);
    };

    say('Checking…');
    const deployed = await fetchDeployedVersion();

    if (deployed === null) {
      say('Could not reach the server. Try again on a connection.');
      return false;
    }
    if (deployed === APP_VERSION) {
      say('You are on the latest version (' + deployed + ').', true);
      return false;
    }

    say('Version ' + deployed + ' is available. Updating…');

    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        try {
          await registration.update();
        } catch { /* fall through to the hard reset */ }
        // Give the install/activate/claim chain a moment to reload us.
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
    }

    // Still here, so the worker did not take over. Clear it out by hand; the
    // stored fasts are in IndexedDB and are not touched.
    say('Clearing the cached copy…');
    await forceRefresh();
    return true;
  }

  function wireHistory() {
    const list = document.getElementById('history-list');
    if (list) {
      // Delegated: rows are rebuilt on every render.
      list.addEventListener('click', (event) => {
        const row = event.target.closest('.fast-row');
        if (row) openFastEditor(row.dataset.fastId);
      });
    }

    const startCard = document.getElementById('edit-start-btn');
    if (startCard) {
      startCard.addEventListener('click', () => {
        const fast = activeFast();
        if (fast) openFastEditor(fast.id);
      });
    }

    document.getElementById('fast-editor-cancel')
      .addEventListener('click', closeFastEditor);
    document.getElementById('fast-editor-save')
      .addEventListener('click', saveFastEdit);
    document.getElementById('fast-editor-delete').addEventListener('click', async (event) => {
      if (editingFastId === null) return;
      if (!deleteArmed) {
        deleteArmed = true;
        event.currentTarget.textContent = 'Tap again to delete for good';
        event.currentTarget.classList.add('is-armed');
        return;
      }
      const id = editingFastId;
      closeFastEditor();
      await deleteFast(id);
    });

    ['edit-started', 'edit-ended'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => { showEditError(null); updateEditSummary(); });
    });

    // Tapping the dimmed backdrop dismisses, as a sheet should.
    document.getElementById('fast-editor').addEventListener('click', (event) => {
      if (event.target.id === 'fast-editor') closeFastEditor();
    });

    const updateBtn = document.getElementById('check-update-btn');
    if (updateBtn) updateBtn.addEventListener('click', checkForUpdate);
  }

  // ---------------------------------------------------------------- backup

  const BACKUP_FORMAT = 1;
  // iOS clears storage for sites unused about this long, so a backup older
  // than this is worth nagging about.
  const STALE_BACKUP_DAYS = 7;

  const DataManager = {
    /** Everything worth keeping, in one plain object. */
    buildPayload() {
      return {
        app: 'fasting-timer',
        format: BACKUP_FORMAT,
        appVersion: APP_VERSION,
        exportedAt: new Date().toISOString(),
        fasts: appState.fasts,
        weights: appState.weights,
        settings: appState.settings,
      };
    },

    /** Timestamped to the MINUTE so two exports on one day cannot collide. */
    filename(now) {
      const d = new Date(now || Date.now());
      const pad = (n) => String(n).padStart(2, '0');
      return 'fasting-backup-' + d.getFullYear() + '-' + pad(d.getMonth() + 1)
        + '-' + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
    },

    /**
     * Hand the backup to the share sheet, falling back to a download.
     *
     * Two rules, both from real bugs:
     *   - share() is passed `files` ONLY. iOS "Save to Files" materialises any
     *     title or text as its own document, leaving a stray file beside every
     *     backup.
     *   - a dismissed sheet rejects with AbortError and is a CANCELLATION, not
     *     a backup. Recording it would make the staleness line claim a backup
     *     that never left the device, which is worse than no line at all.
     *
     * @returns {Promise<'shared'|'downloaded'|'cancelled'|'failed'>}
     */
    async exportData() {
      const json = JSON.stringify(this.buildPayload(), null, 2);
      const name = this.filename();
      const blob = new Blob([json], { type: 'application/json' });

      if (navigator.canShare && navigator.share) {
        const file = new File([blob], name, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file] });
          } catch (err) {
            if (err && err.name === 'AbortError') return 'cancelled';
            return 'failed';
          }
          await this.recordBackup();
          return 'shared';
        }
      }

      try {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Export failed:', err);
        return 'failed';
      }
      await this.recordBackup();
      return 'downloaded';
    },

    async recordBackup() {
      appState.lastBackupAt = new Date().toISOString();
      await saveAppState('lastBackupAt');
      renderBackupStatus();
    },

    /**
     * Read and check a backup file WITHOUT touching anything.
     *
     * Pure on purpose: the user sees what an import would do before any of it
     * happens, and a malformed file cannot get half-applied.
     *
     * @returns {Promise<{ok: true, payload, fasts, weights, exportedAt}|{ok: false, error}>}
     */
    async analyzeImport(file) {
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        return { ok: false, error: 'That file is not readable JSON.' };
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, error: 'That does not look like a backup file.' };
      }
      if (payload.app && payload.app !== 'fasting-timer') {
        return { ok: false, error: 'That backup is from a different app.' };
      }
      if (!Array.isArray(payload.fasts)) {
        return { ok: false, error: 'That backup has no fasts in it.' };
      }
      const bad = payload.fasts.find((f) => !f
        || typeof f.id === 'undefined'
        || typeof f.startedAt !== 'number'
        || (f.endedAt !== null && typeof f.endedAt !== 'number')
        || typeof f.goalHours !== 'number');
      if (bad) return { ok: false, error: 'That backup contains a damaged fast.' };

      return {
        ok: true,
        payload,
        fasts: payload.fasts.length,
        weights: Array.isArray(payload.weights) ? payload.weights.length : 0,
        exportedAt: payload.exportedAt || null,
      };
    },

    /**
     * Replace everything on this device with the backup.
     *
     * A whole replacement rather than a merge: a phone change means importing
     * onto an empty device, and merging two diverged copies of the same fast
     * has no correct answer. The confirmation says exactly this.
     */
    async applyImport(payload) {
      appState.fasts = payload.fasts;
      appState.weights = Array.isArray(payload.weights) ? payload.weights : [];
      appState.settings = { ...DEFAULT_SETTINGS, ...(payload.settings || {}) };

      const results = await Promise.all([
        saveAppState('fasts'), saveAppState('weights'), saveAppState('settings'),
      ]);
      if (results.some((ok) => !ok)) return false;

      stopTicking();
      renderPresets();
      renderTimer();
      renderHistory();
      renderStats();
      renderBackupStatus();
      if (activeFast()) startTicking();
      return true;
    },
  };

  /** "No backup yet", "Last backup today", "Last backup 9 days ago". */
  function formatBackupAge(iso, now) {
    if (!iso) return { text: 'No backup yet', stale: true };
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return { text: 'No backup yet', stale: true };
    const days = Math.floor(((now || Date.now()) - then) / 86400000);
    const text = days <= 0 ? 'Last backup today'
      : days === 1 ? 'Last backup yesterday'
      : 'Last backup ' + days + ' days ago';
    return { text, stale: days >= STALE_BACKUP_DAYS };
  }

  function renderBackupStatus() {
    const el = document.getElementById('backup-when');
    if (!el) return;
    const age = formatBackupAge(appState.lastBackupAt);
    el.textContent = age.text;
    el.classList.toggle('is-stale', age.stale);
  }

  // ---------------------------------------------------------------- import UI

  let pendingImport = null;

  function closeImportSheet() {
    pendingImport = null;
    document.getElementById('import-sheet').classList.remove('is-open');
  }

  function showImportError(message) {
    const el = document.getElementById('import-error');
    el.textContent = message || '';
    el.classList.toggle('is-shown', !!message);
  }

  async function offerImport(file) {
    const summary = document.getElementById('import-summary');
    const confirm = document.getElementById('import-confirm');
    const analysis = await DataManager.analyzeImport(file);

    showImportError(null);
    if (!analysis.ok) {
      pendingImport = null;
      summary.textContent = '';
      confirm.disabled = true;
      showImportError(analysis.error);
    } else {
      pendingImport = analysis.payload;
      confirm.disabled = false;
      const when = analysis.exportedAt
        ? ' from ' + formatDayLabel(new Date(analysis.exportedAt).getTime())
        : '';
      const here = appState.fasts.length;
      summary.innerHTML = 'This backup holds <strong>' + analysis.fasts
        + (analysis.fasts === 1 ? ' fast' : ' fasts') + '</strong>' + when
        + '. Importing replaces the <strong>' + here
        + (here === 1 ? ' fast' : ' fasts') + '</strong> on this device.';
    }
    document.getElementById('import-sheet').classList.add('is-open');
  }

  function wireBackup() {
    const exportBtn = document.getElementById('export-btn');
    const importBtn = document.getElementById('import-btn');
    const fileInput = document.getElementById('import-file');

    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        const label = exportBtn.textContent;
        exportBtn.disabled = true;
        const result = await DataManager.exportData();
        exportBtn.disabled = false;
        exportBtn.textContent = result === 'failed' ? 'Export failed' : label;
        if (result === 'failed') setTimeout(() => { exportBtn.textContent = label; }, 2500);
      });
    }

    if (importBtn && fileInput) {
      importBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        // Reset so choosing the same file twice still fires a change event.
        fileInput.value = '';
        if (file) await offerImport(file);
      });
    }

    document.getElementById('import-cancel').addEventListener('click', closeImportSheet);
    document.getElementById('import-sheet').addEventListener('click', (event) => {
      if (event.target.id === 'import-sheet') closeImportSheet();
    });
    document.getElementById('import-confirm').addEventListener('click', async () => {
      if (!pendingImport) return;
      const payload = pendingImport;
      const ok = await DataManager.applyImport(payload);
      if (!ok) { showImportError('Could not save the imported data.'); return; }
      closeImportSheet();
      showView('history');
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
    tickHandle = setInterval(() => {
      renderTimer();
      refreshRunningRow();
    }, 1000);
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

    const stageCard = document.getElementById('stage-card');
    if (stageCard) stageCard.addEventListener('click', openStageSheet);
    document.getElementById('stages-close').addEventListener('click', closeStageSheet);
    document.getElementById('stages-sheet').addEventListener('click', (event) => {
      if (event.target.id === 'stages-sheet') closeStageSheet();
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

  // ---------------------------------------------------------------- stats

  const DAY_MS = 86400000;

  /**
   * Midnight local, as a timestamp.
   *
   * Built from local date components rather than by slicing an ISO string:
   * toISOString() is UTC, and an Irish fast started at 23:30 in summer would be
   * filed under the following day. A 16:8 fast normally crosses midnight, so
   * this is the common case here, not an edge case.
   */
  function startOfLocalDay(timestamp) {
    const d = new Date(timestamp);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  /**
   * The local midnight one day earlier.
   *
   * Built through the Date constructor rather than subtracting 24h: a local day
   * is 23 or 25 hours long across a clock change, so fixed arithmetic lands at
   * 23:00 the day before and every lookup keyed on a local midnight misses.
   * Ireland changes clocks in late March and late October.
   */
  function previousLocalDay(dayStart) {
    const d = new Date(dayStart);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
  }

  /** Whole local days between two instants, DST changes included. */
  function daysBetween(fromTs, toTs) {
    return Math.round((startOfLocalDay(toTs) - startOfLocalDay(fromTs)) / DAY_MS);
  }

  const completedFasts = () => appState.fasts.filter((f) => f.endedAt !== null);
  const metGoal = (f) => elapsedMs(f) >= f.goalHours * HOUR_MS;

  /**
   * A fast belongs to the local day it STARTED on.
   *
   * Attributing by the end would move most 16:8 fasts to the following day and
   * make an evening start look like it never happened.
   */
  function fastsByDay(fasts, now) {
    const when = now || Date.now();
    const byDay = new Map();
    for (const f of fasts) {
      const key = startOfLocalDay(f.startedAt);
      const entry = byDay.get(key)
        || { totalMs: 0, met: false, pending: false, count: 0 };
      const elapsed = elapsedMs(f, when);
      const reached = elapsed >= f.goalHours * HOUR_MS;
      entry.totalMs += elapsed;
      // A running fast counts as met the moment it passes its goal, rather
      // than waiting to be stopped.
      entry.met = entry.met || reached;
      // Still running and not there yet: the day is unfinished, not failed.
      entry.pending = entry.pending || (f.endedAt === null && !reached);
      entry.count += 1;
      byDay.set(key, entry);
    }
    return byDay;
  }

  /**
   * Consecutive days, counting back, on which a fast met its goal.
   *
   * Three states per day, not two, and the third is what this got wrong. A day
   * whose fast is STILL RUNNING is pending: it has not met its goal and it has
   * not failed either. Stopping there read 0 for anyone whose fast crosses
   * midnight - with an evening-start 18:6 that is every day from midnight until
   * the fast is broken, so the streak was wrong for most of the waking day and
   * only became right after eating.
   *
   * Today is also allowed to be unfinished: nothing recorded yet, or a fast
   * under way, neither counts nor breaks the run. Only a fast that ENDED short
   * breaks it, because reporting a streak the day just ended is the one thing a
   * streak must never do.
   */
  function currentStreak(fasts, now) {
    const when = now || Date.now();
    const today = startOfLocalDay(when);
    const byDay = fastsByDay(fasts, when);

    let streak = 0;
    const todayEntry = byDay.get(today);
    if (todayEntry && todayEntry.met) {
      streak += 1;
    } else if (todayEntry && !todayEntry.pending) {
      return 0;
    }

    let cursor = previousLocalDay(today);
    for (;;) {
      const entry = byDay.get(cursor);
      if (entry && entry.met) {
        streak += 1;
      } else if (!entry || !entry.pending) {
        // Nothing that day, or only a fast that fell short: the run ends here.
        break;
      }
      // A pending day is stepped over - the fast that began it is still going.
      cursor = previousLocalDay(cursor);
    }
    return streak;
  }

  function averageMs(fasts) {
    if (fasts.length === 0) return null;
    return fasts.reduce((sum, f) => sum + elapsedMs(f), 0) / fasts.length;
  }

  /** Everything the Stats screen shows, from the fasts alone. */
  function computeStats(now) {
    const when = now || Date.now();
    const done = completedFasts();
    const within = (days) => done.filter((f) => daysBetween(f.startedAt, when) < days);

    const last30 = within(30);
    const longest = done.reduce((max, f) => Math.max(max, elapsedMs(f)), 0);
    const met = done.filter(metGoal).length;

    return {
      total: done.length,
      streak: currentStreak(appState.fasts, when),
      goalRate: done.length ? Math.round((met / done.length) * 100) : null,
      average30: averageMs(last30),
      longest: done.length ? longest : null,
    };
  }

  // ---------------------------------------------------------------- heatmap

  /**
   * Hours fasted in a day, as a ramp step.
   *
   * Level 0 is "nothing recorded" rather than the bottom of the scale, so an
   * empty day reads as absent rather than as a very short fast.
   */
  function heatLevel(totalMs) {
    const hours = totalMs / HOUR_MS;
    if (hours <= 0) return 0;
    if (hours < 12) return 1;
    if (hours < 16) return 2;
    if (hours < 20) return 3;
    return 4;
  }

  /**
   * Hours actually fasted on each local day, splitting a fast at midnight.
   *
   * Deliberately NOT fastsByDay(), which credits a whole fast to the day it
   * started. That rule is right for streaks and goal rates - one fast belongs
   * to one day - but wrong for a chart of hours: a 20h fast begun at 22:00 put
   * all 20 hours on the start day and left the following day, almost entirely
   * fasted, showing nothing at all. A 30h fast credited 30 hours to a single
   * day, which is not a quantity a day can hold.
   */
  function fastingHoursByDay(fasts, now) {
    const byDay = new Map();
    const until = now || Date.now();

    for (const fast of fasts) {
      const end = fast.endedAt !== null ? fast.endedAt : until;
      let cursor = fast.startedAt;
      if (end <= cursor) continue;

      while (cursor < end) {
        const dayStart = startOfLocalDay(cursor);
        // Next midnight via the Date constructor, so a DST change shifts the
        // boundary by an hour rather than the slice landing on the wrong day.
        const d = new Date(dayStart);
        const nextMidnight = new Date(
          d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const sliceEnd = Math.min(end, nextMidnight);
        byDay.set(dayStart, (byDay.get(dayStart) || 0) + (sliceEnd - cursor));
        cursor = sliceEnd;
      }
    }
    return byDay;
  }

  /**
   * 13 weeks of levels, ordered as the grid renders them: column by column,
   * each column a week running Monday to Sunday, oldest week first.
   */
  function heatLevels(fasts, now) {
    const byDay = fastingHoursByDay(fasts, now);
    const today = startOfLocalDay(now || Date.now());
    // Monday of the current week. getDay() is 0 for Sunday, so shift it.
    const weekday = (new Date(today).getDay() + 6) % 7;
    const base = new Date(today);
    const thisMonday = new Date(
      base.getFullYear(), base.getMonth(), base.getDate() - weekday).getTime();
    const mon = new Date(thisMonday);
    const firstMonday = new Date(mon.getFullYear(), mon.getMonth(),
      mon.getDate() - (HEAT_WEEKS - 1) * DAYS_PER_WEEK).getTime();

    const levels = [];
    for (let w = 0; w < HEAT_WEEKS; w++) {
      for (let d = 0; d < DAYS_PER_WEEK; d++) {
        // Rebuild each date through the Date constructor so a DST change does
        // not drift the grid by an hour and land on the wrong day.
        const base = new Date(firstMonday);
        const day = new Date(base.getFullYear(), base.getMonth(),
          base.getDate() + w * DAYS_PER_WEEK + d).getTime();
        if (day > today) { levels.push(0); continue; }
        const totalMs = byDay.get(day);
        levels.push(totalMs ? heatLevel(totalMs) : 0);
      }
    }
    return levels;
  }

  function renderStats() {
    const stats = computeStats();
    const dash = '\u2013';

    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = value;
    };
    const unit = (text) => '<span class="unit">' + text + '</span>';

    set('stat-streak', stats.streak + unit(stats.streak === 1 ? ' day' : ' days'));
    set('stat-rate', stats.goalRate === null ? dash : stats.goalRate + unit('%'));
    set('stat-avg', stats.average30 === null ? dash : splitDuration(stats.average30, unit));
    set('stat-longest', stats.longest === null ? dash : splitDuration(stats.longest, unit));

    renderHeatmap(heatLevels(appState.fasts));
  }

  /** "15h 48m" with the h and m in the quieter unit style. */
  function splitDuration(ms, unit) {
    const total = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h + unit('h ') + String(m).padStart(2, '0') + unit('m');
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
   * Register the service worker and keep it up to date.
   *
   * 'sw.js' is deliberately relative: from …/IF-PWA/ it resolves to
   * …/IF-PWA/sw.js and takes a default scope of …/IF-PWA/, which is exactly
   * the app. A leading slash would ask for a worker at the origin root, which
   * 404s here and would control the wrong scope if it did not.
   *
   * The browser does check for a new worker on navigation by itself, and the
   * upgrade suite passes with these update() calls removed - so they are a
   * convergence aid, not the mechanism. They earn their place anyway: the
   * check can take several seconds, and an INSTALLED PWA is resumed far more
   * often than it is navigated, so the visibility check is the one that
   * matters on a phone. The controllerchange reload is the real win: without
   * it a new version sits cached until the next launch.
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // Whether this page load started under an existing worker. On a first ever
    // visit there is none, and the initial claim must not trigger a reload.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      // A new worker has taken over, so newer code is already cached. Reload
      // once to run it now rather than on some later launch.
      reloading = true;
      window.location.reload();
    });

    window.addEventListener('load', async () => {
      let registration;
      try {
        // updateViaCache:'none' so the worker script itself is never answered
        // from the HTTP cache. GitHub Pages serves with a max-age, and a worker
        // fetched from cache looks unchanged, so no update is ever detected.
        registration = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      } catch (err) {
        console.error('Service worker registration failed:', err);
        return;
      }

      registration.update();

      // An installed PWA can go a long time without a fresh navigation - it is
      // resumed, not reopened - so check again when it comes back to the fore.
      // Throttled because this fires on every app switch.
      let lastCheck = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (Date.now() - lastCheck < 60000) return;
        lastCheck = Date.now();
        registration.update();
      });
    });
  }

  // ---------------------------------------------------------------- init

  async function init() {
    wireNav();
    wireTimer();
    wireHistory();
    wireBackup();
    wireCustomPlan();
    showView('timer');
    StorageManager.requestPersistence();
    await loadAppState();

    // Whatever was running before the app was closed picks straight back up:
    // the fast's start timestamp is all the state there is.
    renderPresets();
    renderTimer();
    renderHistory();
    renderStats();
    renderBackupStatus();
    renderAbout();
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
    setCustomPlan,
    activePlan,
    planLabelFor,
    customLabel,
    clampCustomHours,
    openCustomSheet,
    closeCustomSheet,
    nudgeCustomHours,
    renderTimer,
    formatDuration,
    formatClock,
    floorToMinute,
    stageFor,
    stageTimeline,
    renderRingTicks,
    openStageSheet,
    closeStageSheet,
    describeStageTime,
    renderHistory,
    refreshRunningRow,
    openFastEditor,
    closeFastEditor,
    saveFastEdit,
    deleteFast,
    disarmDelete,
    validateFastTimes,
    toLocalInputValue,
    fromLocalInputValue,
    fastsNewestFirst,
    computeStats,
    currentStreak,
    heatLevels,
    heatLevel,
    startOfLocalDay,
    fastsByDay,
    previousLocalDay,
    fastingHoursByDay,
    renderStats,
    DataManager,
    formatBackupAge,
    renderBackupStatus,
    offerImport,
    closeImportSheet,
    renderAbout,
    checkForUpdate,
    fetchDeployedVersion,
    forceRefresh,
    loadAppState,
    saveAppState,
    STORAGE_KEYS,
  };
})();

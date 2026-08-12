/**
 * Google Meet content script — call lifecycle, roster, and speaker attribution.
 *
 * OpenAI Realtime transcription returns no speaker labels, so the only source
 * of "who said that" is Meet's own UI. This script reports speaking windows;
 * the service worker correlates them against transcript timestamps.
 *
 * ── The fragile part ──────────────────────────────────────────────────────
 * Meet ships obfuscated, frequently-rotated class names. Everything version-
 * dependent is isolated in SELECTORS below so a break is a one-constant fix.
 * When attribution stops resolving, this script says so out loud
 * (ATTRIBUTION_DEGRADED) rather than silently mislabelling every speaker — and
 * `__mentionRadar.probe()` in the page console dumps candidates to find the
 * new selector.
 */

/*
 * Manifest-declared content scripts cannot be ES modules, so these message
 * types are inlined rather than imported. src/lib/constants.js is the source
 * of truth — keep the MSG values here in sync with it.
 */
const MSG = {
  CALL_STARTED: 'call:started',
  CALL_ENDED: 'call:ended',
  SPEAKER_ACTIVITY: 'speaker:activity',
  ROSTER_UPDATED: 'roster:updated',
  ATTRIBUTION_DEGRADED: 'attribution:degraded',
  LOG: 'log:entry',
};

/*
 * Inline logger, matching src/lib/logger.js. Logs to this tab's console and
 * forwards to the service worker so everything lands in the panel's log view
 * alongside the other contexts.
 */
const LOG_CTX = 'meet';
let logSeq = 0;
const throttleState = new Map();

const log = {
  emit(level, msg, data) {
    const entry = {
      id: `${Date.now().toString(36)}-c${(logSeq++).toString(36)}`,
      t: Date.now(),
      ctx: LOG_CTX,
      level,
      msg: String(msg),
      data,
    };
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](
      `%c${new Date(entry.t).toISOString().slice(11, 23)}%c ${LOG_CTX}%c ${entry.msg}`,
      'color:#888',
      'color:#2a9d8f;font-weight:600',
      'color:inherit',
      data ?? '',
    );
    try {
      chrome.runtime.sendMessage({ type: MSG.LOG, payload: entry })?.catch?.(() => {});
    } catch {
      /* worker asleep; the tab console still has it */
    }
  },
  debug: (m, d) => log.emit('debug', m, d),
  info: (m, d) => log.emit('info', m, d),
  warn: (m, d) => log.emit('warn', m, d),
  error: (m, d) => log.emit('error', m, d),
  throttle(key, ms, level, msg, data) {
    const now = Date.now();
    if (now - (throttleState.get(key) ?? 0) < ms) return;
    throttleState.set(key, now);
    log.emit(level, msg, data);
  },
};

const SELECTORS = {
  /** Participant tiles. `data-participant-id` has been stable for years. */
  tile: ['[data-participant-id]', '[data-requested-participant-id]'],

  /** Name text inside a tile, tried in order. */
  name: ['[data-self-name]', '[data-participant-name]', '.notranslate', '[jsname] span'],

  /**
   * Speaking indicator. Meet marks the active speaker's tile; the attribute
   * form is stable, the class forms rotate. Add new candidates here.
   */
  speaking: [
    '[data-is-speaking="true"]',
    '[aria-label*="is speaking"]',
    '.IisKdb',
    '.wnPUne',
  ],

  /** Presence of any of these means we're in a call, not the lobby. */
  inCall: [
    '[aria-label*="Leave call"]',
    '[aria-label*="Leave meeting"]',
    '[data-call-ended]',
  ],
};

/** Meet meeting codes look like abc-defg-hij. */
const MEETING_CODE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/;

const ROSTER_POLL_MS = 3000;
const SPEAKER_POLL_MS = 200;
/** If nothing has ever resolved as a speaker after this long, warn. */
const DEGRADED_AFTER_MS = 45000;

let inCall = false;
/** @type {Map<string, {name: string, speakingSince: number|null}>} */
let participants = new Map();
let everResolvedSpeaker = false;
let callStartedAt = 0;
let degradedReported = false;
let timers = [];

boot();

function boot() {
  log.info('content script loaded', { path: location.pathname });
  const observer = new MutationObserver(throttle(checkCallState, 500));
  observer.observe(document.body, { childList: true, subtree: true });
  checkCallState();
  // Meet is a SPA; the URL changes without a reload.
  setInterval(checkCallState, 2000);
  exposeDebugProbe();
}

// --- call lifecycle --------------------------------------------------------

function checkCallState() {
  const looksLikeCall =
    MEETING_CODE.test(location.pathname) && SELECTORS.inCall.some((s) => document.querySelector(s));

  if (looksLikeCall && !inCall) onCallStart();
  else if (!looksLikeCall && inCall) onCallEnd();
}

function onCallStart() {
  inCall = true;
  callStartedAt = Date.now();
  everResolvedSpeaker = false;
  degradedReported = false;
  participants = new Map();

  const tiles = queryTiles();
  log.info('call started', {
    title: document.title,
    tilesFound: tiles.length,
    // Which selector strategy actually matched — the first thing to check when
    // Meet rotates its markup.
    tileSelector: SELECTORS.tile.find((s) => document.querySelector(s)) ?? '(none matched)',
  });
  if (!tiles.length) {
    log.warn('no participant tiles matched — speaker attribution will not work', {
      tried: SELECTORS.tile,
    });
  }

  send(MSG.CALL_STARTED, { url: location.href, title: document.title });

  timers.push(setInterval(scanRoster, ROSTER_POLL_MS));
  timers.push(setInterval(scanSpeakers, SPEAKER_POLL_MS));
  scanRoster();
}

function onCallEnd() {
  log.info('call ended');
  inCall = false;
  timers.forEach(clearInterval);
  timers = [];
  participants = new Map();
  send(MSG.CALL_ENDED, {});
}

// --- roster ----------------------------------------------------------------

function scanRoster() {
  const tiles = queryTiles();
  const seen = new Set();

  for (const tile of tiles) {
    const id = tileId(tile);
    if (!id) continue;
    seen.add(id);
    const name = extractName(tile);
    const existing = participants.get(id);
    if (!existing) {
      participants.set(id, { name, speakingSince: null });
    } else if (name && name !== existing.name) {
      existing.name = name;
    }
  }

  for (const id of [...participants.keys()]) {
    if (!seen.has(id)) participants.delete(id);
  }

  send(MSG.ROSTER_UPDATED, {
    participants: [...participants.entries()].map(([id, p]) => ({ id, name: p.name })),
  });
}

function queryTiles() {
  for (const sel of SELECTORS.tile) {
    const found = document.querySelectorAll(sel);
    if (found.length) return [...found];
  }
  return [];
}

function tileId(tile) {
  return (
    tile.getAttribute('data-participant-id') ||
    tile.getAttribute('data-requested-participant-id') ||
    null
  );
}

function extractName(tile) {
  for (const sel of SELECTORS.name) {
    const el = tile.querySelector(sel);
    const text = el?.getAttribute?.('data-self-name') || el?.textContent;
    const cleaned = (text ?? '').trim();
    // Guard against grabbing a whole subtitle block instead of a name.
    if (cleaned && cleaned.length <= 60 && !cleaned.includes('\n')) return cleaned;
  }
  const aria = (tile.getAttribute('aria-label') ?? '').trim();
  if (aria && aria.length <= 60) return aria;
  return '';
}

// --- speaker attribution ---------------------------------------------------

function scanSpeakers() {
  const now = Date.now();
  const tiles = queryTiles();
  let anyResolved = false;

  for (const tile of tiles) {
    const id = tileId(tile);
    if (!id) continue;
    const p = participants.get(id);
    if (!p) continue;

    const speaking = isSpeaking(tile);
    if (speaking) anyResolved = true;

    if (speaking && p.speakingSince === null) {
      p.speakingSince = now;
    } else if (!speaking && p.speakingSince !== null) {
      send(MSG.SPEAKER_ACTIVITY, {
        participantId: id,
        name: p.name,
        tStart: p.speakingSince,
        tEnd: now,
      });
      p.speakingSince = null;
    }
  }

  if (anyResolved && !everResolvedSpeaker) {
    // First successful resolution — confirms the speaking selector still works.
    log.info('speaker attribution working', {
      selector: SELECTORS.speaking.find((s) =>
        tiles.some((t) => t.matches?.(s) || t.querySelector(s)),
      ),
    });
  }
  if (anyResolved) everResolvedSpeaker = true;
  maybeReportDegraded();
}

function isSpeaking(tile) {
  for (const sel of SELECTORS.speaking) {
    if (tile.matches?.(sel)) return true;
    if (tile.querySelector(sel)) return true;
  }
  return false;
}

/**
 * Attribution is best-effort. If Meet's markup has moved and nothing ever
 * resolves, the notes still work — they just say "Someone" instead of a name.
 * Reporting that plainly beats confidently attributing every line to the wrong
 * person.
 */
function maybeReportDegraded() {
  if (degradedReported || everResolvedSpeaker) return;
  if (Date.now() - callStartedAt < DEGRADED_AFTER_MS) return;
  degradedReported = true;
  log.warn('no speaking indicator resolved in 45s — speakers will read as "Someone"', {
    tried: SELECTORS.speaking,
    hint: 'Run __mentionRadar.probe() in this console while someone talks.',
  });
  send(MSG.ATTRIBUTION_DEGRADED, {
    reason: 'No speaking indicator resolved — Meet markup likely changed.',
    hint: 'Run __mentionRadar.probe() in this tab\'s console to find the new selector.',
  });
}

// --- debug helper ----------------------------------------------------------

/**
 * When Meet rotates its class names, this dumps what changed on the tiles so
 * the `speaking` selector list can be updated without guesswork.
 */
function exposeDebugProbe() {
  const probe = (seconds = 10) => {
    const counts = new Map();
    const tiles = queryTiles();
    console.log(`[MentionRadar] watching ${tiles.length} tiles for ${seconds}s — talk now.`);

    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type !== 'attributes') continue;
        const el = r.target;
        const key =
          r.attributeName === 'class'
            ? [...(el.classList ?? [])].map((c) => `.${c}`).join(' ')
            : `[${r.attributeName}="${el.getAttribute?.(r.attributeName)}"]`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    });

    for (const tile of tiles) {
      mo.observe(tile, { attributes: true, subtree: true, attributeOldValue: true });
    }

    setTimeout(() => {
      mo.disconnect();
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
      console.table(ranked.map(([selector, changes]) => ({ selector, changes })));
      console.log('[MentionRadar] add the speaking-indicator selector to SELECTORS.speaking in content.js');
    }, seconds * 1000);
  };

  Object.defineProperty(window, '__mentionRadar', {
    value: { probe, participants: () => [...participants.entries()], selectors: SELECTORS },
    configurable: true,
  });
}

// --- plumbing --------------------------------------------------------------

function send(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {
    // Service worker asleep or extension reloading; next tick will retry.
  });
}

function throttle(fn, ms) {
  let last = 0;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        last = Date.now();
        fn(...args);
      }, ms - (now - last));
    }
  };
}

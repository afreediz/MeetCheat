/**
 * Shared logger.
 *
 * This extension runs in four separate JavaScript contexts, each with its own
 * DevTools console: the service worker, the offscreen audio document, the
 * content script in the Meet tab, and the side panel. Debugging by opening
 * four consoles is miserable, so every context logs to its own console *and*
 * forwards structured entries to the service worker, which fans them out to
 * the live log view in the panel.
 *
 * Rules that keep this useful rather than noisy:
 *   - Secrets are redacted here, once, rather than at each call site.
 *   - Hot paths use `throttle()` so per-audio-chunk events can't flood.
 *   - Payloads are clipped before forwarding; a giant transcript in a log
 *     entry would cost more than the transcript itself.
 */

import { MSG } from './constants.js';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Short tags keep the panel readable at narrow widths. */
export const CONTEXTS = {
  SW: 'sw',
  OFFSCREEN: 'audio',
  REALTIME: 'stt',
  CONTENT: 'meet',
  PANEL: 'panel',
  LLM: 'llm',
};

const COLORS = {
  sw: '#7c5cff',
  audio: '#0a9396',
  stt: '#ee9b00',
  meet: '#2a9d8f',
  panel: '#8d99ae',
  llm: '#e76f51',
};

let minLevel = LEVELS.debug;

export function setLogLevel(name) {
  minLevel = LEVELS[name] ?? LEVELS.debug;
}

export function getLogLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === minLevel) ?? 'debug';
}

/**
 * Where entries go after being printed locally. Defaults to forwarding to the
 * service worker; the service worker itself overrides this to write straight
 * into its ring buffer (forwarding to itself would be a message loop).
 */
let sink = (entry) => {
  try {
    chrome.runtime.sendMessage({ type: MSG.LOG, payload: entry })?.catch?.(() => {});
  } catch {
    /* no receiver yet — the local console still has it */
  }
};

export function setLogSink(fn) {
  sink = fn;
}

let seq = 0;

export function createLogger(context) {
  const throttleState = new Map();

  const emit = (level, msg, data) => {
    if (LEVELS[level] < minLevel) return;
    const entry = {
      id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
      t: Date.now(),
      ctx: context,
      level,
      msg: String(msg),
      data: clip(redact(data)),
    };
    print(entry);
    sink(entry);
  };

  return {
    debug: (msg, data) => emit('debug', msg, data),
    info: (msg, data) => emit('info', msg, data),
    warn: (msg, data) => emit('warn', msg, data),
    error: (msg, data) => emit('error', msg, data),

    /**
     * Rate-limited logging for hot paths — interim transcript deltas, audio
     * chunks. Only the first call per `ms` window for a given key gets through.
     */
    throttle(key, ms, level, msg, data) {
      const now = Date.now();
      const last = throttleState.get(key) ?? 0;
      if (now - last < ms) return false;
      throttleState.set(key, now);
      emit(level, msg, data);
      return true;
    },

    /**
     * Start a timer; call the returned function to log the elapsed ms.
     * Used for the latency numbers that actually matter (alert, first token).
     */
    timer(msg) {
      const t0 = Date.now();
      return (data) => {
        const ms = Date.now() - t0;
        emit('info', `${msg} (${ms}ms)`, { ...(data ?? {}), ms });
        return ms;
      };
    },
  };
}

// --- console output --------------------------------------------------------

function print(entry) {
  const time = new Date(entry.t).toISOString().slice(11, 23);
  const color = COLORS[entry.ctx] ?? '#888';
  const method =
    entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'log';
  const args = [
    `%c${time}%c ${entry.ctx}%c ${entry.msg}`,
    'color:#888',
    `color:${color};font-weight:600`,
    'color:inherit',
  ];
  if (entry.data !== undefined) args.push(entry.data);
  // eslint-disable-next-line no-console
  console[method](...args);
}

// --- payload hygiene -------------------------------------------------------

const SECRET_KEYS = /^(apikey|api_key|key|token|authorization|secret|password)$/i;

/** Mask anything that looks like a credential, wherever it appears. */
export function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (typeof value === 'string') return maskIfKeyLike(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? mask(v) : redact(v, depth + 1);
  }
  return out;
}

function maskIfKeyLike(s) {
  return /^sk-[A-Za-z0-9_-]{12,}$/.test(s) ? mask(s) : s;
}

function mask(v) {
  const s = String(v ?? '');
  if (!s) return '(empty)';
  return s.length <= 8 ? '***' : `${s.slice(0, 5)}…${s.slice(-4)} (${s.length} chars)`;
}

const MAX_STRING = 300;
const MAX_ARRAY = 20;

/** Keep entries small enough to forward and store without cost. */
function clip(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (+${value.length - MAX_STRING})` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => clip(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `… +${value.length - MAX_ARRAY} more`] : head;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clip(v, depth + 1);
    return out;
  }
  if (typeof value === 'function') return '(fn)';
  return value;
}

/** Format one entry as a single text line, for the panel's copy button. */
export function formatEntry(entry) {
  const time = new Date(entry.t).toISOString().slice(11, 23);
  const data =
    entry.data === undefined ? '' : ` ${safeStringify(entry.data)}`;
  return `${time} [${entry.ctx}] ${entry.level.toUpperCase()} ${entry.msg}${data}`;
}

export function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '(unserializable)';
  }
}

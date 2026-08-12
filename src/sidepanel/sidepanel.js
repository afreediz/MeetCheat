/**
 * Side panel renderer.
 *
 * Holds a long-lived port to the service worker — which also keeps the worker
 * alive while the panel is open. Renders three things: the instant alert
 * banner, the two streaming notes, and the rolling summary.
 */

import { MSG, TRIGGER_KIND, TUNING } from '../lib/constants.js';
import { LEVELS, formatEntry, safeStringify } from '../lib/logger.js';

const el = {
  dot: document.getElementById('dot'),
  status: document.getElementById('status'),
  stop: document.getElementById('stop'),
  settings: document.getElementById('settings'),
  warnings: document.getElementById('warnings'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('bannerText'),
  bannerTime: document.getElementById('bannerTime'),
  askCard: document.getElementById('askCard'),
  ask: document.getElementById('ask'),
  contextCard: document.getElementById('contextCard'),
  context: document.getElementById('context'),
  summaryCard: document.getElementById('summaryCard'),
  summary: document.getElementById('summary'),
  empty: document.getElementById('empty'),
  emptyHint: document.getElementById('emptyHint'),
  start: document.getElementById('start'),
  metrics: document.getElementById('metrics'),

  logToggle: document.getElementById('logToggle'),
  logView: document.getElementById('logView'),
  logList: document.getElementById('logList'),
  logFilter: document.getElementById('logFilter'),
  logLevelFilter: document.getElementById('logLevelFilter'),
  logFollow: document.getElementById('logFollow'),
  logCopy: document.getElementById('logCopy'),
  logClear: document.getElementById('logClear'),
  logDiag: document.getElementById('logDiag'),
  logCount: document.getElementById('logCount'),
};

let port = null;
let clockTimer = null;
let lastTriggerAt = 0;

/** Every entry received, unfiltered. Filtering happens at render time. */
let logEntries = [];

connect();
wireControls();

function connect() {
  port = chrome.runtime.connect({ name: MSG.PANEL_PORT });
  port.onMessage.addListener(handle);
  port.onDisconnect.addListener(() => {
    port = null;
    // The worker was torn down (or the extension reloaded). Reconnecting
    // re-establishes the channel and pulls a fresh snapshot.
    setTimeout(connect, 500);
  });
}

function wireControls() {
  el.start.addEventListener('click', () => {
    el.start.disabled = true;
    el.start.textContent = 'Starting…';
    port?.postMessage({ type: 'panel:start' });
    // Re-enable if the worker never flips us out of the empty state, so a
    // failed start doesn't leave a dead button.
    setTimeout(resetStartButton, 6000);
  });
  el.stop.addEventListener('click', () => port?.postMessage({ type: 'panel:stop' }));
  el.settings.addEventListener('click', () => port?.postMessage({ type: 'panel:openOptions' }));
  el.warnings.addEventListener('click', () => port?.postMessage({ type: 'panel:dismissWarnings' }));

  el.logToggle.addEventListener('click', () => {
    const open = el.logView.hidden;
    el.logView.hidden = !open;
    el.logToggle.setAttribute('aria-pressed', String(open));
    if (open) renderLog();
  });

  el.logFilter.addEventListener('input', renderLog);
  el.logLevelFilter.addEventListener('change', renderLog);

  el.logClear.addEventListener('click', () => {
    logEntries = [];
    renderLog();
    port?.postMessage({ type: 'panel:clearLog' });
  });

  el.logDiag.addEventListener('click', () => port?.postMessage({ type: 'panel:diagnostics' }));

  el.logCopy.addEventListener('click', async () => {
    // Copies the *filtered* view, so a narrowed-down problem is what gets shared.
    const text = visibleEntries().map(formatEntry).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      flashButton(el.logCopy, `Copied ${visibleEntries().length}`);
    } catch {
      flashButton(el.logCopy, 'Copy failed');
    }
  });
}

function flashButton(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

function handle({ type, payload }) {
  switch (type) {
    case MSG.PANEL_SNAPSHOT:
      renderStatus(payload.status, payload.active, payload.title);
      renderWarnings(payload.warnings);
      renderSummary(payload.summary);
      if (payload.trigger) renderTrigger(payload.trigger);
      renderNotes(payload.notes, true);
      toggleEmpty(payload.active, payload.trigger);
      break;

    case MSG.PANEL_STATUS:
      renderStatus(payload.status, payload.active);
      toggleEmpty(payload.active, null);
      break;

    case MSG.PANEL_TRIGGER:
      renderTrigger(payload);
      renderNotes({ ask: '', context: '' }, false);
      toggleEmpty(true, payload);
      break;

    case MSG.PANEL_NOTES_DELTA:
      renderNotes(payload, false);
      break;

    case MSG.PANEL_NOTES_DONE:
      renderNotes(payload, true);
      if (payload.error) renderWarnings([{ code: 'notes_failed', message: payload.error }]);
      if (payload.totalMs) appendMetric(`notes complete ${payload.totalMs}ms`);
      break;

    case MSG.PANEL_SUMMARY:
      renderSummary(payload.summary);
      break;

    case MSG.PANEL_METRICS:
      appendMetric(`first note token ${payload.firstTokenMs}ms`);
      break;

    case MSG.PANEL_LOG:
      addLogEntries([payload]);
      break;

    case MSG.PANEL_LOG_BATCH:
      // Backlog replay on connect, or an acknowledged clear.
      if (payload.cleared) logEntries = [];
      else logEntries = payload.entries ?? [];
      renderLog();
      break;
  }
}

// --- activity log ----------------------------------------------------------

function addLogEntries(entries) {
  logEntries.push(...entries);
  if (logEntries.length > TUNING.LOG_RING_SIZE) {
    logEntries.splice(0, logEntries.length - TUNING.LOG_RING_SIZE);
  }
  // No point building DOM for a hidden panel.
  if (!el.logView.hidden) renderLog();
}

function visibleEntries() {
  const needle = el.logFilter.value.trim().toLowerCase();
  const min = LEVELS[el.logLevelFilter.value] ?? LEVELS.debug;

  return logEntries.filter((e) => {
    if ((LEVELS[e.level] ?? 0) < min) return false;
    if (!needle) return true;
    const haystack = `${e.ctx} ${e.msg} ${e.data === undefined ? '' : safeStringify(e.data)}`;
    return haystack.toLowerCase().includes(needle);
  });
}

function renderLog() {
  const entries = visibleEntries();

  // Preserve "stick to bottom" only when the user is already there, so
  // scrolling back to read something isn't yanked away by new entries.
  const list = el.logList;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;

  list.replaceChildren(...entries.map(logRow));
  el.logCount.textContent =
    entries.length === logEntries.length
      ? `${entries.length} entries`
      : `${entries.length} of ${logEntries.length} entries`;

  if (el.logFollow.checked && atBottom) list.scrollTop = list.scrollHeight;
}

function logRow(entry) {
  const row = document.createElement('div');
  row.className = `logrow ${entry.level}`;

  const time = document.createElement('span');
  time.className = 'lt';
  time.textContent = new Date(entry.t).toISOString().slice(11, 19);

  const ctx = document.createElement('span');
  ctx.className = `lc ${entry.ctx}`;
  ctx.textContent = entry.ctx;

  const msg = document.createElement('span');
  msg.className = 'lm';
  msg.textContent = entry.msg;

  row.append(time, ctx, msg);

  if (entry.data !== undefined) {
    const data = document.createElement('span');
    data.className = 'ld';
    data.textContent = safeStringify(entry.data);
    row.append(data);
  }

  return row;
}

// --- rendering -------------------------------------------------------------

const STATUS_TEXT = {
  idle: 'Not listening',
  starting: 'Starting…',
  listening: 'Listening',
  needs_setup: 'Setup needed',
};

function renderStatus(status, active, title) {
  const label = STATUS_TEXT[status] ?? status;
  el.status.textContent = title ? `${label} · ${stripMeetSuffix(title)}` : label;
  el.dot.className = `dot${active && status === 'listening' ? ' live' : ''}${
    status === 'starting' ? ' connecting' : ''
  }`;
  el.stop.hidden = !active;
}

function renderTrigger(trigger) {
  lastTriggerAt = trigger.at ?? Date.now();
  el.bannerText.textContent = describeTrigger(trigger);
  el.banner.hidden = false;

  // Re-trigger the flash even if the banner was already visible.
  el.banner.classList.remove('flash');
  void el.banner.offsetWidth;
  el.banner.classList.add('flash');

  startClock();
}

function describeTrigger(t) {
  const who = t.speaker && t.speaker !== 'Someone' ? t.speaker : 'Someone';
  switch (t.kind) {
    case TRIGGER_KIND.NAME:
      return t.directedQuestion ? `${who} asked you something` : `${who} mentioned you`;
    case TRIGGER_KIND.PROJECT:
      return `${who} mentioned ${t.label}`;
    case TRIGGER_KIND.PERSON:
      return `${who} mentioned ${t.label}`;
    default:
      return `${who} mentioned you`;
  }
}

function renderNotes(notes, done) {
  const ask = notes?.ask ?? '';
  const context = notes?.context ?? '';

  el.ask.textContent = ask;
  el.ask.classList.toggle('streaming', !done && ask.length > 0);
  // An empty ask on a finished response means the model judged the mention
  // incidental — show the banner alone rather than an empty card.
  el.askCard.hidden = !ask;

  el.context.textContent = context;
  el.context.classList.toggle('streaming', !done && context.length > 0);
  el.contextCard.hidden = !context;
}

function renderSummary(summary) {
  if (!summary) {
    el.summaryCard.hidden = true;
    return;
  }
  el.summary.replaceChildren(
    ...summary
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const div = document.createElement('div');
        div.textContent = line;
        return div;
      }),
  );
  el.summaryCard.hidden = false;
}

function renderWarnings(warnings) {
  if (!warnings?.length) {
    el.warnings.hidden = true;
    el.warnings.replaceChildren();
    return;
  }
  el.warnings.replaceChildren(
    ...warnings.map((w) => {
      const div = document.createElement('div');
      div.textContent = w.message ?? w.code;
      if (w.hint) {
        const code = document.createElement('code');
        code.textContent = ` ${w.hint}`;
        div.append(code);
      }
      return div;
    }),
  );
  el.warnings.hidden = false;
}

function toggleEmpty(active, trigger) {
  const showEmpty = !active && !trigger;
  el.empty.hidden = !showEmpty;
  if (showEmpty) {
    el.banner.hidden = true;
    el.askCard.hidden = true;
    el.contextCard.hidden = true;
    stopClock();
    resetStartButton();
  }
}

function resetStartButton() {
  el.start.disabled = false;
  el.start.textContent = 'Start listening';
}

function appendMetric(text) {
  el.metrics.textContent = text;
  el.metrics.hidden = false;
}

// --- relative time on the banner -------------------------------------------

function startClock() {
  stopClock();
  const tick = () => {
    const secs = Math.max(0, Math.round((Date.now() - lastTriggerAt) / 1000));
    el.bannerTime.textContent = secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`;
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
  el.bannerTime.textContent = '';
}

function stripMeetSuffix(title) {
  return title.replace(/\s*[-–|]\s*Google Meet\s*$/i, '').trim() || title;
}

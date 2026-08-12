/**
 * Service worker — orchestration.
 *
 * Owns session state, the trigger matcher, speaker attribution, and LLM
 * dispatch. Holds no audio and no sockets; those live in the offscreen
 * document because this context gets torn down when idle.
 *
 * Staying alive: during a call, transcript segments arrive continuously and
 * the side panel holds an open port, both of which reset the idle timer. There
 * is deliberately no keepalive hack — if audio stops flowing, there is nothing
 * to orchestrate.
 */

import { MSG, CHANNEL, OFFSCREEN_PATH, TUNING } from './lib/constants.js';
import { loadProfile, onProfileChanged, buildTriggerSet, vocabularyHints } from './lib/profile.js';
import { Matcher } from './detect/matcher.js';
import { streamNotes } from './llm/notes.js';
import { SummaryWorker } from './llm/summary.js';
import { createLogger, setLogSink, setLogLevel, CONTEXTS } from './lib/logger.js';

const log = createLogger(CONTEXTS.SW);

/**
 * Ring buffer of every log entry from every context. The panel renders this,
 * so the user has one place to watch instead of four DevTools consoles.
 */
const logRing = [];

// The service worker must not forward its own logs through sendMessage — that
// would be a message loop back into this same listener.
setLogSink((entry) => {
  logRing.push(entry);
  if (logRing.length > TUNING.LOG_RING_SIZE) logRing.shift();
  toPanel(MSG.PANEL_LOG, entry);
});

// --- state -----------------------------------------------------------------

let profile = null;
let matcher = null;

const session = {
  active: false,
  tabId: null,
  title: '',
  startedAt: 0,
  /** @type {Array<{speaker: string, text: string, tStart: number, tEnd: number, channel: string}>} */
  transcript: [],
  /** @type {Array<{name: string, tStart: number, tEnd: number}>} */
  speakingWindows: [],
  roster: [],
  summary: '',
  status: 'idle',
  lastTrigger: null,
  notes: { ask: '', context: '' },
  warnings: [],
};

/** @type {chrome.runtime.Port|null} */
let panelPort = null;
/** @type {AbortController|null} */
let notesController = null;

const summaryWorker = new SummaryWorker({
  getProfile: () => profile,
  onSummary: (summary) => {
    session.summary = summary;
    log.info('summary updated', { lines: summary.split('\n').length, chars: summary.length });
    toPanel(MSG.PANEL_SUMMARY, { summary });
  },
  onError: (err) => warn('summary_failed', err?.message ?? String(err)),
});

// --- boot ------------------------------------------------------------------

init();

async function init() {
  // MUST stay false. `openPanelOnActionClick: true` makes Chrome handle the
  // toolbar click itself, and `chrome.action.onClicked` then never fires — so
  // the panel would open but capture would never start. The setting persists
  // per profile, so this has to be set explicitly rather than merely omitted:
  // a profile that once had it enabled keeps it across reloads.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

  profile = await loadProfile();
  setLogLevel(profile.logLevel);
  rebuildMatcher();

  log.info('service worker ready', {
    logLevel: profile.logLevel,
    hasApiKey: Boolean(profile.openai.apiKey),
    user: profile.user.name || '(not set)',
    projects: profile.projects.length,
    people: profile.people.length,
    captureMic: profile.captureMic,
  });

  if (!profile.openai.apiKey) log.warn('no API key set — open options before starting');
  if (!profile.user.name) log.warn('no name set — name mentions cannot be detected');

  onProfileChanged((next) => {
    profile = next;
    setLogLevel(profile.logLevel);
    rebuildMatcher();
    log.info('profile updated', {
      logLevel: profile.logLevel,
      hasApiKey: Boolean(profile.openai.apiKey),
      sensitivity: profile.sensitivity,
    });
  });
}

function rebuildMatcher() {
  const triggers = buildTriggerSet(profile);
  matcher = new Matcher(triggers, {
    sensitivity: profile.sensitivity,
    cooldownMs: TUNING.TRIGGER_COOLDOWN_MS,
  });
  // Showing the actual watch list is the fastest way to spot "I typed my name
  // but nothing fires" — an empty list here explains it immediately.
  log.info(`watching ${triggers.length} trigger phrase(s)`, {
    sensitivity: profile.sensitivity,
    phrases: triggers.map((t) => `${t.kind}:${t.alias}`),
  });
  if (!triggers.length) log.warn('trigger list is empty — nothing can fire');
}

// --- session start / stop --------------------------------------------------

chrome.action.onClicked.addListener(async (tab) => {
  // If this line never appears, chrome.action.onClicked is not firing — see
  // the openPanelOnActionClick note in init().
  log.info('toolbar icon clicked', { tabId: tab?.id, url: tab?.url });
  // Must run inside the user gesture, before any await.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  await toggleSession(tab, 'toolbar');
});

/** Shared by the toolbar icon and the panel's own Start button. */
async function toggleSession(tab, source) {
  log.debug('toggleSession', { source, active: session.active, tabId: tab?.id });

  if (session.active) {
    await stopSession();
    return;
  }

  if (!tab?.id) {
    warn('no_tab', 'Could not find the Meet tab to capture.');
    pushSnapshot();
    return;
  }

  if (!tab.url?.startsWith('https://meet.google.com/')) {
    warn(
      'not_a_meet_tab',
      'This tab is not a Google Meet call. Switch to the Meet tab and click the extension icon there.',
    );
    pushSnapshot();
    return;
  }

  await startSession(tab);
}

async function startSession(tab) {
  if (!profile) profile = await loadProfile();

  if (!profile.openai.apiKey) {
    warn('no_api_key', 'Add your OpenAI API key in the extension options.');
    setStatus('needs_setup');
    pushSnapshot();
    chrome.runtime.openOptionsPage();
    return;
  }

  session.active = true;
  session.tabId = tab.id;
  session.title = tab.title ?? '';
  session.startedAt = Date.now();
  session.transcript = [];
  session.speakingWindows = [];
  session.summary = '';
  session.notes = { ask: '', context: '' };
  session.lastTrigger = null;
  session.warnings = [];
  matcher.reset();
  summaryWorker.reset();
  setStatus('starting');

  const done = log.timer('session start');
  log.info('starting session', { tabId: tab.id, title: session.title });

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    log.debug('got tab media stream id', { streamId: `${String(streamId).slice(0, 8)}…` });

    await ensureOffscreen();

    const res = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: MSG.START_CAPTURE,
      payload: {
        streamId,
        apiKey: profile.openai.apiKey,
        transcribeModel: profile.openai.transcribeModel,
        keywords: vocabularyHints(profile),
        captureMic: profile.captureMic,
      },
    });

    if (!res?.ok) throw new Error(res?.error ?? 'capture failed to start');
    setStatus('listening');
    done({ ok: true });
  } catch (err) {
    const message = err?.message ?? String(err);
    // tabCapture is gated on the extension having been invoked for the tab.
    // The panel's Start button doesn't carry that grant; the toolbar icon does.
    const gestureIssue = /not been invoked|activeTab|permission/i.test(message);
    warn(
      'start_failed',
      message,
      gestureIssue ? 'Click the extension icon in the toolbar while the Meet tab is focused.' : undefined,
    );
    await stopSession();
  }

  pushSnapshot();
}

async function stopSession() {
  if (session.active) {
    log.info('stopping session', {
      durationSec: Math.round((Date.now() - session.startedAt) / 1000),
      finalSegments: session.transcript.length,
      hadSummary: Boolean(session.summary),
    });
  }
  session.active = false;
  setStatus('idle');
  notesController?.abort();
  notesController = null;
  summaryWorker.abort();

  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: MSG.STOP_CAPTURE });
  } catch {
    /* offscreen already gone */
  }
  await closeOffscreen();
  pushSnapshot();
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification:
      'Capture meeting audio for live transcription and play the mention alert chime.',
  });
}

async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument();
  } catch {
    /* nothing to close */
  }
}

// --- inbound messages ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Anything addressed to the offscreen document is not ours.
  if (msg?.target === 'offscreen') return false;

  switch (msg?.type) {
    case MSG.LOG:
      // A log entry forwarded from another context. Store and fan out.
      logRing.push(msg.payload);
      if (logRing.length > TUNING.LOG_RING_SIZE) logRing.shift();
      toPanel(MSG.PANEL_LOG, msg.payload);
      break;
    case MSG.TRANSCRIPT_SEGMENT:
      handleSegment(msg.payload);
      break;
    case MSG.SPEAKER_ACTIVITY:
      recordSpeaking(msg.payload);
      break;
    case MSG.ROSTER_UPDATED: {
      const before = session.roster.length;
      session.roster = msg.payload.participants ?? [];
      if (session.roster.length !== before) {
        log.info(`roster: ${session.roster.length} participant(s)`, {
          names: session.roster.map((p) => p.name || '(unnamed)'),
        });
      }
      break;
    }
    case MSG.ATTRIBUTION_DEGRADED:
      warn('attribution_degraded', msg.payload.reason, msg.payload.hint);
      pushSnapshot();
      break;
    case MSG.CALL_STARTED:
      log.info('Meet call detected', { title: msg.payload?.title });
      break;
    case MSG.CALL_ENDED:
      log.info('Meet call ended');
      if (session.active) stopSession();
      break;
    case MSG.CAPTURE_STATE:
      log.debug('capture state', msg.payload);
      if (msg.payload.running && session.active) setStatus('listening');
      pushSnapshot();
      break;
    case MSG.CAPTURE_ERROR:
      warn(msg.payload.code, msg.payload.message);
      pushSnapshot();
      break;
    default:
      return false;
  }
  sendResponse?.({ ok: true });
  return false;
});

// --- transcript handling ---------------------------------------------------

function handleSegment(seg) {
  if (!session.active || !seg?.text) return;

  const speaker = attribute(seg);

  if (seg.isFinal) {
    session.transcript.push({ ...seg, speaker });
    if (session.transcript.length > TUNING.TRANSCRIPT_MAX_SEGMENTS) {
      session.transcript.splice(0, session.transcript.length - TUNING.TRANSCRIPT_MAX_SEGMENTS);
    }
    // Finals are the readable record of the meeting — always logged.
    log.info(`⟨${seg.channel}⟩ ${speaker}: ${seg.text}`);
    summaryWorker.add(`${speaker}: ${seg.text}`);
    return;
  }

  // Interim arrives many times per second; throttled so it shows the pipeline
  // is alive without drowning everything else.
  log.throttle(
    `interim:${seg.channel}`,
    TUNING.LOG_THROTTLE_INTERIM_MS,
    'debug',
    `⟨${seg.channel}⟩ …${seg.text.slice(-70)}`,
  );

  // Interim. This is the latency-critical path: scanning here is what lets the
  // alert fire before the speaker finishes their sentence.
  //
  // Self-channel audio is skipped — the user cannot mention themselves into an
  // alert, and scanning it would fire on them saying their own project name.
  if (seg.channel === CHANNEL.SELF) return;

  const triggers = matcher.scan(seg.text);
  if (!triggers.length) return;

  const trigger = triggers[0];
  onTrigger(trigger, { ...seg, speaker });
}

/**
 * Match a transcript segment to whoever Meet showed as the active speaker over
 * the same window. Best-effort: an unresolved segment still counts, it just
 * reads as "Someone".
 */
function attribute(seg) {
  if (seg.channel === CHANNEL.SELF) return profile?.user?.name || 'You';

  const slack = TUNING.ATTRIBUTION_SLACK_MS;
  let best = null;
  let bestOverlap = 0;

  for (const w of session.speakingWindows) {
    const overlap =
      Math.min(seg.tEnd + slack, w.tEnd) - Math.max(seg.tStart - slack, w.tStart);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = w;
    }
  }

  return best?.name || 'Someone';
}

function recordSpeaking(win) {
  if (!win?.name) return;
  log.throttle('speaking', 4000, 'debug', `speaking: ${win.name}`, {
    ms: win.tEnd - win.tStart,
  });
  session.speakingWindows.push(win);
  // Only windows that could still overlap an incoming segment are useful.
  const cutoff = Date.now() - 120000;
  session.speakingWindows = session.speakingWindows.filter((w) => w.tEnd >= cutoff);
}

// --- trigger -> notes ------------------------------------------------------

async function onTrigger(trigger, seg) {
  const tDetected = Date.now();

  log.warn(`🔔 TRIGGER · ${trigger.kind}:${trigger.label}`, {
    heardAs: trigger.matchedText,
    matchedAlias: trigger.matchedAlias,
    score: Number(trigger.score.toFixed(3)),
    directedQuestion: trigger.directedQuestion,
    speaker: seg.speaker,
    utterance: seg.text,
  });

  // 0ms tier: sound and banner fire now, before any network call.
  if (profile.soundEnabled) {
    chrome.runtime
      .sendMessage({ target: 'offscreen', type: MSG.PLAY_ALERT })
      .catch(() => {});
  }

  session.lastTrigger = {
    ...trigger,
    speaker: seg.speaker,
    utterance: seg.text,
    at: tDetected,
  };
  session.notes = { ask: '', context: '' };
  toPanel(MSG.PANEL_TRIGGER, session.lastTrigger);

  // Only escalate to the LLM when it's worth the tokens.
  const wantsNotes = profile.triggers.questionOnly ? trigger.directedQuestion : true;
  if (!wantsNotes) {
    log.info('skipping notes — questionOnly is on and this was not a direct question');
    return;
  }

  // A newer trigger supersedes an older one — never race two renders.
  notesController?.abort();
  notesController = new AbortController();
  // The summary must never sit in front of an alert in the network queue.
  summaryWorker.abort();

  let tFirstToken = 0;
  const verbatim = recentVerbatim();

  log.info('requesting notes', {
    model: profile.openai.notesModel,
    summaryChars: session.summary.length,
    verbatimChars: verbatim.length,
    verbatimLines: verbatim ? verbatim.split('\n').length : 0,
  });

  try {
    const notes = await streamNotes({
      profile,
      trigger,
      summary: session.summary,
      verbatim,
      utterance: seg.text,
      signal: notesController.signal,
      onDelta: (partial) => {
        if (!tFirstToken) {
          tFirstToken = Date.now();
          const ms = tFirstToken - tDetected;
          // The number that decides whether this feels instant or laggy.
          log.info(`⏱ first note token ${ms}ms after trigger`);
          toPanel(MSG.PANEL_METRICS, { detectedAt: tDetected, firstTokenMs: ms });
        }
        session.notes = partial;
        toPanel(MSG.PANEL_NOTES_DELTA, partial);
      },
    });

    session.notes = notes;
    const totalMs = Date.now() - tDetected;
    log.info(`⏱ notes complete ${totalMs}ms`, {
      ask: notes.ask || '(none — judged incidental)',
      context: notes.context || '(none)',
    });
    toPanel(MSG.PANEL_NOTES_DONE, { ...notes, totalMs });
  } catch (err) {
    if (err?.name === 'AbortError') {
      log.debug('notes request superseded by a newer trigger');
    } else {
      warn('notes_failed', err?.message ?? String(err));
      toPanel(MSG.PANEL_NOTES_DONE, { ...session.notes, error: err?.message });
    }
  } finally {
    notesController = null;
  }
}

/** Speaker-attributed transcript from the last NOTES_VERBATIM_MS. */
function recentVerbatim() {
  const cutoff = Date.now() - TUNING.NOTES_VERBATIM_MS;
  return session.transcript
    .filter((s) => s.tEnd >= cutoff)
    .map((s) => `${s.speaker}: ${s.text}`)
    .join('\n');
}

// --- side panel port -------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== MSG.PANEL_PORT) return;
  panelPort = port;
  pushSnapshot();
  // Replay the backlog so the panel shows what happened before it opened —
  // including anything logged during startup.
  port.postMessage({ type: MSG.PANEL_LOG_BATCH, payload: { entries: logRing } });

  port.onDisconnect.addListener(() => {
    panelPort = null;
  });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'panel:start') await startFromPanel();
    if (msg?.type === 'panel:stop') await stopSession();
    if (msg?.type === 'panel:openOptions') chrome.runtime.openOptionsPage();
    if (msg?.type === 'panel:dismissWarnings') {
      session.warnings = [];
      pushSnapshot();
    }
    if (msg?.type === 'panel:clearLog') {
      logRing.length = 0;
      port.postMessage({ type: MSG.PANEL_LOG_BATCH, payload: { entries: [], cleared: true } });
      log.info('log cleared');
    }
    if (msg?.type === 'panel:diagnostics') {
      logDiagnostics();
    }
  });
});

/**
 * Dump a snapshot of everything that decides whether this works. This is the
 * one thing to run when something is wrong and it isn't obvious why.
 */
function logDiagnostics() {
  const triggers = buildTriggerSet(profile);
  log.info('=== diagnostics ===', {
    profile: {
      name: profile.user.name || '(not set)',
      aliases: profile.user.aliases,
      projects: profile.projects.map((p) => p.name),
      people: profile.people.map((p) => `${p.name} (${p.relation})`),
      sensitivity: profile.sensitivity,
      triggers: profile.triggers,
      captureMic: profile.captureMic,
      soundEnabled: profile.soundEnabled,
    },
    credentials: {
      apiKey: profile.openai.apiKey, // redacted by the logger
      notesModel: profile.openai.notesModel,
      summaryModel: profile.openai.summaryModel,
      transcribeModel: profile.openai.transcribeModel,
    },
    watchList: triggers.map((t) => `${t.kind}:${t.alias}`),
    session: {
      active: session.active,
      status: session.status,
      tabId: session.tabId,
      uptimeSec: session.active ? Math.round((Date.now() - session.startedAt) / 1000) : 0,
      finalSegments: session.transcript.length,
      speakingWindows: session.speakingWindows.length,
      roster: session.roster.map((p) => p.name),
      summaryChars: session.summary.length,
      warnings: session.warnings.map((w) => w.code),
    },
  });
}

/**
 * Start from the panel's own button rather than the toolbar icon.
 *
 * Prefers a Meet tab in the current window so it works even if the user has
 * focused another tab while the panel is open.
 */
async function startFromPanel() {
  const [meetTab] = await chrome.tabs.query({
    url: 'https://meet.google.com/*',
    currentWindow: true,
  });
  const target =
    meetTab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  await toggleSession(target);
}

function toPanel(type, payload) {
  try {
    panelPort?.postMessage({ type, payload });
  } catch {
    panelPort = null;
  }
}

function pushSnapshot() {
  toPanel(MSG.PANEL_SNAPSHOT, {
    active: session.active,
    status: session.status,
    title: session.title,
    startedAt: session.startedAt,
    summary: session.summary,
    trigger: session.lastTrigger,
    notes: session.notes,
    warnings: session.warnings,
    roster: session.roster,
  });
}

function setStatus(status) {
  session.status = status;
  toPanel(MSG.PANEL_STATUS, { status, active: session.active });
}

function warn(code, message, hint) {
  const entry = { code, message, hint, at: Date.now() };
  // Keep the list short and free of duplicates so the panel stays readable.
  session.warnings = [
    entry,
    ...session.warnings.filter((w) => w.code !== code),
  ].slice(0, 5);
  log.error(`${code}: ${message}`, hint ? { hint } : undefined);
}

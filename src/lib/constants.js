/**
 * Shared constants: message types, storage keys, and latency-critical tunables.
 *
 * Anything that gets tuned during the latency pass lives in TUNING so there's
 * one place to look when the alert feels late or the alerts feel spammy.
 */

export const STORAGE_KEY = 'mentionRadarProfile';

/** Runtime message types. Every cross-context message uses one of these. */
export const MSG = {
  // content script -> service worker
  CALL_STARTED: 'call:started',
  CALL_ENDED: 'call:ended',
  SPEAKER_ACTIVITY: 'speaker:activity',
  ROSTER_UPDATED: 'roster:updated',
  ATTRIBUTION_DEGRADED: 'attribution:degraded',

  // service worker -> offscreen
  START_CAPTURE: 'capture:start',
  STOP_CAPTURE: 'capture:stop',
  PLAY_ALERT: 'alert:play',

  // offscreen -> service worker
  TRANSCRIPT_SEGMENT: 'transcript:segment',
  CAPTURE_STATE: 'capture:state',
  CAPTURE_ERROR: 'capture:error',

  // any context -> service worker (structured log entry)
  LOG: 'log:entry',

  // service worker <-> side panel (over a long-lived port)
  PANEL_PORT: 'panel',
  PANEL_LOG: 'panel:log',
  PANEL_LOG_BATCH: 'panel:log:batch',
  PANEL_SNAPSHOT: 'panel:snapshot',
  PANEL_TRIGGER: 'panel:trigger',
  PANEL_NOTES_DELTA: 'panel:notes:delta',
  PANEL_NOTES_DONE: 'panel:notes:done',
  PANEL_SUMMARY: 'panel:summary',
  PANEL_STATUS: 'panel:status',
  PANEL_METRICS: 'panel:metrics',
};

/** Which audio channel a transcript segment arrived on. */
export const CHANNEL = {
  /** Tab audio — everyone except the user. */
  REMOTE: 'remote',
  /** The user's own microphone. */
  SELF: 'self',
};

/** What kind of thing matched. */
export const TRIGGER_KIND = {
  NAME: 'name',
  PROJECT: 'project',
  PERSON: 'person',
};

export const TUNING = {
  /** Realtime API wants mono PCM16 at this rate. */
  TARGET_SAMPLE_RATE: 24000,

  /** Frames per PCM chunk sent upstream. 20ms @ 24kHz keeps latency low. */
  PCM_CHUNK_SAMPLES: 480,

  /**
   * Mic VAD: RMS above this opens the gate, and it stays open for
   * VAD_HANGOVER_MS after the last frame above threshold so we don't chop
   * the tails off words. Tuned during the latency pass.
   */
  VAD_RMS_OPEN: 0.012,
  VAD_HANGOVER_MS: 700,

  /** Don't re-fire the same alias more than once per this window. */
  TRIGGER_COOLDOWN_MS: 20000,

  /** Fuzzy match threshold if the profile doesn't override it. */
  DEFAULT_SENSITIVITY: 0.82,

  /** Max token-window width when scanning for aliases. */
  MATCH_WINDOW_MAX_TOKENS: 3,

  /** How much verbatim transcript to hand the notes call. */
  NOTES_VERBATIM_MS: 90000,

  /** Rolling summary fires on whichever comes first. */
  SUMMARY_INTERVAL_MS: 45000,
  SUMMARY_CHAR_THRESHOLD: 1200,

  /**
   * A `name` trigger counts as a question directed at the user if an
   * interrogative/imperative cue lands within this many tokens of it.
   */
  QUESTION_PROXIMITY_TOKENS: 12,

  /** Transcript ring buffer cap, in segments. */
  TRANSCRIPT_MAX_SEGMENTS: 2000,

  /** How far a segment's midpoint may sit outside a speaking window and
   *  still be attributed to that speaker. Covers STT lag jitter. */
  ATTRIBUTION_SLACK_MS: 1200,

  /** Log entries kept in the service worker ring buffer for the panel. */
  LOG_RING_SIZE: 600,

  /** "Audio is still flowing" heartbeat interval. */
  AUDIO_HEARTBEAT_MS: 5000,

  /** Hot-path log throttles, so interim transcript can't flood the view. */
  LOG_THROTTLE_INTERIM_MS: 1500,
};

/** Offscreen document path — referenced by both the SW and the doc itself. */
export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

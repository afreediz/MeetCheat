/**
 * OpenAI Realtime transcription adapter.
 *
 * This is the ONLY file that knows the Realtime wire format. Everything
 * upstream consumes the TranscriptSource shape below, so a protocol change is
 * a one-file fix.
 *
 *   interface TranscriptSource {
 *     start()
 *     sendPcm(Int16Array)
 *     stop()
 *     onSegment(cb)   // { text, isFinal, tStart, tEnd, channel }
 *   }
 *
 * Verified against the Realtime transcription + WebSocket guides:
 *   endpoint  wss://api.openai.com/v1/realtime?intent=transcription
 *   config    session.update  { session: { type: 'transcription', audio: {...} } }
 *   audio in  input_audio_buffer.append  (base64 PCM16)
 *   partials  conversation.item.input_audio_transcription.delta
 *   finals    conversation.item.input_audio_transcription.completed
 */

import { CHANNEL } from './lib/constants.js';
import { createLogger, CONTEXTS } from './lib/logger.js';

const log = createLogger(CONTEXTS.REALTIME);

// `intent=transcription` is what selects a transcription session. Without any
// query param the server rejects the connection with `missing_model`; with
// `?model=<id>` it opens a *conversation* session instead and then refuses the
// transcription session.update ("not supported in transcription mode"). The
// model id belongs in session.update → audio.input.transcription.model, which
// is where _configureSession puts it.
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

/**
 * Base64-encode PCM samples for `input_audio_buffer.append`.
 *
 * Chunked because String.fromCharCode.apply blows the argument limit on large
 * buffers, and this runs on every 20ms of audio.
 */
function pcmToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export class RealtimeTranscriber {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model            transcription model id (user-editable)
   * @param {string} opts.channel          CHANNEL.REMOTE | CHANNEL.SELF
   * @param {number} opts.sampleRate
   * @param {string[]} [opts.keywords]     proper nouns to bias toward
   * @param {(seg: object) => void} opts.onSegment
   * @param {(err: object) => void} [opts.onError]
   * @param {(state: string) => void} [opts.onState]
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.channel = opts.channel ?? CHANNEL.REMOTE;
    this.sampleRate = opts.sampleRate;
    this.keywords = opts.keywords ?? [];
    this.onSegment = opts.onSegment ?? (() => {});
    this.onError = opts.onError ?? (() => {});
    this.onState = opts.onState ?? (() => {});

    /** @type {WebSocket|null} */
    this.ws = null;
    this.state = 'idle';
    this.closedByUs = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;

    /**
     * Per-item accumulation. The API groups a turn under an item_id; we use the
     * first delta for that id as the segment's start time, which is what the
     * speaker-attribution correlator needs.
     * @type {Map<string, {startedAt: number, text: string}>}
     */
    this.items = new Map();

    /** Samples dropped while the socket was down — surfaced for diagnostics. */
    this.droppedChunks = 0;

    /**
     * 'keywords' is the real thing — a literal term list the model biases
     * toward. Only some transcription models take it, and the model id is
     * user-editable, so a rejection downgrades this to 'prompt' (supported
     * everywhere, weaker) rather than leaving the session unconfigured.
     * @type {'keywords'|'prompt'}
     */
    this.biasMode = 'keywords';
  }

  start() {
    this.closedByUs = false;
    this._connect();
  }

  stop() {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try {
        this.ws.close(1000, 'client stop');
      } catch {
        /* already closing */
      }
    }
    this.ws = null;
    this.items.clear();
    this._setState('idle');
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Push one chunk of mono PCM16. Dropped silently if the socket is down —
   * buffering across a reconnect would grow without bound and the transcript
   * gap is less harmful than the memory.
   * @param {Int16Array} int16
   */
  sendPcm(int16) {
    if (!this.isOpen || !int16?.length) {
      if (!this.isOpen) this.droppedChunks += 1;
      return;
    }
    this._send({
      type: 'input_audio_buffer.append',
      audio: pcmToBase64(int16),
    });
  }

  // --- internals -----------------------------------------------------------

  _connect() {
    this._setState('connecting');
    log.info(`[${this.channel}] connecting`, {
      model: this.model,
      sampleRate: this.sampleRate,
      keywords: this.keywords.length,
      attempt: this.reconnectAttempt,
    });

    // A WebSocket in a browser context cannot set request headers, so auth
    // rides the subprotocol array. The `openai-insecure-api-key` label warns
    // against shipping a key to *other people's* browsers in a web app; here
    // the browser belongs to the key's owner and the key never leaves their
    // machine, so this is the correct channel rather than a shortcut. If this
    // is ever distributed to other users, mint short-lived tokens server-side
    // and swap the value below.
    const protocols = ['realtime', `openai-insecure-api-key.${this.apiKey}`];

    let ws;
    try {
      ws = new WebSocket(REALTIME_URL, protocols);
    } catch (err) {
      this._fail('connect_failed', err?.message ?? String(err));
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      log.info(`[${this.channel}] socket open`);
      this.reconnectAttempt = 0;
      this._configureSession();
      this._setState('open');
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // non-JSON frames are not part of this protocol
      }
      this._handleEvent(msg);
    };

    ws.onerror = () => {
      // The error event carries no useful detail; onclose does the recovery.
      this._fail('socket_error', 'transcription socket error');
    };

    ws.onclose = (event) => {
      this.ws = null;
      this.items.clear();
      if (this.closedByUs) {
        log.info(`[${this.channel}] socket closed by us`);
        this._setState('idle');
        return;
      }
      log.warn(`[${this.channel}] socket closed unexpectedly`, {
        code: event.code,
        reason: event.reason || '(none)',
        droppedChunks: this.droppedChunks,
      });
      this._setState('reconnecting');
      // 1008/1011 with an auth message almost always means a bad key; retrying
      // just burns quota, so surface it and stop.
      if (event.code === 1008 || /api key|unauthor/i.test(event.reason ?? '')) {
        log.error(`[${this.channel}] authentication rejected — check the API key in options`);
        this._fail('auth_failed', event.reason || 'authentication rejected');
        this._setState('failed');
        return;
      }
      // 4000 is how the API reports a rejected request (bad model id, wrong
      // session type). The next attempt sends the identical handshake, so it
      // fails identically — reconnecting would loop until the user notices.
      if (event.code === 4000 || /invalid_request/i.test(event.reason ?? '')) {
        log.error(
          `[${this.channel}] request rejected — check the transcription model id in options`,
          { reason: event.reason || '(none)' },
        );
        this._fail('invalid_request', event.reason || 'realtime request rejected');
        this._setState('failed');
        return;
      }
      this._scheduleReconnect();
    };
  }

  _configureSession() {
    const transcription = { model: this.model };

    // Bias toward the user's own proper nouns. This is what stops "Afreedi"
    // transcribing as "Afridi" in the first place; the phonetic matcher
    // downstream is the backstop for when it still does.
    if (this.keywords.length) {
      const terms = this.keywords.slice(0, 100);
      if (this.biasMode === 'keywords') {
        transcription.keywords = terms;
      } else {
        // Fallback for models without a keywords parameter. Free-text, so it
        // biases less reliably, but it is better than no hint at all.
        transcription.prompt = `Proper nouns that may appear: ${terms.join(', ')}.`;
      }
    }

    this._send({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: this.sampleRate },
            transcription,
            // Server-side VAD segments turns for us. Without it we would have
            // to decide when to commit each buffer, which is exactly the kind
            // of guesswork that adds latency.
            turn_detection: { type: 'server_vad' },
          },
        },
      },
    });
  }

  _handleEvent(msg) {
    switch (msg.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        const id = msg.item_id ?? 'pending';
        let item = this.items.get(id);
        if (!item) {
          item = { startedAt: Date.now(), text: '' };
          this.items.set(id, item);
        }
        item.text += msg.delta ?? '';
        // Interim — this is what the matcher scans, and why the alert can fire
        // before the speaker finishes the sentence.
        this._emit(item.text, false, item.startedAt, Date.now());
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const id = msg.item_id ?? 'pending';
        const item = this.items.get(id);
        const text = msg.transcript ?? item?.text ?? '';
        this._emit(text, true, item?.startedAt ?? Date.now(), Date.now());
        this.items.delete(id);
        break;
      }

      case 'error': {
        const detail = msg.error ?? {};
        // A model that has no `keywords` parameter rejects session.update and
        // leaves the session unconfigured — no transcripts at all. Re-send with
        // prompt biasing instead of losing the channel over a hint.
        if (this._isKeywordsRejection(detail) && this.biasMode === 'keywords') {
          this.biasMode = 'prompt';
          log.warn(
            `[${this.channel}] model "${this.model}" has no keywords support — ` +
              'falling back to prompt biasing (proper nouns will match less reliably)',
          );
          this._configureSession();
          break;
        }
        log.error(`[${this.channel}] API error`, detail);
        this._fail(detail.code ?? 'api_error', detail.message ?? 'realtime error');
        break;
      }

      case 'session.updated':
        log.info(`[${this.channel}] session configured — transcription active`);
        break;

      default:
        // Buffer lifecycle and other bookkeeping events. Logged at debug and
        // throttled so an unfamiliar event type is discoverable without noise.
        log.throttle(`evt:${msg.type}`, 10000, 'debug', `[${this.channel}] ${msg.type}`);
        break;
    }
  }

  /** The API reports this as `invalid_parameter` naming the keywords path. */
  _isKeywordsRejection(detail) {
    return /keywords/.test(`${detail.param ?? ''} ${detail.message ?? ''}`);
  }

  _emit(text, isFinal, tStart, tEnd) {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return;
    this.onSegment({
      text: trimmed,
      isFinal,
      tStart,
      tEnd,
      channel: this.channel,
    });
  }

  _send(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this._fail('send_failed', err?.message ?? String(err));
    }
  }

  _scheduleReconnect() {
    if (this.closedByUs || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    log.info(`[${this.channel}] reconnecting in ${delay}ms`);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUs) this._connect();
    }, delay);
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  _fail(code, message) {
    this.onError({ code, message, channel: this.channel });
  }
}

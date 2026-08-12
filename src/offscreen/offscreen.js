/**
 * Offscreen audio worker.
 *
 * Owns: tab capture, mic capture, the Web Audio graph, both transcription
 * sockets, and the alert chime. Runs for the life of the call.
 *
 * Two sockets, deliberately not one mixed stream: OpenAI Realtime
 * transcription returns no speaker diarization, so the audio *channel* is the
 * only reliable way to tell the user apart from everyone else. Mixing would
 * throw that away permanently.
 */

import { MSG, CHANNEL, TUNING } from '../lib/constants.js';
import { RealtimeTranscriber } from '../realtime-client.js';
import { createLogger, CONTEXTS } from '../lib/logger.js';

const log = createLogger(CONTEXTS.OFFSCREEN);

const WORKLET_URL = chrome.runtime.getURL('src/audio/pcm-worklet.js');

/**
 * Per-channel audio counters, reported on a heartbeat.
 *
 * This is the single most useful signal when nothing is transcribing: it
 * separates "no audio is reaching us" from "audio is fine, the socket is
 * broken" — two very different problems that look identical from the panel.
 */
const audioStats = {
  [CHANNEL.REMOTE]: newStats(),
  [CHANNEL.SELF]: newStats(),
};
let heartbeatTimer = null;

function newStats() {
  return { chunks: 0, sent: 0, gated: 0, rmsSum: 0, peakRms: 0 };
}

/** @type {AudioContext|null} */
let audioCtx = null;
let tabStream = null;
let micStream = null;
/** @type {RealtimeTranscriber|null} */
let remoteTranscriber = null;
/** @type {RealtimeTranscriber|null} */
let selfTranscriber = null;
let running = false;
/** Web Audio nodes we created, so teardown can disconnect all of them. */
let graphNodes = [];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  switch (msg.type) {
    case MSG.START_CAPTURE:
      startCapture(msg.payload)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => {
          report('capture_failed', err?.message ?? String(err));
          sendResponse({ ok: false, error: err?.message ?? String(err) });
        });
      return true; // async response

    case MSG.STOP_CAPTURE:
      stopCapture();
      sendResponse({ ok: true });
      return false;

    case MSG.PLAY_ALERT:
      log.debug('playing alert chime');
      playAlert();
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

/**
 * @param {{streamId: string, apiKey: string, transcribeModel: string,
 *          keywords: string[], captureMic: boolean}} cfg
 */
async function startCapture(cfg) {
  if (running) stopCapture();
  running = true;

  log.info('startCapture', {
    transcribeModel: cfg.transcribeModel,
    captureMic: cfg.captureMic,
    keywords: cfg.keywords,
    apiKey: cfg.apiKey, // redacted by the logger
  });

  if (!cfg.apiKey) throw new Error('No OpenAI API key set — open the extension options.');

  // Default sample rate, not a forced 24000: forcing a rate on a tab-capture
  // stream is unreliable across platforms. The worklet resamples instead.
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule(WORKLET_URL);
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  log.info('audio context ready', {
    sampleRate: audioCtx.sampleRate,
    state: audioCtx.state,
    resampleRatio: (audioCtx.sampleRate / TUNING.TARGET_SAMPLE_RATE).toFixed(3),
  });

  // --- tab audio: everyone except the user -------------------------------
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: cfg.streamId,
      },
    },
    video: false,
  });

  const tabTrack = tabStream.getAudioTracks()[0];
  log.info('tab audio captured', {
    label: tabTrack?.label,
    settings: tabTrack?.getSettings?.(),
  });

  const tabSource = audioCtx.createMediaStreamSource(tabStream);

  // CRITICAL: tabCapture silences the tab for the user. Routing the captured
  // stream back to the speakers is what keeps the meeting audible. Without
  // this line the extension appears to "mute the call".
  tabSource.connect(audioCtx.destination);
  log.info('speaker loopback connected — the meeting should still be audible');

  remoteTranscriber = makeTranscriber(cfg, CHANNEL.REMOTE);
  remoteTranscriber.start();
  attachWorklet(tabSource, remoteTranscriber, { gated: false });

  watchStreamEnd(tabStream, 'tab');

  // --- mic: the user -----------------------------------------------------
  if (cfg.captureMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      const micTrack = micStream.getAudioTracks()[0];
      log.info('microphone captured', { label: micTrack?.label });

      const micSource = audioCtx.createMediaStreamSource(micStream);
      selfTranscriber = makeTranscriber(cfg, CHANNEL.SELF);
      selfTranscriber.start();
      // Note: deliberately NOT connected to destination — that would echo the
      // user's own voice back at them through their speakers.
      attachWorklet(micSource, selfTranscriber, { gated: true });

      watchStreamEnd(micStream, 'mic');
    } catch (err) {
      // Mic is a nice-to-have: without it the summary just misses the user's
      // own turns. Losing it must not take the whole session down.
      log.warn('microphone unavailable — continuing with tab audio only', {
        error: err?.message ?? String(err),
      });
      report('mic_unavailable', err?.message ?? String(err));
    }
  } else {
    log.info('microphone capture disabled in options');
  }

  startHeartbeat();
  postState();
}

/**
 * Periodic proof of life for the audio path. Reports how much audio each
 * channel produced, how much the mic gate let through, and the signal level —
 * enough to tell silence apart from a broken socket at a glance.
 */
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!running) return;
    for (const [channel, s] of Object.entries(audioStats)) {
      if (!s.chunks) continue;
      const secs = TUNING.AUDIO_HEARTBEAT_MS / 1000;
      const transcriber = channel === CHANNEL.REMOTE ? remoteTranscriber : selfTranscriber;
      log.info(`♪ ${channel}: ${s.sent}/${s.chunks} chunks sent in ${secs}s`, {
        socket: transcriber?.state ?? 'none',
        gatedOut: s.gated,
        avgRms: Number((s.rmsSum / s.chunks).toFixed(4)),
        peakRms: Number(s.peakRms.toFixed(4)),
        droppedWhileDisconnected: transcriber?.droppedChunks ?? 0,
      });
      if (s.peakRms < 0.0005) {
        log.warn(`${channel} audio is essentially silent — check the source`);
      }
      audioStats[channel] = newStats();
    }
  }, TUNING.AUDIO_HEARTBEAT_MS);
}

function makeTranscriber(cfg, channel) {
  return new RealtimeTranscriber({
    apiKey: cfg.apiKey,
    model: cfg.transcribeModel,
    channel,
    sampleRate: TUNING.TARGET_SAMPLE_RATE,
    keywords: cfg.keywords,
    onSegment: (seg) => {
      chrome.runtime.sendMessage({ type: MSG.TRANSCRIPT_SEGMENT, payload: seg }).catch(noop);
    },
    onError: (err) => report(err.code, err.message, err.channel),
    onState: (state) => {
      log.info(`${channel} socket state -> ${state}`);
      postState();
    },
  });
}

/**
 * Wire a source through the PCM worklet into a transcriber.
 *
 * The worklet is connected to a muted gain node because Chrome only pulls a
 * worklet that has a downstream path to the destination — an unconnected node
 * simply never gets its process() called.
 */
function attachWorklet(source, transcriber, { gated }) {
  const node = new AudioWorkletNode(audioCtx, 'pcm-worklet', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    processorOptions: {
      targetRate: TUNING.TARGET_SAMPLE_RATE,
      chunkSamples: TUNING.PCM_CHUNK_SAMPLES,
      vadRmsOpen: TUNING.VAD_RMS_OPEN,
      vadHangoverMs: TUNING.VAD_HANGOVER_MS,
      gated,
    },
  });

  const stats = audioStats[transcriber.channel];

  node.port.onmessage = (e) => {
    const { pcm, voiced, rms } = e.data;
    stats.chunks += 1;
    stats.rmsSum += rms;
    if (rms > stats.peakRms) stats.peakRms = rms;

    // The gate is why the mic socket costs a fraction of the tab socket.
    if (!voiced) {
      stats.gated += 1;
      return;
    }
    stats.sent += 1;
    transcriber.sendPcm(pcm);
  };

  const mute = audioCtx.createGain();
  mute.gain.value = 0;

  source.connect(node);
  node.connect(mute);
  mute.connect(audioCtx.destination);

  graphNodes.push(node, mute);
}

function watchStreamEnd(stream, label) {
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      if (!running) return;
      log.warn(`${label} audio track ended`);
      report('stream_ended', `${label} audio track ended`);
      if (label === 'tab') stopCapture();
    });
  }
}

function stopCapture() {
  if (running) log.info('stopping capture');
  running = false;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  audioStats[CHANNEL.REMOTE] = newStats();
  audioStats[CHANNEL.SELF] = newStats();

  for (const node of graphNodes) {
    try {
      // Tell the processor to return false so it stops being pulled.
      node.port?.postMessage({ type: 'close' });
      node.disconnect();
    } catch {
      /* graph already torn down */
    }
  }
  graphNodes = [];

  remoteTranscriber?.stop();
  selfTranscriber?.stop();
  remoteTranscriber = null;
  selfTranscriber = null;

  for (const s of [tabStream, micStream]) {
    s?.getTracks().forEach((track) => track.stop());
  }
  tabStream = null;
  micStream = null;

  audioCtx?.close().catch(noop);
  audioCtx = null;

  postState();
}

/**
 * Two-tone chime, synthesised rather than shipped as an audio file — no decode
 * step on the critical path, and nothing to load before the first alert.
 */
function playAlert() {
  const ctx = audioCtx ?? new AudioContext();
  const now = ctx.currentTime;

  const beep = (freq, start, duration) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Ramped envelope; a raw start/stop on a sine clicks audibly.
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.18, now + start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.02);
  };

  beep(880, 0, 0.12);
  beep(1320, 0.1, 0.16);
}

function postState() {
  chrome.runtime
    .sendMessage({
      type: MSG.CAPTURE_STATE,
      payload: {
        running,
        remote: remoteTranscriber?.state ?? 'idle',
        self: selfTranscriber?.state ?? 'idle',
        micActive: Boolean(micStream),
      },
    })
    .catch(noop);
}

function report(code, message, channel) {
  log.error(`${code}: ${message}`, channel ? { channel } : undefined);
  chrome.runtime
    .sendMessage({ type: MSG.CAPTURE_ERROR, payload: { code, message, channel } })
    .catch(noop);
}

function noop() {}

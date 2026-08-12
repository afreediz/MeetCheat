/**
 * PCM worklet tests.
 *
 * The resampler and VAD gate run on the audio thread inside a browser, where
 * they are miserable to debug — a wrong ratio just produces a chipmunk
 * transcript with no error anywhere. Exercising the maths in Node first is far
 * cheaper than finding it mid-call.
 *
 * The worklet is written against AudioWorkletGlobalScope, so we stub that
 * scope before importing it.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let PcmWorklet;
let clock = 0;

before(async () => {
  const registered = {};
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage: () => {}, onmessage: null };
    }
  };
  globalThis.registerProcessor = (name, cls) => {
    registered[name] = cls;
  };
  globalThis.sampleRate = 48000;
  Object.defineProperty(globalThis, 'currentTime', { get: () => clock, configurable: true });

  await import('../src/audio/pcm-worklet.js');
  PcmWorklet = registered['pcm-worklet'];
});

/** Build a processor and capture everything it posts. */
function makeProcessor(processorOptions = {}) {
  const posted = [];
  const proc = new PcmWorklet({
    processorOptions: {
      targetRate: 24000,
      chunkSamples: 480,
      vadRmsOpen: 0.012,
      vadHangoverMs: 700,
      gated: false,
      ...processorOptions,
    },
  });
  proc.port.postMessage = (msg) => posted.push(msg);
  return { proc, posted };
}

/** Feed `blocks` render quanta of a sine at `amplitude`. */
function feed(proc, blocks, amplitude = 0.5, channels = 1, freq = 440) {
  let phase = 0;
  const step = (2 * Math.PI * freq) / 48000;
  for (let b = 0; b < blocks; b++) {
    const quantum = [];
    for (let c = 0; c < channels; c++) quantum.push(new Float32Array(128));
    for (let i = 0; i < 128; i++) {
      const s = Math.sin(phase) * amplitude;
      phase += step;
      for (let c = 0; c < channels; c++) quantum[c][i] = s;
    }
    proc.process([quantum], [[new Float32Array(128)]], {});
    clock += 128 / 48000;
  }
}

test('registers under the expected processor name', () => {
  assert.equal(typeof PcmWorklet, 'function');
});

test('resamples 48kHz down to 24kHz at the right rate', () => {
  const { proc, posted } = makeProcessor();
  // 200 blocks x 128 frames = 25600 input frames -> ~12800 output samples
  // -> ~26 chunks of 480.
  feed(proc, 200);

  const outSamples = posted.reduce((n, m) => n + m.pcm.length, 0);
  const expected = (200 * 128) / 2;
  // Allow one chunk of slack for samples still buffered.
  assert.ok(
    Math.abs(outSamples - expected) <= 480,
    `got ${outSamples} samples, expected ~${expected}`,
  );
});

test('emits fixed-size chunks', () => {
  const { proc, posted } = makeProcessor({ chunkSamples: 480 });
  feed(proc, 100);
  assert.ok(posted.length > 0, 'expected at least one chunk');
  for (const msg of posted) assert.equal(msg.pcm.length, 480);
});

test('emits Int16 samples inside the PCM16 range', () => {
  const { proc, posted } = makeProcessor();
  feed(proc, 60, 1.0);
  const all = posted.flatMap((m) => [...m.pcm]);
  assert.ok(all.length > 0);
  for (const s of all) {
    assert.ok(Number.isInteger(s), 'samples must be integers');
    assert.ok(s >= -32768 && s <= 32767, `sample ${s} out of PCM16 range`);
  }
});

test('does not clip a full-scale signal into wraparound', () => {
  const { proc, posted } = makeProcessor();
  // Amplitude above 1.0 must clamp, not wrap to the opposite sign.
  feed(proc, 60, 2.0);
  const all = posted.flatMap((m) => [...m.pcm]);
  const maxAbs = Math.max(...all.map(Math.abs));
  assert.ok(maxAbs > 30000, 'signal should reach near full scale');
  assert.ok(maxAbs <= 32768, 'signal must clamp rather than wrap');
});

test('downmixes stereo to mono without doubling amplitude', () => {
  const mono = makeProcessor();
  feed(mono.proc, 60, 0.5, 1);
  const monoPeak = Math.max(...mono.posted.flatMap((m) => [...m.pcm]).map(Math.abs));

  clock = 0;
  const stereo = makeProcessor();
  feed(stereo.proc, 60, 0.5, 2);
  const stereoPeak = Math.max(...stereo.posted.flatMap((m) => [...m.pcm]).map(Math.abs));

  assert.ok(
    Math.abs(monoPeak - stereoPeak) / monoPeak < 0.05,
    `mono ${monoPeak} vs stereo ${stereoPeak} — identical content should give the same level`,
  );
});

test('ungated channel reports every chunk as voiced', () => {
  const { proc, posted } = makeProcessor({ gated: false });
  feed(proc, 60, 0.0001); // effectively silence
  assert.ok(posted.length > 0);
  assert.ok(posted.every((m) => m.voiced), 'tab channel must never gate');
});

test('gated channel opens on speech', () => {
  clock = 0;
  const { proc, posted } = makeProcessor({ gated: true });
  feed(proc, 60, 0.5);
  assert.ok(posted.some((m) => m.voiced), 'loud audio should open the gate');
});

test('gated channel stays closed through silence', () => {
  clock = 0;
  const { proc, posted } = makeProcessor({ gated: true });
  feed(proc, 60, 0.0);
  assert.ok(
    posted.every((m) => !m.voiced),
    'silence must not open the mic gate — this is what keeps the second socket cheap',
  );
});

test('gate hangover keeps the tail of a word', () => {
  clock = 0;
  const { proc, posted } = makeProcessor({ gated: true, vadHangoverMs: 700 });
  feed(proc, 40, 0.5); // speech
  const afterSpeech = posted.length;
  feed(proc, 40, 0.0); // ~107ms of silence, well inside the hangover

  const tail = posted.slice(afterSpeech);
  assert.ok(tail.length > 0);
  assert.ok(
    tail.every((m) => m.voiced),
    'silence shortly after speech must stay open, or word tails get clipped',
  );
});

test('gate closes again once hangover expires', () => {
  clock = 0;
  const { proc, posted } = makeProcessor({ gated: true, vadHangoverMs: 100 });
  feed(proc, 20, 0.5);
  const afterSpeech = posted.length;
  feed(proc, 200, 0.0); // ~533ms of silence, far past a 100ms hangover

  const tail = posted.slice(afterSpeech);
  assert.ok(tail.some((m) => !m.voiced), 'gate should eventually close');
});

test('survives an empty or disconnected input without throwing', () => {
  const { proc } = makeProcessor();
  assert.equal(proc.process([], [], {}), true);
  assert.equal(proc.process([[]], [], {}), true);
  assert.equal(proc.process([[new Float32Array(0)]], [], {}), true);
});

test('stops processing after a close message', () => {
  const { proc } = makeProcessor();
  proc.closed = true;
  assert.equal(proc.process([[new Float32Array(128)]], [], {}), false);
});

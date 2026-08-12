/**
 * AudioWorklet: downmix -> anti-alias -> resample -> PCM16 -> VAD gate.
 *
 * Runs on the audio thread so none of this competes with the matcher or the
 * UI. The Realtime API wants mono PCM16 at 24kHz; an AudioContext is usually
 * 48kHz, so resampling is mandatory rather than optional.
 *
 * Posts { pcm: Int16Array, voiced: boolean, rms: number } per chunk. The
 * `voiced` flag is the mic gate: the offscreen document only forwards voiced
 * chunks on the mic socket, so the second transcription stream bills for the
 * fraction of the meeting the user is actually talking rather than all of it.
 */

class PcmWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions ?? {};

    this.targetRate = o.targetRate ?? 24000;
    this.chunkSamples = o.chunkSamples ?? 480;
    this.vadRmsOpen = o.vadRmsOpen ?? 0.012;
    this.vadHangoverSec = (o.vadHangoverMs ?? 700) / 1000;
    /** When false, every chunk reports voiced:true (used for the tab channel). */
    this.gated = o.gated ?? false;

    // `sampleRate` is a global in AudioWorkletGlobalScope.
    this.ratio = sampleRate / this.targetRate;

    // Fractional read position, carried across render quanta so resampling
    // doesn't click at block boundaries.
    this.pos = 0;
    this.prevSample = 0;

    // One-pole lowpass below the new Nyquist. Cheap, and without it the
    // decimation folds high-frequency energy back into the speech band.
    const cutoff = Math.min(this.targetRate * 0.45, sampleRate * 0.45);
    this.lpAlpha = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    this.lpState = 0;

    this.chunk = new Int16Array(this.chunkSamples);
    this.chunkFill = 0;
    this.sumSquares = 0;

    // Scratch for the filtered mono downmix. Writing back into `inputs[0][0]`
    // would be a real bug: the tab source fans out to both this worklet and
    // the speaker loopback, so mutating the input buffer can corrupt what the
    // user hears.
    this.scratch = new Float32Array(128);

    this.voicedUntil = 0;
    this.closed = false;

    this.port.onmessage = (e) => {
      if (e.data?.type === 'close') this.closed = true;
    };
  }

  process(inputs) {
    if (this.closed) return false;

    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      // No input connected yet (or a silent render quantum). Stay alive.
      return true;
    }

    const frames = input[0].length;
    const channels = input.length;

    if (this.scratch.length < frames) this.scratch = new Float32Array(frames);
    const mono = this.scratch;

    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i];
      this.lpState += this.lpAlpha * (sum / channels - this.lpState);
      mono[i] = this.lpState;
    }

    let pos = this.pos;

    while (pos < frames) {
      const i0 = Math.floor(pos);
      const i1 = i0 + 1;
      const s0 = i0 < 0 ? this.prevSample : mono[i0];

      if (i1 >= frames) break; // need the next block to interpolate
      const s1 = i1 < 0 ? this.prevSample : mono[i1];

      const sample = s0 + (s1 - s0) * (pos - i0);
      this._pushSample(sample);
      pos += this.ratio;
    }

    this.pos = pos - frames;
    this.prevSample = mono[frames - 1];

    return true;
  }

  _pushSample(sample) {
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    this.chunk[this.chunkFill] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.sumSquares += clamped * clamped;
    this.chunkFill += 1;

    if (this.chunkFill < this.chunkSamples) return;

    const rms = Math.sqrt(this.sumSquares / this.chunkSamples);

    let voiced = true;
    if (this.gated) {
      if (rms >= this.vadRmsOpen) {
        // Hangover keeps the gate open past the last loud frame so word tails
        // and short pauses mid-sentence don't get clipped off.
        this.voicedUntil = currentTime + this.vadHangoverSec;
      }
      voiced = currentTime < this.voicedUntil;
    }

    // Copy out — the underlying buffer is reused for the next chunk.
    const pcm = this.chunk.slice();
    this.port.postMessage({ pcm, voiced, rms }, [pcm.buffer]);

    this.chunkFill = 0;
    this.sumSquares = 0;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);

/**
 * Rolling meeting summary.
 *
 * Carried forward rather than regenerated: each pass takes the previous
 * summary plus only the new transcript, so cost stays flat as the meeting runs
 * long instead of growing with it.
 *
 * It exists for latency as much as for the user. Because the summary is
 * already digested when a trigger lands, the notes call composes Note 2
 * instead of re-reading twenty minutes of transcript to find it.
 *
 * Always yields to the notes path: any in-flight summary is aborted the moment
 * a trigger needs the network.
 */

import { streamChat } from './openai.js';
import { TUNING } from '../lib/constants.js';

const SYSTEM = `You maintain a running summary of a live meeting for someone who may have half-tuned out and needs to catch up in seconds.

You get the previous summary and the transcript since it was written. Return the updated summary — not a description of what changed.

Keep:
- decisions made, and who made them
- commitments, owners, dates, and numbers
- open questions and blockers
- anything a named participant was asked to follow up on

Drop small talk, greetings, and detail that has been superseded.

Format: 4-8 short bullet lines, each starting with "- ". Attribute with names where the transcript gives them. No headings, no preamble, no markdown beyond the leading hyphen. Stay under 180 words.`;

export class SummaryWorker {
  /**
   * @param {object} opts
   * @param {() => object} opts.getProfile
   * @param {(summary: string) => void} opts.onSummary
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor({ getProfile, onSummary, onError }) {
    this.getProfile = getProfile;
    this.onSummary = onSummary;
    this.onError = onError ?? (() => {});

    this.summary = '';
    this.pending = [];
    this.pendingChars = 0;
    this.lastRunAt = 0;
    this.controller = null;
    this.timer = null;
  }

  reset() {
    this.abort();
    this.summary = '';
    this.pending = [];
    this.pendingChars = 0;
    this.lastRunAt = Date.now();
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Feed a finalized, speaker-attributed transcript line. */
  add(line) {
    if (!line) return;
    this.pending.push(line);
    this.pendingChars += line.length;
    this._maybeRun();
  }

  /**
   * Abort any in-flight summary. Called before every notes request — the
   * summary must never sit in front of an alert in the network queue.
   */
  abort() {
    this.controller?.abort();
    this.controller = null;
  }

  _maybeRun() {
    if (this.controller) return; // already running
    const elapsed = Date.now() - this.lastRunAt;
    const due =
      this.pendingChars >= TUNING.SUMMARY_CHAR_THRESHOLD ||
      (elapsed >= TUNING.SUMMARY_INTERVAL_MS && this.pendingChars > 0);
    if (!due) {
      this._scheduleCheck();
      return;
    }
    this._run();
  }

  _scheduleCheck() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pendingChars > 0) this._maybeRun();
    }, TUNING.SUMMARY_INTERVAL_MS);
  }

  async _run() {
    const profile = this.getProfile();
    if (!profile?.openai?.apiKey) return;

    const chunk = this.pending.join('\n');
    this.pending = [];
    this.pendingChars = 0;
    this.lastRunAt = Date.now();

    this.controller = new AbortController();
    const { signal } = this.controller;

    const messages = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          `PREVIOUS SUMMARY:\n${this.summary || '(none yet — this is the start of the meeting)'}`,
          '',
          `NEW TRANSCRIPT:\n${chunk}`,
        ].join('\n'),
      },
    ];

    let out = '';
    try {
      for await (const delta of streamChat({
        apiKey: profile.openai.apiKey,
        model: profile.openai.summaryModel,
        messages,
        maxTokens: 400,
        signal,
      })) {
        out += delta;
      }

      const trimmed = out.trim();
      if (trimmed) {
        this.summary = trimmed;
        this.onSummary(this.summary);
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        // Pre-empted by a trigger. Put the work back so the next pass covers it.
        this.pending.unshift(chunk);
        this.pendingChars += chunk.length;
      } else {
        this.onError(err);
      }
    } finally {
      this.controller = null;
      if (this.pendingChars > 0) this._scheduleCheck();
    }
  }
}

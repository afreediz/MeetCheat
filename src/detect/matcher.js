/**
 * Local trigger matching — the 0ms tier.
 *
 * Runs on *interim* transcript tokens, not finalized ones, so the alert fires
 * while the sentence is still being spoken. Everything here is pure local
 * computation: no network, no await, no allocation-heavy work in the hot path.
 *
 * Three scoring strategies, best-of:
 *   1. exact normalized match        -> 1.0
 *   2. double-metaphone code match   -> 0.9   ("a lena" ~ "Aleena")
 *   3. bounded Levenshtein similarity -> the similarity itself
 */

import { doubleMetaphone } from './metaphone.js';
import { TRIGGER_KIND, TUNING } from '../lib/constants.js';

const PHONETIC_SCORE = 0.9;

/**
 * Aliases shorter than this only ever match exactly. Fuzzy-matching a
 * two-letter alias like "AF" against live speech is all false positives.
 */
const MIN_FUZZY_ALIAS_LEN = 4;

/** Only the last N tokens of a growing interim buffer are worth rescanning. */
const TAIL_TOKENS = 40;

const INTERROGATIVES = new Set([
  'what', 'why', 'how', 'when', 'where', 'who', 'whom', 'whose', 'which',
  'can', 'could', 'would', 'will', 'should', 'shall', 'do', 'does', 'did',
  'is', 'are', 'was', 'were', 'have', 'has', 'any', 'anything',
]);

/** Imperative / solicitation cues that make a mention an ask without a "?". */
const SOLICITATIONS = new Set([
  'thoughts', 'update', 'status', 'timeline', 'estimate', 'eta',
  'walk', 'tell', 'share', 'explain', 'take', 'give', 'show', 'confirm',
  'clarify', 'comment', 'weigh', 'chime', 'speak', 'cover', 'run',
]);

/** Words that must never carry a fuzzy match on their own. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'it', 'to', 'of', 'in', 'on',
  'at', 'for', 'we', 'i', 'you', 'he', 'she', 'they', 'that', 'this', 'so',
  'as', 'be', 'do', 'if', 'my', 'me', 'us', 'our', 'was', 'are', 'not',
]);

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    // Drop apostrophes rather than splitting on them, so possessives like
    // "aleena's" collapse to "aleenas" and still match.
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text) {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

/**
 * Levenshtein distance with an early-exit ceiling. Returns `max + 1` as soon as
 * every cell in a row exceeds the ceiling, so hopeless pairs bail immediately.
 */
export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

export function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 0;
  // Only distances that could still clear a 0.5 similarity are worth computing.
  const ceiling = Math.floor(longest * 0.5);
  const dist = levenshtein(a, b, ceiling);
  return 1 - dist / longest;
}

/**
 * Precompile the profile's trigger set into the shape the hot path wants:
 * normalized forms and metaphone codes computed once, not per scan.
 */
function compile(triggerSet) {
  return triggerSet.map((t) => {
    const spaced = normalize(t.alias);
    const joined = spaced.replace(/\s/g, '');
    const [primary, alternate] = doubleMetaphone(joined);
    return {
      kind: t.kind,
      label: t.label,
      alias: t.alias,
      spaced,
      joined,
      primary,
      alternate,
      tokenCount: spaced ? spaced.split(' ').length : 0,
      fuzzyEligible: joined.length >= MIN_FUZZY_ALIAS_LEN,
    };
  }).filter((t) => t.joined.length >= 2);
}

export class Matcher {
  /**
   * @param {Array<{kind:string,label:string,alias:string}>} triggerSet
   * @param {{sensitivity?: number, cooldownMs?: number}} [opts]
   */
  constructor(triggerSet, opts = {}) {
    this.entries = compile(triggerSet);
    this.sensitivity = opts.sensitivity ?? TUNING.DEFAULT_SENSITIVITY;
    this.cooldownMs = opts.cooldownMs ?? TUNING.TRIGGER_COOLDOWN_MS;
    /** @type {Map<string, number>} key -> last fire timestamp */
    this.lastFired = new Map();
    this.maxWindow = Math.min(
      TUNING.MATCH_WINDOW_MAX_TOKENS,
      Math.max(1, ...this.entries.map((e) => e.tokenCount), 1),
    );
  }

  /** Wipe cooldown state — call when a new meeting starts. */
  reset() {
    this.lastFired.clear();
  }

  /**
   * Scan a chunk of transcript for triggers.
   *
   * @param {string} text raw transcript text (interim is fine and preferred)
   * @param {{now?: number, ignoreCooldown?: boolean}} [opts]
   * @returns {Array<object>} triggers that cleared threshold and cooldown
   */
  scan(text, opts = {}) {
    const now = opts.now ?? Date.now();
    const tokens = tokenize(text);
    if (!tokens.length || !this.entries.length) return [];

    const tail = tokens.length > TAIL_TOKENS ? tokens.slice(-TAIL_TOKENS) : tokens;

    // best match per entry key, so one utterance can't fire the same alias twice
    /** @type {Map<string, object>} */
    const best = new Map();

    for (let width = 1; width <= this.maxWindow; width++) {
      for (let start = 0; start + width <= tail.length; start++) {
        const windowTokens = tail.slice(start, start + width);

        // A window made only of stopwords can't be a name, and letting it
        // through is how "and the" ends up fuzzy-matching a short project name.
        if (windowTokens.every((t) => STOPWORDS.has(t))) continue;

        const spaced = windowTokens.join(' ');
        const joined = windowTokens.join('');
        const [wPrimary, wAlternate] = doubleMetaphone(joined);

        for (const entry of this.entries) {
          const score = this._score(entry, spaced, joined, wPrimary, wAlternate);
          if (score < this.sensitivity) continue;

          const key = `${entry.kind}:${entry.label}`;
          const existing = best.get(key);
          if (existing && existing.score >= score) continue;

          best.set(key, {
            kind: entry.kind,
            label: entry.label,
            matchedAlias: entry.alias,
            matchedText: spaced,
            score,
            tokenIndex: start,
            key,
          });
        }
      }
    }

    const out = [];
    for (const trigger of best.values()) {
      if (!opts.ignoreCooldown) {
        const last = this.lastFired.get(trigger.key) ?? -Infinity;
        if (now - last < this.cooldownMs) continue;
        this.lastFired.set(trigger.key, now);
      }
      trigger.directedQuestion =
        trigger.kind === TRIGGER_KIND.NAME &&
        isQuestionNear(text, tail, trigger.tokenIndex);
      out.push(trigger);
    }

    // Strongest match first — the panel headlines with out[0].
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  _score(entry, spaced, joined, wPrimary, wAlternate) {
    if (spaced === entry.spaced || joined === entry.joined) return 1.0;
    if (!entry.fuzzyEligible || joined.length < MIN_FUZZY_ALIAS_LEN) return 0;

    if (
      (wPrimary && (wPrimary === entry.primary || wPrimary === entry.alternate)) ||
      (wAlternate && (wAlternate === entry.primary || wAlternate === entry.alternate))
    ) {
      return PHONETIC_SCORE;
    }

    return similarity(joined, entry.joined);
  }
}

/**
 * Decide whether a mention is a question aimed at the user, rather than an
 * incidental reference. This gates the expensive LLM call.
 */
export function isQuestionNear(rawText, tokens, tokenIndex) {
  if (String(rawText ?? '').includes('?')) return true;

  const radius = TUNING.QUESTION_PROXIMITY_TOKENS;
  const from = Math.max(0, tokenIndex - radius);
  const to = Math.min(tokens.length, tokenIndex + radius + 1);

  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (INTERROGATIVES.has(t) || SOLICITATIONS.has(t)) return true;
  }
  return false;
}

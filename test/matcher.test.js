/**
 * Fixture-driven matcher tests.
 *
 * The positives are real speech-to-text manglings of proper nouns — this is the
 * failure mode the whole phonetic layer exists to survive. The negatives matter
 * just as much: a matcher that fires on ordinary meeting chatter is worse than
 * no matcher, because the user learns to ignore the alert.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Matcher, normalize, tokenize, similarity, isQuestionNear } from '../src/detect/matcher.js';
import { doubleMetaphone, phoneticallyEqual } from '../src/detect/metaphone.js';
import { TRIGGER_KIND } from '../src/lib/constants.js';

const TRIGGERS = [
  { kind: TRIGGER_KIND.NAME, label: 'Aleena', alias: 'Aleena' },
  { kind: TRIGGER_KIND.PROJECT, label: 'Helios', alias: 'Helios' },
  { kind: TRIGGER_KIND.PROJECT, label: 'Helios', alias: 'the payments rewrite' },
  { kind: TRIGGER_KIND.PERSON, label: 'Sarah Chen', alias: 'Sarah Chen' },
  { kind: TRIGGER_KIND.PERSON, label: 'Sarah Chen', alias: 'Sarah' },
];

/** Fresh matcher per test so cooldown state never leaks between cases. */
function makeMatcher(opts = {}) {
  return new Matcher(TRIGGERS, { sensitivity: 0.82, ...opts });
}

// --- normalization ---------------------------------------------------------

test('normalize lowercases, strips punctuation, collapses whitespace', () => {
  assert.equal(normalize('  Hey,  Aleena!!  '), 'hey aleena');
});

test('normalize folds possessives so "Aleena\'s" still matches', () => {
  assert.equal(normalize("Aleena's"), 'aleenas');
  assert.equal(normalize('Aleena’s'), 'aleenas');
});

test('tokenize returns empty array for empty input', () => {
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize(null), []);
});

// --- metaphone -------------------------------------------------------------

test('doubleMetaphone returns two codes and is stable', () => {
  const [p, a] = doubleMetaphone('Aleena');
  assert.ok(p.length > 0);
  assert.deepEqual(doubleMetaphone('Aleena'), [p, a]);
});

test('doubleMetaphone ignores case and non-letters', () => {
  assert.deepEqual(doubleMetaphone('aleena'), doubleMetaphone("A-Leena!"));
});

test('phoneticallyEqual rejects empty input rather than matching everything', () => {
  assert.equal(phoneticallyEqual('', 'aleena'), false);
  assert.equal(phoneticallyEqual('123', 'aleena'), false);
});

// --- similarity ------------------------------------------------------------

test('similarity is 1 for identical strings and 0 for empty', () => {
  assert.equal(similarity('helios', 'helios'), 1);
  assert.equal(similarity('', ''), 0);
});

test('similarity is symmetric', () => {
  assert.equal(similarity('helios', 'heelius'), similarity('heelius', 'helios'));
});

// --- positive matches: real STT manglings ----------------------------------

const POSITIVES = [
  // [spoken transcript, expected label]
  ['so a lena can you walk us through the gateway', 'Aleena'],
  ['elena what do you think', 'Aleena'],
  ['hey aleenah quick question', 'Aleena'],
  ['i think a lina owns that piece', 'Aleena'],
  ['where are we on helios', 'Helios'],
  ['the heelius migration is blocked', 'Helios'],
  ['hell ios is behind schedule', 'Helios'],
  ['how is the payments rewrite going', 'Helios'],
  ['sarah chen flagged the compliance review', 'Sarah Chen'],
  ['sara raised it last week', 'Sarah Chen'],
];

for (const [utterance, expected] of POSITIVES) {
  test(`fires on "${utterance}" -> ${expected}`, () => {
    const m = makeMatcher();
    const hits = m.scan(utterance);
    const labels = hits.map((h) => h.label);
    assert.ok(
      labels.includes(expected),
      `expected ${expected} in [${labels.join(', ') || 'no matches'}]`,
    );
  });
}

test('a genuinely different name is rejected, and the alias field is the fix', () => {
  // "Amira" is a real, distinct name — phonetically AMR vs ALN. Matching it
  // would mean dropping sensitivity far enough to fire on ordinary chatter, so
  // the matcher correctly stays quiet. When a user hears a mangling this far
  // off in their own transcripts, adding it as an alias is the intended fix.
  const strict = makeMatcher();
  assert.deepEqual(strict.scan('i think amira owns that piece'), []);

  const withAlias = new Matcher(
    [...TRIGGERS, { kind: TRIGGER_KIND.NAME, label: 'Aleena', alias: 'Amira' }],
    { sensitivity: 0.82 },
  );
  assert.deepEqual(
    withAlias.scan('i think amira owns that piece').map((h) => h.label),
    ['Aleena'],
  );
});

// --- negative matches: ordinary meeting chatter ----------------------------

const NEGATIVES = [
  'can everyone hear me okay',
  'lets go ahead and start the recording',
  'i will follow up on that after the call',
  'the deploy went out friday afternoon',
  'we should probably take this offline',
  'sounds good to me thanks everyone',
  'any other business before we wrap',
  'my calendar is completely full tomorrow',
];

for (const utterance of NEGATIVES) {
  test(`stays quiet on "${utterance}"`, () => {
    const m = makeMatcher();
    const hits = m.scan(utterance);
    assert.deepEqual(
      hits.map((h) => `${h.label}(${h.score.toFixed(2)} via "${h.matchedText}")`),
      [],
    );
  });
}

// --- cooldown --------------------------------------------------------------

test('cooldown suppresses a repeat of the same alias', () => {
  const m = makeMatcher({ cooldownMs: 20000 });
  const t0 = 1_000_000;
  assert.equal(m.scan('aleena are you there', { now: t0 }).length, 1);
  assert.equal(m.scan('aleena again', { now: t0 + 5000 }).length, 0);
});

test('cooldown expires and lets the alias fire again', () => {
  const m = makeMatcher({ cooldownMs: 20000 });
  const t0 = 1_000_000;
  assert.equal(m.scan('aleena are you there', { now: t0 }).length, 1);
  assert.equal(m.scan('aleena one more time', { now: t0 + 20001 }).length, 1);
});

test('cooldown is per-alias, so a different trigger still fires', () => {
  const m = makeMatcher({ cooldownMs: 20000 });
  const t0 = 1_000_000;
  m.scan('aleena are you there', { now: t0 });
  const hits = m.scan('what about helios', { now: t0 + 1000 });
  assert.deepEqual(hits.map((h) => h.label), ['Helios']);
});

test('reset clears cooldown state for a new meeting', () => {
  const m = makeMatcher({ cooldownMs: 20000 });
  const t0 = 1_000_000;
  m.scan('aleena are you there', { now: t0 });
  m.reset();
  assert.equal(m.scan('aleena are you there', { now: t0 + 100 }).length, 1);
});

test('one utterance mentioning an alias twice fires once', () => {
  const m = makeMatcher();
  const hits = m.scan('aleena i mean aleena can you confirm');
  assert.equal(hits.filter((h) => h.label === 'Aleena').length, 1);
});

// --- directed-question detection -------------------------------------------

test('flags a name mention with a question mark as directed', () => {
  const m = makeMatcher();
  const [hit] = m.scan('Aleena, can you walk us through the gateway?');
  assert.equal(hit.directedQuestion, true);
});

test('flags a name mention with an interrogative but no "?" as directed', () => {
  const m = makeMatcher();
  const [hit] = m.scan('so a lena what is the timeline on that');
  assert.equal(hit.directedQuestion, true);
});

test('flags a solicitation without an interrogative as directed', () => {
  const m = makeMatcher();
  const [hit] = m.scan('aleena walk us through the cutover please');
  assert.equal(hit.directedQuestion, true);
});

test('does not flag an incidental name mention as directed', () => {
  const m = makeMatcher();
  const [hit] = m.scan('aleena already shipped that last sprint');
  assert.equal(hit.directedQuestion, false);
});

test('project mentions are never marked as directed questions', () => {
  const m = makeMatcher();
  const [hit] = m.scan('what is the status of helios');
  assert.equal(hit.kind, TRIGGER_KIND.PROJECT);
  assert.equal(hit.directedQuestion, false);
});

test('isQuestionNear ignores cues beyond the proximity window', () => {
  const tokens = ['what', ...Array(30).fill('filler'), 'aleena'];
  assert.equal(isQuestionNear('', tokens, tokens.length - 1), false);
});

// --- ranking and shape -----------------------------------------------------

test('returns strongest match first', () => {
  const m = makeMatcher();
  const hits = m.scan('aleena can you cover heelius');
  assert.ok(hits.length >= 2);
  assert.ok(hits[0].score >= hits[1].score);
});

test('trigger carries the fields the panel and prompt need', () => {
  const m = makeMatcher();
  const [hit] = m.scan('aleena are you there');
  assert.equal(hit.kind, TRIGGER_KIND.NAME);
  assert.equal(hit.label, 'Aleena');
  assert.equal(typeof hit.matchedAlias, 'string');
  assert.equal(typeof hit.matchedText, 'string');
  assert.ok(hit.score > 0 && hit.score <= 1);
});

// --- robustness ------------------------------------------------------------

test('empty and whitespace input produce no triggers', () => {
  const m = makeMatcher();
  assert.deepEqual(m.scan(''), []);
  assert.deepEqual(m.scan('   '), []);
  assert.deepEqual(m.scan(null), []);
});

test('a matcher with no triggers never fires', () => {
  const m = new Matcher([]);
  assert.deepEqual(m.scan('aleena helios sarah chen'), []);
});

test('two-letter aliases only match exactly, never fuzzily', () => {
  const m = new Matcher([{ kind: TRIGGER_KIND.NAME, label: 'AL', alias: 'AL' }]);
  assert.equal(m.scan('al can you confirm').length, 1);
  m.reset();
  assert.equal(m.scan('of course we can').length, 0);
});

test('scanning a long buffer stays bounded and still catches a tail mention', () => {
  const m = makeMatcher();
  const filler = Array(300).fill('filler').join(' ');
  const hits = m.scan(`${filler} aleena can you confirm`);
  assert.deepEqual(hits.map((h) => h.label), ['Aleena']);
});

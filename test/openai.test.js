/**
 * Partial-JSON reader tests.
 *
 * Incremental rendering depends entirely on this: a normal JSON.parse can't
 * run until the closing brace arrives, which would mean the user stares at an
 * empty panel until the whole response lands. This scan has to cope with a
 * buffer cut at any byte — including mid-escape and mid-\\uXXXX.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPartialStringFields } from '../src/llm/openai.js';

const FIELDS = ['ask', 'context'];

test('reads both fields from a complete document', () => {
  const buf = '{"ask":"What is the timeline?","context":"QA slips to the 14th"}';
  const out = readPartialStringFields(buf, FIELDS);
  assert.equal(out.ask.value, 'What is the timeline?');
  assert.equal(out.ask.complete, true);
  assert.equal(out.context.value, 'QA slips to the 14th');
  assert.equal(out.context.complete, true);
});

test('returns a growing prefix while the first field is still streaming', () => {
  const out = readPartialStringFields('{"ask":"What is the time', FIELDS);
  assert.equal(out.ask.value, 'What is the time');
  assert.equal(out.ask.complete, false);
  assert.equal(out.context.value, '');
});

test('marks the first field complete while the second is still open', () => {
  const out = readPartialStringFields('{"ask":"Done?","context":"partial', FIELDS);
  assert.equal(out.ask.complete, true);
  assert.equal(out.context.value, 'partial');
  assert.equal(out.context.complete, false);
});

test('handles an absent field without throwing', () => {
  const out = readPartialStringFields('{"ask":"x"}', FIELDS);
  assert.equal(out.context.value, '');
  assert.equal(out.context.complete, false);
});

test('handles empty and malformed buffers', () => {
  for (const buf of ['', '{', '{"as', 'not json at all', '{"ask"']) {
    const out = readPartialStringFields(buf, FIELDS);
    assert.equal(out.ask.value, '');
    assert.equal(out.context.value, '');
  }
});

test('unescapes quotes, backslashes and newlines', () => {
  const buf = String.raw`{"ask":"She said \"ship it\" — path C:\\tmp\nnext line"}`;
  const out = readPartialStringFields(buf, FIELDS);
  assert.equal(out.ask.value, 'She said "ship it" — path C:\\tmp\nnext line');
  assert.equal(out.ask.complete, true);
});

test('an escaped quote does not terminate the string early', () => {
  const out = readPartialStringFields('{"ask":"a \\" b","context":"c"}', FIELDS);
  assert.equal(out.ask.value, 'a " b');
  assert.equal(out.context.value, 'c');
});

test('a buffer cut mid-escape does not emit a stray backslash', () => {
  const out = readPartialStringFields('{"ask":"ends with \\', FIELDS);
  assert.equal(out.ask.value, 'ends with ');
  assert.equal(out.ask.complete, false);
});

test('decodes \\uXXXX escapes', () => {
  const out = readPartialStringFields('{"ask":"caf\\u00e9 review"}', FIELDS);
  assert.equal(out.ask.value, 'café review');
});

test('a truncated \\uXXXX escape does not corrupt the prefix', () => {
  const out = readPartialStringFields('{"ask":"caf\\u00', FIELDS);
  assert.equal(out.ask.value, 'caf');
  assert.equal(out.ask.complete, false);
});

test('tolerates whitespace around the colon', () => {
  const out = readPartialStringFields('{\n  "ask"  :   "spaced out"\n}', FIELDS);
  assert.equal(out.ask.value, 'spaced out');
  assert.equal(out.ask.complete, true);
});

test('handles an empty string value', () => {
  const out = readPartialStringFields('{"ask":"","context":"only this"}', FIELDS);
  assert.equal(out.ask.value, '');
  assert.equal(out.ask.complete, true);
  assert.equal(out.context.value, 'only this');
});

test('byte-by-byte replay never regresses and ends correct', () => {
  const full = '{"ask":"Sarah wants the cutover date","context":"QA slips; compliance blocks"}';
  let prevAsk = '';
  let prevContext = '';

  for (let i = 1; i <= full.length; i++) {
    const out = readPartialStringFields(full.slice(0, i), FIELDS);
    // Values only ever grow — a shrinking note would visibly flicker.
    assert.ok(
      out.ask.value.startsWith(prevAsk) || prevAsk.startsWith(out.ask.value),
      `ask regressed at byte ${i}: "${prevAsk}" -> "${out.ask.value}"`,
    );
    assert.ok(
      out.context.value.startsWith(prevContext) || prevContext.startsWith(out.context.value),
      `context regressed at byte ${i}`,
    );
    prevAsk = out.ask.value;
    prevContext = out.context.value;
  }

  const final = readPartialStringFields(full, FIELDS);
  assert.equal(final.ask.value, 'Sarah wants the cutover date');
  assert.equal(final.context.value, 'QA slips; compliance blocks');
  assert.deepEqual(JSON.parse(full), {
    ask: final.ask.value,
    context: final.context.value,
  });
});

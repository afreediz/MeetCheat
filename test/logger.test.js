/**
 * Logger tests.
 *
 * Redaction is the one that matters most. The log view has a Copy button whose
 * whole purpose is pasting output somewhere else — a leaked API key here goes
 * straight into a bug report or a chat window.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The logger calls chrome.runtime.sendMessage in its default sink.
globalThis.chrome = {
  runtime: {
    sendMessage: () => ({ catch: () => {} }),
  },
};

const {
  createLogger,
  setLogSink,
  setLogLevel,
  redact,
  formatEntry,
  LEVELS,
  CONTEXTS,
} = await import('../src/lib/logger.js');

let captured = [];

beforeEach(() => {
  captured = [];
  setLogSink((entry) => captured.push(entry));
  setLogLevel('debug');
});

// --- redaction -------------------------------------------------------------

test('masks a value under an apiKey field', () => {
  const out = redact({ apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz' });
  assert.doesNotMatch(out.apiKey, /abcdefghij/);
  assert.match(out.apiKey, /chars\)$/);
});

test('masks every credential-shaped field name', () => {
  const out = redact({
    api_key: 'secret-value-here',
    token: 'secret-value-here',
    Authorization: 'Bearer abc123def456',
    password: 'hunter2hunter2',
    secret: 'shhhhhhhhhhhh',
  });
  for (const [k, v] of Object.entries(out)) {
    assert.doesNotMatch(String(v), /secret-value-here|abc123def456|hunter2/, `${k} leaked`);
  }
});

test('masks a bare sk- key even when the field name is innocuous', () => {
  // The realtime client logs config objects; a key could land under any name.
  const out = redact({ note: 'sk-proj-AAAABBBBCCCCDDDDEEEE' });
  assert.doesNotMatch(out.note, /AAAABBBB/);
});

test('masks keys nested inside objects and arrays', () => {
  const out = redact({
    cfg: { openai: { apiKey: 'sk-proj-DEEPLYNESTEDKEY123456' } },
    list: [{ token: 'another-secret-token' }],
  });
  const dumped = JSON.stringify(out);
  assert.doesNotMatch(dumped, /DEEPLYNESTED/);
  assert.doesNotMatch(dumped, /another-secret-token/);
});

test('leaves ordinary values untouched', () => {
  const out = redact({ model: 'gpt-4.1-mini', chunks: 42, ok: true, name: 'Afreedi' });
  assert.deepEqual(out, { model: 'gpt-4.1-mini', chunks: 42, ok: true, name: 'Afreedi' });
});

test('redaction survives null, undefined and primitives', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(7), 7);
  assert.equal(redact('plain'), 'plain');
});

test('an api key never survives a full log round trip', () => {
  const log = createLogger(CONTEXTS.SW);
  log.info('startCapture', { apiKey: 'sk-proj-REALKEYMATERIAL0123456789' });
  const line = formatEntry(captured[0]);
  assert.doesNotMatch(line, /REALKEYMATERIAL/);
});

// --- levels ----------------------------------------------------------------

test('level filtering suppresses entries below the threshold', () => {
  setLogLevel('warn');
  const log = createLogger(CONTEXTS.SW);
  log.debug('nope');
  log.info('nope');
  log.warn('yes');
  log.error('yes');
  assert.deepEqual(captured.map((e) => e.level), ['warn', 'error']);
});

test('debug level lets everything through', () => {
  setLogLevel('debug');
  const log = createLogger(CONTEXTS.SW);
  log.debug('a');
  log.error('b');
  assert.equal(captured.length, 2);
});

test('levels are ordered as expected', () => {
  assert.ok(LEVELS.debug < LEVELS.info);
  assert.ok(LEVELS.info < LEVELS.warn);
  assert.ok(LEVELS.warn < LEVELS.error);
});

// --- entry shape -----------------------------------------------------------

test('entries carry context, level, message and a unique id', () => {
  const log = createLogger(CONTEXTS.OFFSCREEN);
  log.info('hello', { a: 1 });
  log.info('hello again');
  const [first, second] = captured;
  assert.equal(first.ctx, 'audio');
  assert.equal(first.level, 'info');
  assert.equal(first.msg, 'hello');
  assert.deepEqual(first.data, { a: 1 });
  assert.ok(typeof first.t === 'number');
  assert.notEqual(first.id, second.id, 'ids must be unique for keyed rendering');
});

test('entries are structured-cloneable for chrome.runtime.sendMessage', () => {
  const log = createLogger(CONTEXTS.SW);
  log.info('with a function in the payload', { fn: () => {}, ok: 1 });
  // JSON round trip stands in for structured clone; a raw function would be
  // dropped by JSON and would throw under structuredClone.
  const entry = captured[0];
  assert.doesNotThrow(() => structuredClone(entry));
  assert.equal(entry.data.fn, '(fn)');
});

// --- clipping --------------------------------------------------------------

test('long strings are clipped so a transcript cannot bloat the ring', () => {
  const log = createLogger(CONTEXTS.SW);
  log.info('big', { text: 'x'.repeat(5000) });
  const { text } = captured[0].data;
  assert.ok(text.length < 400, `clipped to ${text.length}`);
  assert.match(text, /\(\+\d+\)$/);
});

test('long arrays are clipped with a remainder marker', () => {
  const log = createLogger(CONTEXTS.SW);
  log.info('many', { items: Array.from({ length: 100 }, (_, i) => i) });
  const { items } = captured[0].data;
  assert.ok(items.length <= 21);
  assert.match(String(items.at(-1)), /more$/);
});

// --- throttling ------------------------------------------------------------

test('throttle admits the first call and suppresses the rest in the window', () => {
  const log = createLogger(CONTEXTS.SW);
  assert.equal(log.throttle('k', 10_000, 'debug', 'first'), true);
  assert.equal(log.throttle('k', 10_000, 'debug', 'second'), false);
  assert.equal(log.throttle('k', 10_000, 'debug', 'third'), false);
  assert.deepEqual(captured.map((e) => e.msg), ['first']);
});

test('throttle keys are independent', () => {
  const log = createLogger(CONTEXTS.SW);
  log.throttle('remote', 10_000, 'debug', 'a');
  log.throttle('self', 10_000, 'debug', 'b');
  assert.equal(captured.length, 2);
});

test('throttle state is per logger instance', () => {
  const a = createLogger(CONTEXTS.SW);
  const b = createLogger(CONTEXTS.OFFSCREEN);
  a.throttle('k', 10_000, 'info', 'from a');
  b.throttle('k', 10_000, 'info', 'from b');
  assert.equal(captured.length, 2);
});

// --- timers ----------------------------------------------------------------

test('timer logs elapsed ms and returns it', () => {
  const log = createLogger(CONTEXTS.SW);
  const done = log.timer('thing');
  const ms = done({ extra: true });
  assert.equal(typeof ms, 'number');
  assert.match(captured[0].msg, /^thing \(\d+ms\)$/);
  assert.equal(captured[0].data.extra, true);
  assert.equal(typeof captured[0].data.ms, 'number');
});

// --- formatting ------------------------------------------------------------

test('formatEntry produces one greppable line', () => {
  const line = formatEntry({
    t: Date.UTC(2026, 0, 2, 3, 4, 5, 678),
    ctx: 'stt',
    level: 'warn',
    msg: 'socket closed',
    data: { code: 1006 },
  });
  assert.equal(line, '03:04:05.678 [stt] WARN socket closed {"code":1006}');
});

test('formatEntry omits the data section when there is none', () => {
  const line = formatEntry({ t: Date.now(), ctx: 'sw', level: 'info', msg: 'ready' });
  assert.match(line, /INFO ready$/);
});

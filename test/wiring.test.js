/**
 * Wiring integrity.
 *
 * There is no bundler here, so nothing catches a bad import path or a manifest
 * entry pointing at a file that moved — Chrome just fails silently at load and
 * the extension does nothing. These checks run in CI-time instead.
 *
 * The content-script constant check is the important one: manifest-declared
 * content scripts cannot be ES modules, so src/content.js has to inline its
 * message types. That duplication is the kind that drifts and then breaks
 * speaker attribution with no error anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Source with comments removed. Needed for "this pattern must not appear"
 * checks — otherwise a comment *explaining* a footgun trips the guard against
 * that footgun.
 */
const readCode = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const manifest = JSON.parse(read('manifest.json'));

async function jsFiles(dir = 'src') {
  const out = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await jsFiles(rel)));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// --- manifest --------------------------------------------------------------

test('manifest is MV3 and declares a module service worker', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
});

test('every file path in the manifest exists', () => {
  const paths = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources),
  ];
  for (const p of paths) {
    assert.ok(existsSync(join(ROOT, p)), `manifest references missing file: ${p}`);
  }
});

test('permissions cover every chrome API the code calls', () => {
  const declared = new Set(manifest.permissions);
  const needed = ['activeTab', 'tabCapture', 'offscreen', 'sidePanel', 'storage'];
  for (const p of needed) {
    assert.ok(declared.has(p), `missing permission: ${p}`);
  }
});

test('openPanelOnActionClick is never enabled', () => {
  // Regression guard. Setting this true makes Chrome handle the toolbar click
  // itself, so `chrome.action.onClicked` never fires and capture never starts
  // — the panel opens and sits on "Not listening yet" forever. The setting is
  // also persisted per profile, so it must be explicitly set false, not just
  // left unset.
  const code = readCode('src/service-worker.js');
  assert.doesNotMatch(
    code,
    /openPanelOnActionClick:\s*true/,
    'openPanelOnActionClick: true silently disables action.onClicked',
  );
  assert.match(
    code,
    /setPanelBehavior\(\{\s*openPanelOnActionClick:\s*false\s*\}\)/,
    'must explicitly set openPanelOnActionClick:false to undo a previously-enabled profile',
  );
});

test('the action click path reaches startSession', () => {
  const src = read('src/service-worker.js');
  assert.match(src, /chrome\.action\.onClicked\.addListener/);
  assert.match(src, /function toggleSession/);
  assert.match(src, /await startSession\(/);
});

test('the panel start button is wired end to end', () => {
  assert.match(read('src/sidepanel/sidepanel.html'), /id="start"/);
  assert.match(read('src/sidepanel/sidepanel.js'), /type:\s*'panel:start'/);
  assert.match(read('src/service-worker.js'), /'panel:start'/);
});

test('host permissions cover Meet and the OpenAI API', () => {
  const hosts = manifest.host_permissions.join(' ');
  assert.match(hosts, /meet\.google\.com/);
  assert.match(hosts, /api\.openai\.com/);
});

test('the offscreen document path in constants matches a real file', () => {
  const constants = read('src/lib/constants.js');
  const [, path] = constants.match(/OFFSCREEN_PATH\s*=\s*'([^']+)'/) ?? [];
  assert.ok(path, 'OFFSCREEN_PATH not found in constants.js');
  assert.ok(existsSync(join(ROOT, path)), `OFFSCREEN_PATH points at a missing file: ${path}`);
});

// --- imports ---------------------------------------------------------------

test('every relative import resolves to a real file', async () => {
  const files = await jsFiles();
  const problems = [];

  for (const file of files) {
    const src = read(file);
    const importRe = /(?:^|\n)\s*import\s+[^'"]*from\s+['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const target = resolve(dirname(join(ROOT, file)), m[1]);
      if (!existsSync(target)) {
        problems.push(`${file} -> ${m[1]}`);
      }
    }
  }

  assert.deepEqual(problems, [], `unresolved imports:\n${problems.join('\n')}`);
});

test('the content script has no ES imports', () => {
  // Manifest-declared content scripts are not modules; an import here throws
  // at parse time and the script silently never runs.
  const src = read('src/content.js');
  assert.doesNotMatch(
    src,
    /(?:^|\n)\s*import\s+.*\s+from\s+['"]/,
    'content.js must not use ES module imports',
  );
});

test('the AudioWorklet has no ES imports', () => {
  // AudioWorkletGlobalScope does not support module imports either.
  const src = read('src/audio/pcm-worklet.js');
  assert.doesNotMatch(src, /(?:^|\n)\s*import\s+.*\s+from\s+['"]/);
});

// --- the duplicated constants ---------------------------------------------

test('inlined MSG values in content.js match constants.js exactly', async () => {
  const { MSG } = await import('../src/lib/constants.js');
  const contentSrc = read('src/content.js');

  const block = contentSrc.match(/const MSG = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not find the inlined MSG block in content.js');

  const inlined = {};
  for (const [, key, value] of block[1].matchAll(/(\w+):\s*'([^']+)'/g)) {
    inlined[key] = value;
  }

  assert.ok(Object.keys(inlined).length > 0, 'inlined MSG block parsed as empty');

  for (const [key, value] of Object.entries(inlined)) {
    assert.equal(
      value,
      MSG[key],
      `content.js MSG.${key} is "${value}" but constants.js says "${MSG[key]}"`,
    );
  }
});

test('content.js only sends message types it declares', () => {
  const src = read('src/content.js');
  const declared = new Set(
    [...(src.match(/const MSG = \{([\s\S]*?)\n\};/)?.[1] ?? '').matchAll(/(\w+):/g)].map(
      (m) => m[1],
    ),
  );
  for (const [, used] of src.matchAll(/send\(MSG\.(\w+)/g)) {
    assert.ok(declared.has(used), `content.js sends MSG.${used} but never declares it`);
  }
});

// --- logging ---------------------------------------------------------------

test('every log context has a colour class in the panel stylesheet', async () => {
  const { CONTEXTS } = await import('../src/lib/logger.js');
  const css = read('src/sidepanel/sidepanel.css');
  for (const ctx of Object.values(CONTEXTS)) {
    assert.match(
      css,
      new RegExp(`\\.lc\\.${ctx}\\b`),
      `no .lc.${ctx} rule — that context renders uncoloured in the log view`,
    );
  }
});

test('the content script inlines a logger that forwards to the worker', () => {
  const src = read('src/content.js');
  assert.match(src, /LOG:\s*'log:entry'/, 'content.js must declare the LOG message type');
  assert.match(src, /type:\s*MSG\.LOG/, 'content.js must forward log entries');
});

test('every context that logs actually creates a logger', () => {
  const wired = [
    'src/service-worker.js',
    'src/offscreen/offscreen.js',
    'src/realtime-client.js',
  ];
  for (const file of wired) {
    assert.match(read(file), /createLogger\(/, `${file} has no logger`);
  }
});

test('the service worker overrides the log sink instead of forwarding to itself', () => {
  // Forwarding via sendMessage from the worker would loop back into its own
  // onMessage handler and re-broadcast forever.
  const code = readCode('src/service-worker.js');
  assert.match(code, /setLogSink\(/);
});

test('the panel log view is wired end to end', () => {
  const html = read('src/sidepanel/sidepanel.html');
  const js = read('src/sidepanel/sidepanel.js');
  for (const id of ['logToggle', 'logList', 'logFilter', 'logCopy', 'logClear', 'logDiag']) {
    assert.match(html, new RegExp(`id="${id}"`), `panel is missing #${id}`);
    assert.match(js, new RegExp(`\\b${id}\\b`), `sidepanel.js never references #${id}`);
  }
  assert.match(read('src/service-worker.js'), /'panel:clearLog'/);
  assert.match(read('src/service-worker.js'), /'panel:diagnostics'/);
});

test('log level is part of the stored profile and editable in options', async () => {
  const { defaultProfile } = await import('../src/lib/profile.js');
  assert.ok(defaultProfile().logLevel, 'profile has no logLevel default');
  assert.match(read('src/options/options.html'), /id="logLevel"/);
  assert.match(read('src/options/options.js'), /logLevel:\s*fields\.logLevel\.value/);
});

// --- cross-context message contract ---------------------------------------

test('every message type the service worker handles is sent by someone', async () => {
  const { MSG } = await import('../src/lib/constants.js');
  const swSrc = read('src/service-worker.js');
  const allSrc = (await jsFiles()).map(read).join('\n');

  // Types the service worker switches on in its runtime.onMessage handler.
  const handlerBlock = swSrc.slice(swSrc.indexOf('chrome.runtime.onMessage.addListener'));
  const handled = [...handlerBlock.matchAll(/case MSG\.(\w+):/g)].map((m) => m[1]);
  assert.ok(handled.length > 0, 'service worker handles no message types');

  for (const key of handled) {
    const value = MSG[key];
    assert.ok(value, `service worker handles MSG.${key} which constants.js does not define`);
    // Either sent symbolically, or as the raw string from the content script.
    const sentSomewhere =
      allSrc.includes(`MSG.${key}`) && (allSrc.match(new RegExp(`MSG\\.${key}`, 'g')) ?? []).length > 1;
    assert.ok(sentSomewhere, `nothing ever sends MSG.${key}`);
  }
});

test('offscreen-targeted messages are all addressed with target: offscreen', () => {
  const swSrc = read('src/service-worker.js');
  const offscreenTypes = ['START_CAPTURE', 'STOP_CAPTURE', 'PLAY_ALERT'];
  for (const type of offscreenTypes) {
    const idx = swSrc.indexOf(`MSG.${type}`);
    if (idx === -1) continue;
    // Look back a short way for the target field on the same call.
    const window = swSrc.slice(Math.max(0, idx - 200), idx);
    assert.match(
      window,
      /target:\s*'offscreen'/,
      `MSG.${type} is sent without target: 'offscreen' and would be ignored`,
    );
  }
});

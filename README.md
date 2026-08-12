# Meet Mention Radar

A Chrome extension that listens to your Google Meet calls and alerts you the
moment you, a project you own, or someone on your watch list is mentioned —
then streams two notes into the side panel:

- **The ask** — what is being asked of you, in one line.
- **Context you need** — the earlier discussion that bears on your answer.

A rolling meeting summary sits below, refreshed in the background.

---

## Latency design

Three tiers, because the alert has to beat the end of the sentence:

| Tier | When | What runs |
|---|---|---|
| ~0ms | on **interim** transcript tokens | local phonetic + fuzzy matcher → chime + banner |
| ~400ms | after the trigger | streaming LLM call → the two notes, `ask` first |
| background | every ~45s or ~1200 chars | rolling summary, aborted whenever a trigger needs the network |

The summary is what keeps the context note fast: at trigger time the model
composes from an already-digested summary instead of re-reading the meeting.

Names are the hard part. Speech-to-text mangles proper nouns constantly —
"Afreedi" arrives as "a Freddy". Two defences: proper nouns are sent to the
transcriber as `keywords` to bias it up front, and the matcher compares
Double Metaphone codes so close misses still land.

---

## Setup

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Click the extension icon → ⚙, or open the options page directly.
3. Fill in your name, projects, and people. Paste an OpenAI API key and hit **Test key**.
4. Join a Meet call and click the extension icon once. The side panel opens and capture starts.

Clicking the icon again stops the session.

### Model IDs

The three model fields are editable on purpose — model IDs move faster than
extensions do. If a call fails with an unknown-model error, correct the ID in
options rather than editing code.

One constraint on the transcription model: proper-noun biasing needs a model
that supports the `keywords` parameter *and* server-side VAD. `gpt-transcribe`
(the default) does both. The `gpt-4o-transcribe` family has no `keywords`
support, and `gpt-live-transcribe` rejects `turn_detection` because it segments
turns itself. Point the field at a model without `keywords` and transcription
still runs — the client falls back to free-text `prompt` biasing and logs a
warning — but close-miss names land less often.

---

## Watching what it's doing

The extension runs in four JavaScript contexts, each with its own DevTools
console. Rather than making you open four, every context forwards structured
log entries to the service worker, which streams them into a **Log** view in
the side panel.

Click **Log** in the panel header. You get:

| Control | What it does |
|---|---|
| Filter box | substring match across context, message, and payload |
| Level select | All / Info+ / Warn+ / Errors |
| **Diagnose** | dumps current profile, watch list, credentials (masked) and session state |
| **Copy** | copies the *filtered* view to the clipboard as plain text |
| **Clear** | empties the buffer in both the panel and the worker |
| Follow | auto-scroll, and it won't yank the view while you're scrolled back |

Detail level is set in options (**Activity log detail**). `Info` is the default;
switch to `Debug` when something's wrong — it adds interim transcript, per-chunk
audio stats, and speaker resolution.

### Reading the log

Entries are tagged by context:

| Tag | Context |
|---|---|
| `sw` | service worker — session, triggers, notes timing |
| `audio` | offscreen document — capture, audio heartbeat |
| `stt` | transcription sockets |
| `meet` | content script in the Meet tab |

A healthy session looks roughly like this:

```
sw     service worker ready            {hasApiKey:true, projects:2}
sw     watching 7 trigger phrase(s)    {phrases:["name:Afreedi", ...]}
meet   call started                    {tilesFound:4}
sw     toolbar icon clicked
audio  audio context ready             {sampleRate:48000, resampleRatio:"2.000"}
audio  tab audio captured
audio  speaker loopback connected — the meeting should still be audible
stt    [remote] socket open
stt    [remote] session configured — transcription active
audio  ♪ remote: 250/250 chunks sent in 5s   {socket:"open", peakRms:0.084}
sw     ⟨remote⟩ Sarah Chen: so what's the timeline on the gateway
sw     🔔 TRIGGER · name:Afreedi        {heardAs:"a freddy", score:0.9}
sw     ⏱ first note token 412ms after trigger
sw     ⏱ notes complete 1180ms
```

The **`♪` heartbeat every 5s is the key diagnostic.** It separates the two
failure modes that look identical from the outside:

- `chunks sent: 0` or `peakRms` near zero → no audio is reaching the extension.
- Chunks flowing but no transcript → audio is fine, the socket or the API key is not.

### Secrets

The logger masks anything under a credential-shaped key (`apiKey`, `token`,
`authorization`, …) and any bare `sk-…` string, wherever it appears — including
nested objects. Tests cover this, because the Copy button exists to paste
output elsewhere.

---

## Troubleshooting

### Panel says "Not listening yet" and nothing happens

Click the extension icon **in the toolbar** while the Meet tab is focused —
that's what starts capture. The panel's own Start button works too, but the
toolbar icon is the reliable path because `tabCapture` is gated on the
extension having been invoked for that tab.

If the icon opens the panel but never starts capture, check
`chrome://extensions` → *service worker* console for
`[MentionRadar] action clicked`. No log means `chrome.action.onClicked` isn't
firing — the cause is `sidePanel.setPanelBehavior({openPanelOnActionClick:
true})`, which makes Chrome consume the click itself. The extension sets this
to `false` on every start, and a test guards against it regressing.

### Nothing is transcribing

Open the Log view and read the `♪` heartbeat (see above). No chunks means the
audio graph; chunks without transcript means the socket or the key.

### Alerts never fire

Check the `watching N trigger phrase(s)` line at startup — it prints the actual
watch list. If it's empty or missing your name, the profile didn't save.

If the phrases are right, set log detail to **Debug** and watch the `⟨remote⟩`
interim lines: that shows you exactly what the transcriber heard, which is
usually the answer. Add whatever mangling you see to your alias list.

### Anything else

Failures surface as a banner in the panel *and* as an `error` row in the log.
Hit **Diagnose**, then **Copy** — that's the complete picture, with the API key
masked.

---

## What gets sent where

Everything said on the call — by everyone, plus you if microphone capture is
on — is streamed to OpenAI for transcription, and excerpts go to the chat
model for the notes.

**Many workplaces and some jurisdictions require you to tell the other
participants.** That's your call to make, but make it deliberately.

Your API key is stored in `chrome.storage.local` — this browser profile only,
never `chrome.storage.sync`. Requests go straight from the extension to
OpenAI with no intermediary. Anyone with access to this browser profile can
read the key. If you ever distribute this beyond yourself, replace the direct
key use with a token-minting proxy (see the auth comment in
`src/realtime-client.js`).

---

## Architecture

MV3 dictates the shape, for two hard reasons: `chrome.tabCapture.capture()`
cannot run in a service worker, and service workers are killed after ~30s idle
— which would take the transcription sockets with them. So audio and sockets
live in an offscreen document.

```
┌─ content.js ────────────┐   speaker activity   ┌─ service-worker.js ─────┐
│ meet.google.com         │ ───────────────────> │ profile + trigger match │
│ • call start/end        │                      │ LLM dispatch            │
│ • participant roster    │                      │ rolling summary worker  │
│ • active-speaker tiles  │                      └───────────┬─────────────┘
└─────────────────────────┘                                  │ port
                                                             ▼
┌─ offscreen.js ──────────────────────────┐        ┌─ sidepanel.js ─────────┐
│ tabCapture ──┐                          │        │ 🔔 alert banner        │
│              ├─ AudioWorklet → PCM16    │ ─────> │ Note 1 · the ask       │
│ getUserMedia ┘   ├─ WS #1 (tab audio)   │ trans- │ Note 2 · context       │
│                  └─ WS #2 (mic, gated)  │ cript  │ rolling summary        │
│ loopback → speakers · alert chime       │        └────────────────────────┘
└─────────────────────────────────────────┘
```

**Two sockets, not one mixed stream.** OpenAI Realtime transcription returns
no speaker diarization, so the audio *channel* is the only reliable way to
tell you apart from everyone else. Mixing would throw that away permanently.
The mic socket is VAD-gated in the worklet, so it only bills while you're
actually talking.

**Speaker names** come from Meet's own active-speaker indicator, correlated
against transcript timestamps. This is best-effort: if Meet's markup has
moved, segments read as "Someone" and the panel says so, rather than
confidently mislabelling everyone.

### Files

| Path | Role |
|---|---|
| `src/realtime-client.js` | **the only file that knows the Realtime wire format** |
| `src/detect/matcher.js` | trigger matching — the 0ms tier |
| `src/detect/metaphone.js` | Double Metaphone |
| `src/audio/pcm-worklet.js` | downmix → anti-alias → resample → PCM16 → VAD |
| `src/offscreen/offscreen.js` | capture, both sockets, alert chime |
| `src/service-worker.js` | orchestration, attribution, LLM dispatch |
| `src/content.js` | Meet DOM (the fragile surface) |
| `src/llm/notes.js` | the two notes |
| `src/llm/summary.js` | rolling summary |

---

## Verification

### Automated

```bash
npm test
```

82 tests, no dependencies. Four suites:

- **matcher** — fixture table of real STT manglings that must fire, plus
  ordinary meeting chatter that must not. Cooldown, ranking, directed-question
  detection.
- **worklet** — resample ratio, PCM16 range and clamping, stereo downmix
  level, and the VAD gate opening/hanging over/closing. This maths is
  miserable to debug on the audio thread; it's verified in Node first.
- **openai** — the partial-JSON reader, including buffers cut mid-escape and
  mid-`\uXXXX`, and a byte-by-byte replay asserting the rendered note never
  regresses.
- **wiring** — manifest paths, import resolution, and that the message
  constants inlined in `content.js` still match `constants.js`.

### Manual — audio gates

Run these in order on a real call. Each must pass before the next is meaningful.

1. Load unpacked, join a Meet call, click the extension icon.
   **The meeting must still be audible.** If it goes silent, the loopback in
   `offscreen.js` is broken — `tabCapture` mutes the tab by default.
2. Open the offscreen document's console (`chrome://extensions` → *service
   worker* → Offscreen) and confirm transcript text appears within ~1s of speech.
3. Speak yourself. Confirm it arrives labelled as you, and that the mic socket
   is idle while you're silent.

### Manual — end to end

On a two-person test call:

- Have the other person say your name mid-sentence → **the chime fires before
  they finish the sentence.**
- Have them ask a direct question about a project discussed earlier → Note 1
  names the ask; Note 2 surfaces the *earlier* discussion, not a restatement
  of the question.
- Have them mention a project incidentally with no question → banner only.
- Say something yourself, then have them ask about it → the context note
  should reflect what you said. (This is what the mic socket buys.)
- Let the call run 10+ minutes → summary stays current, cost per minute flat.

The panel footer shows time-to-first-note-token. Targets: chime <100ms from
the name appearing in interim transcript, first note token <700ms.

---

## When Meet changes its markup

Meet ships obfuscated class names and rotates them. Everything version-
dependent is isolated in `SELECTORS` at the top of `src/content.js`.

If the panel warns that attribution has degraded, open the Meet tab's console
and run:

```js
__mentionRadar.probe()
```

Talk for ten seconds. It prints a ranked table of the attributes and classes
that changed on participant tiles — the top entry is almost always the new
speaking indicator. Add it to `SELECTORS.speaking` and reload.

Notes still work while attribution is broken; speakers just read as "Someone".

## Tuning

All latency and sensitivity knobs are in one place: `TUNING` in
`src/lib/constants.js`.

| Symptom | Knob |
|---|---|
| Alerts on the wrong words | raise `sensitivity` in options (0.82 → 0.88) |
| Missing manglings of your name | add the spelling to your alias list |
| Same topic alerts repeatedly | raise `TRIGGER_COOLDOWN_MS` |
| Mic socket costs too much | raise `VAD_RMS_OPEN` |
| Word tails clipped on your mic | raise `VAD_HANGOVER_MS` |
| Context note misses older discussion | raise `NOTES_VERBATIM_MS` |

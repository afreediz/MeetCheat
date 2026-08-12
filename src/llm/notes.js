/**
 * The two notes — the ~400ms tier.
 *
 * Note 1 ("ask")     : what is being asked of the user, in one line.
 * Note 2 ("context") : the earlier discussion they need in order to answer.
 *
 * Latency shape: the prompt is ordered stable-first so the provider can cache
 * the prefix, `ask` is declared first in the schema so it streams first, and
 * the context note is composed from the pre-computed rolling summary rather
 * than from the whole meeting. Composing beats re-reading.
 */

import { streamChat, readPartialStringFields } from './openai.js';
import { TRIGGER_KIND } from '../lib/constants.js';

const SYSTEM = `You brief a meeting participant the instant they are mentioned, while the conversation is still moving. They have seconds to read you.

Produce exactly two fields.

"ask": What is being asked of them right now, in one plain sentence naming who asked. If the mention was incidental — someone referred to them or their project without wanting anything from them — return an empty string.

"context": What was said earlier in this meeting that they need in order to answer well. Prefer specifics already on the record: numbers, dates, blockers, commitments, and who said them. Two or three short clauses separated by "; ". If nothing earlier bears on it, return an empty string rather than padding.

Rules:
- Never restate the question inside "context". They can already read the question.
- Never invent detail that is not in the transcript or summary.
- No preamble, no headings, no markdown. Plain text inside the JSON strings.
- Write to them directly as "you".`;

const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'mention_notes',
    strict: true,
    schema: {
      type: 'object',
      // Order matters: "ask" is emitted first so it renders while "context"
      // is still generating.
      properties: {
        ask: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['ask', 'context'],
      additionalProperties: false,
    },
  },
};

/** Static profile block — stable across a whole meeting, so it caches well. */
function profileBlock(profile) {
  const lines = [`You are briefing: ${profile.user.name || 'the user'}.`];
  if (profile.user.role) lines.push(`Their role: ${profile.user.role}`);

  if (profile.projects.length) {
    lines.push('Projects they own:');
    for (const p of profile.projects) {
      lines.push(`- ${p.name}${p.description ? `: ${p.description}` : ''}`);
    }
  }

  if (profile.people.length) {
    lines.push('People who matter to them:');
    for (const person of profile.people) {
      const relation = (person.relation ?? '').replace(/_/g, ' ');
      lines.push(relation ? `- ${person.name} (${relation})` : `- ${person.name}`);
    }
  }

  return lines.join('\n');
}

function triggerLine(trigger) {
  switch (trigger.kind) {
    case TRIGGER_KIND.NAME:
      return `They were addressed by name (heard as "${trigger.matchedText}").`;
    case TRIGGER_KIND.PROJECT:
      return `Their project "${trigger.label}" was mentioned (heard as "${trigger.matchedText}").`;
    case TRIGGER_KIND.PERSON:
      return `${trigger.label} was mentioned.`;
    default:
      return 'They were mentioned.';
  }
}

/**
 * Stream the two notes.
 *
 * @param {object} args
 * @param {object} args.profile
 * @param {object} args.trigger
 * @param {string} args.summary            rolling meeting summary (may be '')
 * @param {string} args.verbatim           recent speaker-attributed transcript
 * @param {string} args.utterance          the triggering line
 * @param {AbortSignal} args.signal
 * @param {(partial: {ask: string, context: string}) => void} args.onDelta
 * @returns {Promise<{ask: string, context: string}>}
 */
export async function streamNotes({
  profile,
  trigger,
  summary,
  verbatim,
  utterance,
  signal,
  onDelta,
}) {
  const messages = [
    // Stable prefix first — instructions, then profile.
    { role: 'system', content: `${SYSTEM}\n\n${profileBlock(profile)}` },
    {
      role: 'user',
      content: [
        summary ? `MEETING SO FAR:\n${summary}` : 'MEETING SO FAR:\n(nothing summarised yet)',
        '',
        `RECENT TRANSCRIPT:\n${verbatim || '(nothing yet)'}`,
        '',
        `WHAT JUST HAPPENED: ${triggerLine(trigger)}`,
        `TRIGGERING LINE: ${utterance}`,
      ].join('\n'),
    },
  ];

  let buffer = '';
  let last = { ask: '', context: '' };

  for await (const delta of streamChat({
    apiKey: profile.openai.apiKey,
    model: profile.openai.notesModel,
    messages,
    responseFormat: SCHEMA,
    maxTokens: 400,
    signal,
  })) {
    buffer += delta;
    const fields = readPartialStringFields(buffer, ['ask', 'context']);
    const next = { ask: fields.ask.value, context: fields.context.value };
    if (next.ask !== last.ask || next.context !== last.context) {
      last = next;
      onDelta?.(next);
    }
  }

  // Prefer a clean parse of the finished document; fall back to the last
  // partial if the model stopped mid-string (max_tokens, abort).
  try {
    const parsed = JSON.parse(buffer);
    return { ask: parsed.ask ?? '', context: parsed.context ?? '' };
  } catch {
    return last;
  }
}

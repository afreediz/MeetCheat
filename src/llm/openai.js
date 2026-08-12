/**
 * Minimal streaming Chat Completions client + a tolerant partial-JSON reader.
 *
 * Streaming is not optional here: the whole point is that Note 1 paints while
 * Note 2 is still being generated. Waiting for a complete response would add
 * a second of dead time to every alert.
 */

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

export class LlmError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Stream a chat completion, yielding text deltas as they arrive.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {object} [opts.responseFormat]
 * @param {number} [opts.maxTokens]
 * @param {AbortSignal} [opts.signal]
 * @returns {AsyncGenerator<string>}
 */
export async function* streamChat({
  apiKey,
  model,
  messages,
  responseFormat,
  maxTokens = 500,
  signal,
}) {
  const body = {
    model,
    messages,
    stream: true,
    max_tokens: maxTokens,
  };
  if (responseFormat) body.response_format = responseFormat;

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err?.error?.message ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new LlmError(detail, { status: res.status });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. Keep the trailing partial.
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // A frame split mid-JSON; the next read completes it.
        }
      }
    }
  }
}

/**
 * Read string fields out of a JSON document that is still being streamed.
 *
 * A normal JSON.parse can't run until the closing brace arrives, which would
 * defeat incremental rendering. For a flat object of string fields this scan
 * is enough: find the key, walk the value, and return whatever is complete so
 * far along with whether the field has closed.
 *
 * @param {string} buffer partial JSON text
 * @param {string[]} fields field names to extract
 * @returns {Record<string, {value: string, complete: boolean}>}
 */
export function readPartialStringFields(buffer, fields) {
  const out = {};

  for (const field of fields) {
    out[field] = { value: '', complete: false };

    const keyIdx = buffer.indexOf(`"${field}"`);
    if (keyIdx === -1) continue;

    // Skip past the key, the colon, and any whitespace to the opening quote.
    let i = keyIdx + field.length + 2;
    while (i < buffer.length && buffer[i] !== ':') i++;
    i++;
    while (i < buffer.length && /\s/.test(buffer[i])) i++;
    if (buffer[i] !== '"') continue;
    i++;

    let value = '';
    let complete = false;

    for (; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch === '\\') {
        const next = buffer[i + 1];
        if (next === undefined) break; // escape split across chunks
        value += unescapeChar(next, buffer, i);
        i += next === 'u' ? 5 : 1;
        continue;
      }
      if (ch === '"') {
        complete = true;
        break;
      }
      value += ch;
    }

    out[field] = { value, complete };
  }

  return out;
}

function unescapeChar(next, buffer, i) {
  switch (next) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    case '"': return '"';
    case '\\': return '\\';
    case '/': return '/';
    case 'u': {
      const hex = buffer.slice(i + 2, i + 6);
      return hex.length === 4 ? String.fromCharCode(parseInt(hex, 16)) : '';
    }
    default: return next;
  }
}

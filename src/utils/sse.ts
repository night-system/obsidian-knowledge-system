/**
 * Minimal Server-Sent-Events parser for Anthropic-compatible streaming. Pure
 * (no Obsidian import) so it can be unit-tested in isolation.
 */

export interface AnthropicSSEEvent {
  event: string;
  data: unknown;
}

/** Parse `null`-able JSON, falling back to the raw string. */
function tryParsed(raw: string): unknown {
  if (raw === '') return '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Parse an array of SSE lines into `{ event, data }` records. Handles:
 * - `event:` / `data:` frames, with multiple `data:` lines joined by `\n`;
 * - blank lines as event separators;
 * - `:` comment lines (ignored);
 * - non-JSON `data` values preserved as the raw string (never throws).
 */
export function parseAnthropicSSE(lines: string[]): AnthropicSSEEvent[] {
  const out: AnthropicSSEEvent[] = [];
  let event = '';
  let dataLines: string[] = [];

  const flush = () => {
    if (event || dataLines.length > 0) {
      out.push({ event: event || '', data: tryParsed(dataLines.join('\n')) });
    }
    event = '';
    dataLines = [];
  };

  for (const rawLine of lines) {
    const line = !!rawLine && rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    // Unknown line types are ignored per the SSE spec.
  }
  flush();
  return out;
}

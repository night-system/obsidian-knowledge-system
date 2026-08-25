/**
 * Minimal Server-Sent-Events parser for Anthropic-compatible streaming. Pure
 * (no Obsidian import) so it can be unit-tested in isolation.
 *
 * Two parsers share the same frame semantics:
 * - `parseAnthropicSSE(lines)` — one-shot over a complete line array (used by
 *   the baseline contract tests and the non-streaming path).
 * - `createIncrementalSseParser(onEvent)` — stateful, streaming parser that
 *   consumes arbitrary String chunks as they arrive from a reader, so the chat
 *   UI can render each frame the moment its blank line closes it (true
 *   char-by-char streaming instead of buffering the whole body).
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

/** Mutable frame accumulator shared by both parsers (`event` name + data lines). */
interface SseFrameState {
  event: string;
  dataLines: string[];
}

type FrameResult = { frame: { event: string; data: unknown } | null };

/**
 * Feed one completed line (its trailing `\n` already stripped) into a mutable
 * frame. A blank line closes (and returns) the current frame; `event:`/`data:`
 * lines accumulate; `:` comments and unknown line types are ignored per the SSE
 * spec. Returns `{ frame: null }` when the line did not close a frame.
 */
function processSseLine(state: SseFrameState, rawLine: string): FrameResult {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line === '') {
    if (state.event || state.dataLines.length > 0) {
      const frame = { event: state.event || '', data: tryParsed(state.dataLines.join('\n')) };
      state.event = '';
      state.dataLines = [];
      return { frame };
    }
    return { frame: null };
  }
  if (line.startsWith(':')) return { frame: null };
  if (line.startsWith('event:')) {
    state.event = line.slice(6).trim();
    return { frame: null };
  }
  if (line.startsWith('data:')) {
    state.dataLines.push(line.slice(5).trimStart());
    return { frame: null };
  }
  return { frame: null };
}

/**
 * Create a stateful incremental SSE parser. `push` appends a raw chunk and
 * emits every frame whose last line was closed by a `\n`; a partial line is
 * kept in an internal buffer and spliced together with the next chunk (so a
 * chunk can cut a line or a `data:` record in half). `flush` processes any
 * trailing unterminated line and emits the final frame; `reset` clears all
 * accumulated state (event name, data lines, buffer).
 *
 * `input_json_delta` `partial_json` is preserved verbatim inside `data` and
 * only JSON-parsed when the whole frame commits at its blank line — because a
 * frame-level `data` is only committed whole, `tryParsed` never sees a
 * mid-frame partial (its "parse-fail → return raw string" behavior is kept).
 */
export function createIncrementalSseParser(
  onEvent: (ev: { event: string; data: unknown }) => void
): { push(chunk: string): void; flush(): void; reset(): void } {
  let buffer = '';
  const state: SseFrameState = { event: '', dataLines: [] };
  // Upper bound on the partial-line buffer. A single line larger than this
  // (pathological output, e.g. a runaway token run with no newline) is
  // force-flushed and dropped so buffered memory cannot grow without limit.
  const MAX_BUFFER = 1024 * 1024;

  const push = (chunk: string): void => {
    buffer += chunk;
    let idx: number;
    // Consume every whole line; anything after the last `\n` stays buffered.
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const res = processSseLine(state, line);
      if (res.frame) onEvent(res.frame);
    }
    if (buffer.length > MAX_BUFFER) {
      // Overflow safeguard: emit whatever frame is currently open, then drop
      // the oversized tail. (Frames are tiny; 1 MB means the stream is broken.)
      if (state.event || state.dataLines.length > 0) {
        onEvent({ event: state.event || '', data: tryParsed(state.dataLines.join('\n')) });
      }
      state.event = '';
      state.dataLines = [];
      buffer = '';
    }
  };

  const flush = (): void => {
    // A final unterminated line is still a complete line per the SSE spec.
    if (buffer.length > 0) {
      const res = processSseLine(state, buffer);
      if (res.frame) onEvent(res.frame);
      buffer = '';
    }
    // A frame without a trailing blank line still needs to commit.
    if (state.event || state.dataLines.length > 0) {
      onEvent({ event: state.event || '', data: tryParsed(state.dataLines.join('\n')) });
      state.event = '';
      state.dataLines = [];
    }
  };

  const reset = (): void => {
    buffer = '';
    state.event = '';
    state.dataLines = [];
  };

  return { push, flush, reset };
}

/**
 * Parse an array of SSE lines into `{ event, data }` records. Handles:
 * - `event:` / `data:` frames, with multiple `data:` lines joined by `\n`;
 * - blank lines as event separators;
 * - `:` comment lines (ignored);
 * - non-JSON `data` values preserved as the raw string (never throws).
 */
export function parseAnthropicSSE(lines: string[]): AnthropicSSEEvent[] {
  const state: SseFrameState = { event: '', dataLines: [] };
  const out: AnthropicSSEEvent[] = [];
  for (const rawLine of lines) {
    const res = processSseLine(state, rawLine);
    if (res.frame) out.push(res.frame);
  }
  // Trailing frame without a blank line separator.
  if (state.event || state.dataLines.length > 0) {
    out.push({ event: state.event || '', data: tryParsed(state.dataLines.join('\n')) });
  }
  return out;
}

/** A normalized Anthropic content block used by the chat UI. */
export interface AnthropicBlock {
  type: 'thinking' | 'text' | 'tool_use';
  thinking: string;
  text: string;
  signature: string;
  id: string;
  name: string;
  input: unknown;
  partialJson: string;
}

/** Result of parsing a non-streaming Anthropic response body. */
export interface AnthropicNonStreamResult {
  blocks: AnthropicBlock[];
  stop_reason: string | null;
}

/**
 * Parse a non-streaming Anthropic message response body (`{ content: [...],
 * stop_reason, usage }`) into the normalized block sequence the chat UI renders,
 * plus the terminal `stop_reason`. Used for the non-streaming fallback path.
 */
export function parseAnthropicResponse(json: unknown): AnthropicNonStreamResult {
  const obj = json && typeof json === 'object' ? (json as any) : {};
  const content = Array.isArray(obj.content) ? obj.content : [];
  const blocks: AnthropicBlock[] = content.map((c: any) => {
    if (c?.type === 'thinking') {
      return { type: 'thinking', thinking: c.thinking ?? '', text: '', signature: c.signature ?? '', id: '', name: '', input: {}, partialJson: '' };
    }
    if (c?.type === 'tool_use') {
      return { type: 'tool_use', thinking: '', text: '', signature: '', id: c.id ?? '', name: c.name ?? '', input: c.input ?? {}, partialJson: '' };
    }
    return { type: 'text', thinking: '', text: c?.text ?? '', signature: '', id: '', name: '', input: {}, partialJson: '' };
  });
  return { blocks, stop_reason: obj.stop_reason ?? null };
}

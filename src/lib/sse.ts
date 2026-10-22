/**
 * The application's stream codec: the one place that knows the wire format of a generation.
 *
 * `POST /api/generate` answers with a `text/event-stream` body, and both ends of that body meet
 * here — the route handler writes frames with {@link encodeEvent} and the client controller reads
 * them back with {@link parseEventStream}. Sharing this module is what keeps the two ends from
 * drifting apart: a change to the grammar lands on the reader and the writer at the same time.
 *
 * The frame grammar:
 *
 *     data: {"type":"delta","text":"…"}\n
 *     \n
 *
 * A single `data:` line carries the JSON of a {@link GenerationEvent} and is terminated by a blank
 * line. The frame's kind travels as the `type` discriminant inside the payload, so no `event:`
 * name, no `retry:` field and no multi-line `data:` block is ever emitted. A line beginning with
 * `:` is a comment — that is how the keepalive arrives — and carries no event.
 *
 * A stream holds exactly one `meta` frame, then zero or more `delta` frames, then exactly one
 * terminal `done` or `error` frame. That order is the writer's obligation: {@link encodeEvent}
 * encodes whatever frame it is handed and enforces nothing about the sequence.
 *
 * This is the client-safe half of `src/lib`. It imports types only, so nothing here can pull a
 * server-only module or a dependency into the browser bundle — in particular it does not import
 * `@/lib/errors`, which is why {@link parseEventStream} rejects with a plain `Error` whose message
 * the controller shows to the user as it stands.
 */

import type { GenerationEvent } from '@/types';

/**
 * The interval, in milliseconds, at which the route handler writes {@link PING_FRAME} while the
 * model is still working.
 *
 * A stream that says nothing for a long while is liable to be closed by a proxy or a hosting layer
 * that believes it is idle; the keepalive comment is what holds the connection open across the
 * model's thinking time.
 */
export const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * The smallest number of bytes a single write to the socket should carry.
 *
 * Some browsers hold small chunks in a buffer instead of handing them to the reader, which turns a
 * progressive stream back into a blocking one. The route handler coalesces consecutive small deltas
 * until a write reaches this floor; the number lives here so the writer reads it rather than
 * repeating it.
 */
export const MIN_WRITE_BYTES = 1024;

/**
 * The keepalive frame: a comment line followed by the blank line that ends the frame.
 *
 * It is a complete, well-formed frame that carries no event, so a reader skips it and any
 * intermediary still sees traffic.
 */
export const PING_FRAME = ': ping\n\n';

/** The blank line that ends a frame. */
const FRAME_BOUNDARY = '\n\n';

/** The prefix of the single line a frame's payload travels on. */
const DATA_PREFIX = 'data:';

/** The value raced against a pending read, so an aborted stream stops instead of waiting. */
const ABORTED = 'aborted';

type AbortSentinel = typeof ABORTED;

/**
 * What the user is told when a stream dies before its terminal frame, whatever killed it: the body
 * ending early, arriving broken, or being cut off by the invocation that hosted it. One sentence
 * covers all three because the user's next action is the same in each case, and naming the
 * transport detail would only replace an actionable message with a diagnosis.
 */
const INCOMPLETE_STREAM_MESSAGE =
  'The draft stopped before it finished — the generation ended unexpectedly. Please retry.';

/**
 * Encodes one frame into the text that goes on the wire.
 *
 * The result is pure and total: any of the four event shapes encodes, and nothing about their order
 * or their number is checked here — the caller that writes them owns that sequence.
 *
 * @param event The frame to encode, discriminated on its `type`.
 * @returns `data: <json>` followed by a blank line, so the frame stands alone in the stream.
 */
export function encodeEvent(event: GenerationEvent): string {
  return `data: ${JSON.stringify(event)}${FRAME_BOUNDARY}`;
}

/**
 * Reads a generation stream, dispatching each frame to `onEvent` in the order it arrives.
 *
 * The body is consumed incrementally through a streaming `TextDecoder`, so a multi-byte character
 * split across two chunks survives, and frames are buffered until the blank line that ends them, so
 * a frame split across two chunks is decoded once rather than twice. `\r\n` is normalised to `\n` so
 * a frame written through an intermediary that rewrites line endings still splits. Comment lines are
 * skipped, and a malformed frame — one whose payload is not valid JSON, or whose `type` is not one
 * of `meta`, `delta`, `done` or `error` — is reported on the console and skipped, because losing one
 * frame is a better outcome than losing the draft that follows it.
 *
 * Reading stops at the first terminal frame: nothing after a `done` or an `error` is dispatched.
 *
 * @param response The streamed response to read. It has to carry a body.
 * @param onEvent Called once per valid frame, in order. What it throws propagates to the caller.
 * @param signal The caller's abort signal — the one it also handed to `fetch`. When it aborts, the
 *   read stops and this promise resolves: a Stop is the user's own decision, so it is reported as a
 *   stop rather than as a failure to retry. It is raced against every pending read, so a Stop takes
 *   effect even while the body is waiting for bytes that never arrive.
 * @returns A promise that resolves once a terminal `done` or `error` frame has been dispatched, or
 *   once `signal` aborted, whichever happens first.
 * @throws {Error} When the response has no body, or when the stream ends — or stops arriving —
 *   without a terminal frame, which is what a killed invocation looks like from here. The message is
 *   written for the person on screen and says the draft did not finish and can be retried.
 */
export async function parseEventStream(
  response: Response,
  onEvent: (event: GenerationEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) {
    throw new Error(
      'The server sent no generation stream, so no draft was received. Please try again.',
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const abort = watchAbort(signal);
  let buffer = '';
  let terminalReceived = false;

  const dispatch = (frame: string): void => {
    const event = decodeFrame(frame);
    if (event === null) {
      return;
    }
    terminalReceived = event.type === 'done' || event.type === 'error';
    onEvent(event);
  };

  // Frames are drained after every chunk and once more at end of stream, so a frame that straddles a
  // chunk boundary is whole before it is decoded.
  const drain = (): void => {
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf(FRAME_BOUNDARY);
    while (boundary !== -1 && !terminalReceived) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + FRAME_BOUNDARY.length);
      dispatch(frame);
      boundary = buffer.indexOf(FRAME_BOUNDARY);
    }
  };

  try {
    while (!terminalReceived && !signal.aborted) {
      const pending = reader.read();
      // Whichever promise loses the race below must not surface as an unhandled rejection.
      void pending.catch(() => undefined);

      const outcome = await Promise.race([pending, abort.promise]);
      if (outcome === ABORTED) {
        void reader.cancel().catch(() => undefined);
        break;
      }

      if (outcome.done === true) {
        // Flush the decoder: a trailing multi-byte sequence can still be held inside it.
        buffer += decoder.decode();
        drain();
        break;
      }

      buffer += decoder.decode(outcome.value, { stream: true });
      drain();
    }
  } catch (error) {
    // An aborted fetch rejects its pending read; that is the user's Stop, not a failure to report.
    if (signal.aborted) {
      return;
    }
    // The stream died rather than ended, so the user gets the same actionable sentence a stream that
    // simply stopped would produce; the transport's own error rides along as the cause.
    throw new Error(INCOMPLETE_STREAM_MESSAGE, { cause: error });
  } finally {
    abort.dispose();
    try {
      reader.releaseLock();
    } catch {
      // A read was still pending when the caller aborted; the aborted fetch closes the body.
    }
  }

  if (terminalReceived || signal.aborted) {
    return;
  }

  throw new Error(INCOMPLETE_STREAM_MESSAGE);
}

/**
 * Watches `signal` for as long as one read has to stay interruptible.
 *
 * A body that has stopped sending bytes leaves `reader.read()` pending indefinitely, so testing the
 * signal between reads is not enough to make a Stop take effect; the promise returned here is the
 * other side of the race that ends that wait.
 *
 * @param signal The signal to watch.
 * @returns The promise that settles when the signal aborts, and a disposer that detaches the
 *   listener again so a long-lived signal does not accumulate one watcher per stream.
 */
function watchAbort(signal: AbortSignal): { promise: Promise<AbortSentinel>; dispose: () => void } {
  if (signal.aborted) {
    return { promise: Promise.resolve(ABORTED), dispose: () => undefined };
  }

  let resolveAbort: (value: AbortSentinel) => void = () => undefined;
  const promise = new Promise<AbortSentinel>((resolve) => {
    resolveAbort = resolve;
  });
  const listener = (): void => resolveAbort(ABORTED);
  signal.addEventListener('abort', listener, { once: true });

  return {
    promise,
    dispose: () => {
      signal.removeEventListener('abort', listener);
    },
  };
}

/**
 * Decodes the body of one frame into an event.
 *
 * Fields this codec never emits, comments among them, are ignored; a frame carrying no `data:` line
 * is therefore a keepalive and yields nothing, silently.
 *
 * @param frame The frame's text, without the blank line that ended it.
 * @returns The event, or `null` for a keepalive or a malformed frame — in which case the reason is
 *   reported on the console and the frame is skipped rather than failing the read.
 */
function decodeFrame(frame: string): GenerationEvent | null {
  const payload: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line.startsWith(DATA_PREFIX)) {
      continue;
    }
    const value = line.slice(DATA_PREFIX.length);
    payload.push(value.startsWith(' ') ? value.slice(1) : value);
  }

  if (payload.length === 0) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.join('\n'));
  } catch {
    warnMalformedFrame('its payload is not valid JSON', frame.length);
    return null;
  }

  if (!isGenerationEvent(decoded)) {
    warnMalformedFrame('its type is not one of meta, delta, done or error', frame.length);
    return null;
  }

  return decoded;
}

/**
 * Narrows an unknown payload to a {@link GenerationEvent} by its discriminant.
 *
 * The discriminant is what makes a frame well-formed — a payload carrying one of the four frame
 * kinds is a frame this application wrote — so no other field is inspected here and the payload
 * reaches the component that narrows it exhaustively.
 *
 * @param value The value parsed out of a frame's payload.
 * @returns True when the value is one of the four frame shapes.
 */
function isGenerationEvent(value: unknown): value is GenerationEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const type: unknown = (value as { type?: unknown }).type;
  return type === 'meta' || type === 'delta' || type === 'done' || type === 'error';
}

/**
 * Reports a frame the read skipped.
 *
 * Only the reason and the frame's length appear: a payload can carry document text or draft text,
 * and neither belongs in the browser's console.
 *
 * @param reason Why the frame was skipped.
 * @param length The frame's length in characters, for diagnosis.
 */
function warnMalformedFrame(reason: string, length: number): void {
  console.warn(`[sse] Skipped a malformed frame: ${reason} (frame length ${length}).`);
}

/**
 * Unit suite for the stream codec, `src/lib/sse.ts`: the frame grammar, the incremental read, and how
 * the reader behaves when a stream is damaged or when the caller stops it.
 *
 * Every case is driven by a synthetic `Response` over a `ReadableStream` of `Uint8Array` chunks, so
 * the suite needs no network, no credential and no clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KEEPALIVE_INTERVAL_MS,
  MIN_WRITE_BYTES,
  PING_FRAME,
  encodeEvent,
  parseEventStream,
} from '@/lib/sse';
import type { DoneEvent, GenerationEvent, MetaEvent } from '@/types';

const encoder = new TextEncoder();

const META: MetaEvent = {
  type: 'meta',
  documents: [{ name: 'sample-requirements.md', chars: 120, truncated: false }],
  sourceChars: 120,
  warnings: [],
  model: 'stub',
};

const DONE: DoneEvent = {
  type: 'done',
  chars: 42,
  model: 'stub',
  durationMs: 12,
  truncated: false,
};

const DELTA_ONE: GenerationEvent = { type: 'delta', text: 'Overview\n' };
const DELTA_TWO: GenerationEvent = { type: 'delta', text: 'Goals\n' };

const MISSING_TERMINAL = /did not finish|unexpectedly/i;

/** A streamed response whose body yields each chunk in order and then closes. */
function responseOfChunks(chunks: readonly Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

/** The same, from textual chunks — one chunk per string, each encoded as UTF-8. */
function responseOfText(chunks: readonly string[]): Response {
  return responseOfChunks(chunks.map((chunk) => encoder.encode(chunk)));
}

/** A body the test feeds by hand, so a read can be left pending on purpose. */
class LiveStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  readonly response: Response;

  constructor() {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.response = new Response(stream);
  }

  push(chunk: string): void {
    this.controller?.enqueue(encoder.encode(chunk));
  }

  close(): void {
    this.controller?.close();
  }

  error(reason: unknown): void {
    this.controller?.error(reason);
  }
}

/**
 * Reads `response` and records every dispatched event.
 *
 * `settled` is the parse promise to await. `waitForEvents` resolves once `count` events have been
 * recorded, so a test waits for delivery itself instead of polling the clock for it.
 */
function collect(
  response: Response,
  signal?: AbortSignal,
): {
  events: GenerationEvent[];
  settled: Promise<void>;
  waitForEvents: (count: number) => Promise<void>;
} {
  const events: GenerationEvent[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const settled = parseEventStream(
    response,
    (event) => {
      events.push(event);
      for (const waiter of [...waiters]) {
        if (events.length < waiter.count) {
          continue;
        }
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    signal ?? new AbortController().signal,
  );

  const waitForEvents = (count: number): Promise<void> => {
    if (events.length >= count) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push({ count, resolve });
    });
  };

  return { events, settled, waitForEvents };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the exported grammar constants', () => {
  it('publishes the keepalive cadence, the write floor and the keepalive frame', () => {
    expect(KEEPALIVE_INTERVAL_MS).toBe(15_000);
    expect(MIN_WRITE_BYTES).toBe(1024);
    expect(PING_FRAME).toBe(': ping\n\n');
  });

  it('encodes each event shape as one data line followed by a blank line', () => {
    for (const event of [
      META,
      DELTA_ONE,
      DONE,
      { type: 'error', code: 'PROVIDER_ERROR', message: 'x', retryable: true } as GenerationEvent,
    ]) {
      const frame = encodeEvent(event);
      expect(frame).toBe(`data: ${JSON.stringify(event)}\n\n`);
      expect(frame.startsWith('data: ')).toBe(true);
      expect(frame.endsWith('\n\n')).toBe(true);
      expect(frame.slice(0, -2).split('\n')).toHaveLength(1);
      expect(frame).not.toContain('event:');
      expect(frame).not.toContain('retry:');
    }
  });

  it('escapes consecutive newlines inside a delta so the frame never carries a second line', () => {
    const delta: GenerationEvent = { type: 'delta', text: 'a\n\nb' };
    const frame = encodeEvent(delta);

    // The blank line that ends the frame is the only line break in it: the payload's newlines travel
    // as JSON escapes, which is what stops a delta's own text from splitting the frame around it.
    expect(frame.split('data: ')).toHaveLength(2);
    expect(frame).toContain('"text":"a\\n\\nb"');
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(frame.slice(0, -2)).not.toContain('\n');
    expect(JSON.parse(frame.slice('data: '.length))).toEqual(delta);
  });
});

describe('parseEventStream on a well-formed stream', () => {
  it('dispatches meta, then each delta, then done, in order, and resolves', async () => {
    const response = responseOfText([
      encodeEvent(META),
      encodeEvent(DELTA_ONE),
      encodeEvent(DELTA_TWO),
      encodeEvent(DONE),
    ]);
    const { events, settled } = collect(response);

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DELTA_ONE, DELTA_TWO, DONE]);
  });

  it('dispatches a terminal error frame and resolves', async () => {
    const failure: GenerationEvent = {
      type: 'error',
      code: 'GENERATION_TIMEOUT',
      message: 'The draft took too long. Please retry.',
      retryable: true,
    };
    const { events, settled } = collect(
      responseOfText([encodeEvent(META), encodeEvent(DELTA_ONE), encodeEvent(failure)]),
    );

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DELTA_ONE, failure]);
  });

  it('stops reading at the terminal frame, so nothing after done is dispatched', async () => {
    const { events, settled } = collect(
      responseOfText([encodeEvent(META), encodeEvent(DONE), encodeEvent(DELTA_ONE)]),
    );

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DONE]);
  });

  it('parses a frame split across two chunks exactly once', async () => {
    const frame = encodeEvent(DELTA_ONE);
    const bytes = encoder.encode(frame);
    const cut = Math.floor(bytes.length / 2);
    const response = responseOfChunks([
      bytes.slice(0, cut),
      bytes.slice(cut),
      encoder.encode(encodeEvent(DONE)),
    ]);
    const { events, settled } = collect(response);

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([DELTA_ONE, DONE]);
  });

  it('dispatches three frames delivered in a single chunk in order', async () => {
    const response = responseOfText([
      `${encodeEvent(META)}${encodeEvent(DELTA_ONE)}${encodeEvent(DONE)}`,
    ]);
    const { events, settled } = collect(response);

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DELTA_ONE, DONE]);
  });

  it('parses a frame split exactly between its two terminating newlines', async () => {
    const frame = encodeEvent(DELTA_ONE);
    // The first chunk ends on the first of the frame's two terminating newlines, so the boundary is
    // not in the buffer yet and the frame has to be held until the second one arrives.
    expect(frame.endsWith('\n\n')).toBe(true);
    const response = responseOfChunks([
      encoder.encode(frame.slice(0, -1)),
      encoder.encode(`${frame.slice(-1)}${encodeEvent(DONE)}`),
    ]);
    const { events, settled } = collect(response);

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([DELTA_ONE, DONE]);
  });

  it('survives a multi-byte character split across the chunk boundary', async () => {
    const text = 'café — ☕ ready';
    const delta: GenerationEvent = { type: 'delta', text };
    const frame = encodeEvent(delta);
    const bytes = encoder.encode(frame);
    const markerStart = encoder.encode(frame.slice(0, frame.indexOf('☕'))).length;
    const response = responseOfChunks([
      bytes.slice(0, markerStart + 1),
      bytes.slice(markerStart + 1),
      encoder.encode(encodeEvent(DONE)),
    ]);
    const { events, settled } = collect(response);

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([delta, DONE]);
  });

  it('normalises CRLF line endings', async () => {
    const crlf = `${encodeEvent(META)}${encodeEvent(DONE)}`.replace(/\n/g, '\r\n');
    const { events, settled } = collect(responseOfText([crlf]));

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DONE]);
  });
});

describe('parseEventStream on a damaged stream', () => {
  it('accepts a data line without a space after the colon', async () => {
    const { events, settled } = collect(
      responseOfText([`data:${JSON.stringify(META)}\n\n`, `data:${JSON.stringify(DONE)}\n\n`]),
    );

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DONE]);
  });

  it('ignores keepalive comments and still dispatches the frames around them', async () => {
    const { events, settled } = collect(
      responseOfText([PING_FRAME, encodeEvent(META), PING_FRAME, encodeEvent(DONE)]),
    );

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DONE]);
  });

  it('warns about a malformed JSON frame and keeps reading the stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { events, settled } = collect(
      responseOfText([
        encodeEvent(META),
        'data: {not json}\n\n',
        encodeEvent(DELTA_ONE),
        encodeEvent(DONE),
      ]),
    );

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DELTA_ONE, DONE]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('not json');
  });

  it('warns about a frame with an unknown discriminant and does not treat it as terminal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { events, settled } = collect(
      responseOfText([encodeEvent(META), 'data: {"type":"surprise"}\n\n', encodeEvent(DONE)]),
    );

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DONE]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns, but never writes payload content, for a non-object payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { events, settled } = collect(
      responseOfText(['data: "just a string"\n\n', encodeEvent(META), encodeEvent(DONE)]),
    );

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DONE]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects when the stream ends without a terminal frame', async () => {
    const { events, settled } = collect(
      responseOfText([encodeEvent(META), encodeEvent(DELTA_ONE), encodeEvent(DELTA_TWO)]),
    );

    await expect(settled).rejects.toThrow(MISSING_TERMINAL);
    expect(events).toEqual([META, DELTA_ONE, DELTA_TWO]);
  });

  it('rejects when the stream ends with an unterminated frame', async () => {
    const { settled } = collect(
      responseOfText([`${encodeEvent(DELTA_ONE)}data: ${JSON.stringify(DONE)}`]),
    );

    await expect(settled).rejects.toThrow(MISSING_TERMINAL);
  });

  it('rejects when the body closes with no frames at all', async () => {
    const { events, settled } = collect(responseOfText([]));

    // An empty body is not a completed generation: no meta and no terminal frame were seen, so it
    // reports the same actionable failure a stream that stopped mid-draft does.
    await expect(settled).rejects.toThrow(MISSING_TERMINAL);
    expect(events).toEqual([]);
  });

  it('rejects with the retryable message, preserving the cause, when the body fails mid-stream', async () => {
    const live = new LiveStream();
    const failure = new Error('socket closed');
    const { settled } = collect(live.response);

    live.error(failure);

    let received: Error | null = null;
    try {
      await settled;
    } catch (error) {
      received = error as Error;
    }

    expect(received).toBeInstanceOf(Error);
    expect(received?.message).toMatch(MISSING_TERMINAL);
    expect(received?.cause).toBe(failure);
  });

  it('rejects when the response carries no body', async () => {
    const { events, settled } = collect(new Response(null));

    await expect(settled).rejects.toThrow(/no generation stream/i);
    expect(events).toEqual([]);
  });
});

describe('parseEventStream and the caller signal', () => {
  it('resolves rather than rejecting when the signal aborts mid-stream, dispatching nothing more', async () => {
    const live = new LiveStream();
    const controller = new AbortController();
    const { events, settled, waitForEvents } = collect(live.response, controller.signal);

    live.push(encodeEvent(META));
    live.push(encodeEvent(DELTA_ONE));
    // Wait for the events themselves rather than for the clock: the abort has to land on a stream
    // whose next read is already pending, and the test must not depend on elapsed time to get there.
    await waitForEvents(2);

    controller.abort();
    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([META, DELTA_ONE]);
  });

  it('stops a read that is waiting for bytes which never arrive', async () => {
    const live = new LiveStream();
    const controller = new AbortController();
    const { events, settled } = collect(live.response, controller.signal);

    controller.abort();
    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { events, settled } = collect(
      responseOfText([encodeEvent(META), encodeEvent(DONE)]),
      controller.signal,
    );

    await expect(settled).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it('does not treat a body that errors after an abort as a failure', async () => {
    const live = new LiveStream();
    const controller = new AbortController();
    const { settled } = collect(live.response, controller.signal);

    controller.abort();
    live.close();
    await expect(settled).resolves.toBeUndefined();
  });

  it('treats a body error that arrives with the caller aborted as a stop, not a failure', async () => {
    const live = new LiveStream();
    const controller = new AbortController();
    const { settled } = collect(live.response, controller.signal);

    live.error(new Error('the fetch was aborted'));
    controller.abort();

    await expect(settled).resolves.toBeUndefined();
  });
});

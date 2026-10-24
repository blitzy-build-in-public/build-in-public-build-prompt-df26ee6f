// @vitest-environment node
/**
 * Integration suite: `POST /api/generate` driven end to end through its public interface.
 *
 * The handler is called exactly as the application calls it — with a real `Request` carrying a
 * `multipart/form-data` body — and answered as a real `Response` whose `text/event-stream` body is
 * decoded frame by frame. Nothing is stubbed except the model provider, so the guard, the validation,
 * the extraction, the source assembly, the rate limiter, the frame writer and the error mapping are
 * the ones that ship.
 *
 * The Node environment (`@vitest-environment node`, above) rather than the jsdom default: the
 * handler identifies a file part by the `[object File]` brand, precisely so that the `File` a
 * runtime's `request.formData()` builds and the `File` a test environment installs cannot be confused
 * for one another. Running here means one runtime supplies the request, its form and its files, so
 * every upload is the real thing.
 *
 * Offline and clock-free. The provider is stubbed (`PROMPT_PROVIDER=stub`), so no case needs a
 * credential and no case reaches the network; where the handler's own 90-second deadline has to fire,
 * fake timers move that clock rather than the suite waiting on a real one. Documents come from
 * `tests/fixtures`, so no fixture is added here.
 *
 * Every case resets the module registry first, because `src/lib/rate-limit.ts` holds one module-level
 * `Map` of counters: a fresh module graph per test is what keeps one case's requests from spending
 * another case's allowance.
 */
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODEL, MAX_OUTPUT_TOKENS, type Provider } from '@/lib/provider';
import { SECTION_SKELETON, SYSTEM_INSTRUCTION } from '@/lib/prompt';
import { KEEPALIVE_INTERVAL_MS, MIN_WRITE_BYTES, parseEventStream } from '@/lib/sse';
import {
  GENERATION_TIMEOUT_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_REQUEST_BYTES,
  MAX_SOURCE_CHARS,
  RATE_LIMIT_MAX,
} from '@/lib/validation';
import type {
  BuildPromptRequest,
  GenerateErrorEnvelope,
  GenerationEvent,
  ProviderEvent,
} from '@/types';

/**
 * The endpoint under test, as an absolute URL: `Request` refuses a relative one.
 *
 * The path is the handler's own, and the origin is arbitrary — the handler reads the method, the
 * headers, the body and the abort signal, and no host.
 */
const ENDPOINT_URL = 'http://localhost/api/generate';

/** Bytes in a mebibyte, the unit the single-file cap is expressed in. */
const BYTES_PER_MB = 1_048_576;

/** The text-format fixture the AAP names for this suite, reused rather than duplicated. */
const FIXTURE_URL = new URL('../fixtures/sample-requirements.md', import.meta.url);

/** The fixture's bytes, as one multipart part is built from them. */
const SAMPLE_REQUIREMENTS_BYTES = readFileSync(FIXTURE_URL);

/**
 * The fixture's text, which is the character count the `meta` frame reports for it and the source
 * size the log line records: extraction decodes the same bytes as UTF-8.
 */
const SAMPLE_REQUIREMENTS_TEXT = SAMPLE_REQUIREMENTS_BYTES.toString('utf8');

/** The name the fixture is uploaded under, which is the provenance the warnings and `meta` quote. */
const SAMPLE_REQUIREMENTS_NAME = 'sample-requirements.md';

/** The environment variables the provider module reads; every one is restored after each test. */
const PROVIDER_VARIABLES = ['PROMPT_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_MODEL'] as const;

type ProviderVariable = (typeof PROVIDER_VARIABLES)[number];

/** What those variables held before this suite touched them, so nothing is left changed. */
const ORIGINAL_ENVIRONMENT = new Map<ProviderVariable, string | undefined>(
  PROVIDER_VARIABLES.map((name) => [name, process.env[name]]),
);

/**
 * The console lines this suite's requests produced.
 *
 * `src/lib/log.ts` writes one metadata line per completed request through `console.info`, and
 * `src/lib/sse.ts` reports a frame it could not decode through `console.warn`. Both are captured
 * rather than printed — the suite asserts on the log line and on the absence of skipped frames — and
 * capturing them also keeps the handler's expected console output out of the test report.
 */
let logLines: string[] = [];
let skippedFrameWarnings: string[] = [];

const encoder = new TextEncoder();

/**
 * A count as the user-facing sentences render it, so an assertion reads the way the warning does.
 *
 * @param value A character or byte count.
 * @returns The count with thousands separated, for example `60,000`.
 */
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * One upload as a multipart file part.
 *
 * @param name The name the handler will report and validate.
 * @param bytes The file's content.
 * @param type The declared MIME type, which the handler never reads: kind is decided from the
 *   extension and the leading bytes, so a mislabelled part reaches the same parser as a labelled one.
 * @returns The part to append under the `files` field.
 */
function upload(name: string, bytes: Uint8Array, type = 'application/octet-stream'): File {
  // The bytes are copied into a buffer of their own: a `Buffer`, or a view over a pooled allocation,
  // is typed with a wider buffer than a `BlobPart` accepts, and a copy states plainly that this part
  // carries exactly these bytes.
  return new File([new Uint8Array(bytes)], name, { type });
}

/**
 * One text upload, encoded as UTF-8 so the validation module's leading-byte check accepts it.
 *
 * @param name The file's name, whose extension decides the kind.
 * @param text The content, encoded to the bytes the request carries.
 * @returns The part to append under the `files` field.
 */
function textUpload(name: string, text: string): File {
  return upload(name, encoder.encode(text), 'text/plain');
}

/**
 * The AAP's text fixture as one upload.
 *
 * @returns A fresh part carrying `tests/fixtures/sample-requirements.md`.
 */
function sampleRequirementsFile(): File {
  return upload(SAMPLE_REQUIREMENTS_NAME, SAMPLE_REQUIREMENTS_BYTES, 'text/markdown');
}

/**
 * One submission, as the browser sends it.
 *
 * @param options The pasted description, the uploaded parts, a `Content-Length` to declare, and a body
 *   to send in place of the built form. What is left out is left out of the request, which is how the
 *   cases below reach the handler's own branches for each of them.
 * @returns A `POST` request to the endpoint, carrying a real multipart body.
 */
function generateRequest(
  options: {
    description?: string;
    files?: File[];
    contentLength?: number;
    body?: BodyInit;
    signal?: AbortSignal;
    textParts?: Array<[field: string, value: string]>;
  } = {},
): Request {
  const form = new FormData();

  if (options.description !== undefined) {
    form.append('description', options.description);
  }

  for (const file of options.files ?? []) {
    form.append('files', file);
  }

  for (const [field, value] of options.textParts ?? []) {
    form.append(field, value);
  }

  const headers = new Headers();
  if (options.contentLength !== undefined) {
    headers.set('content-length', String(options.contentLength));
  }

  return new Request(ENDPOINT_URL, {
    method: 'POST',
    body: options.body ?? form,
    headers,
    signal: options.signal,
  });
}

/**
 * Import the route handler from a fresh module graph.
 *
 * The import is dynamic and taken after `beforeEach` reset the registry, so this test's handler and
 * the rate limiter it composes are its own. Only `POST` is returned: everything else in the module is
 * private to it.
 *
 * @returns The endpoint's request handler.
 */
async function loadPost(): Promise<(request: Request) => Promise<Response>> {
  const route = await import('@/app/api/generate/route');

  return route.POST;
}

/**
 * Register a provider for the next module graph this suite loads.
 *
 * The handler selects its provider through `getProvider`, and the two phases no shipped provider
 * reaches in a test — a failure before the first token, and a failure after it — are asserted through
 * this seam. Nothing else about the module is replaced, so the remaining exports stay the ones the
 * application ships.
 *
 * @param provider The provider to select.
 */
function useProvider(provider: Provider): void {
  vi.doMock('@/lib/provider', async () => {
    const actual = await vi.importActual<typeof import('@/lib/provider')>('@/lib/provider');

    return { ...actual, getProvider: () => provider };
  });
}

/**
 * Read a streamed response to its end, keeping both its frames and its raw text.
 *
 * The grammar is the one the codec writes: one `data:` line carrying the JSON of a frame, terminated
 * by a blank line, with a `:` comment line as keepalive. The body is read to its end, so this also
 * proves the stream terminates.
 *
 * @param response A response whose body is a generation stream.
 * @returns Every frame the stream carried, in order, with nothing filtered out, and the body's own
 *   text so a case can assert on what travelled that no frame carries — a keepalive comment.
 */
async function readStream(
  response: Response,
): Promise<{ events: GenerationEvent[]; text: string }> {
  const text = await response.text();
  const events: GenerationEvent[] = [];

  for (const frame of text.split('\n\n')) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) {
        continue;
      }

      const value = line.slice('data:'.length);
      events.push(JSON.parse(value.startsWith(' ') ? value.slice(1) : value) as GenerationEvent);
    }
  }

  return { events, text };
}

/**
 * The frames a streamed response carried.
 *
 * @param response A response whose body is a generation stream.
 * @returns Every frame the stream carried, in order, with nothing filtered out.
 */
async function readFrames(response: Response): Promise<GenerationEvent[]> {
  return (await readStream(response)).events;
}

/**
 * A step a test releases by hand, so a provider can be suspended at a chosen point.
 *
 * The handler takes the provider's first event before it commits the response, so a provider that
 * yields one section and then waits leaves the stream open with the model still working — the state a
 * Stop, a cancelled body and a keepalive all belong to.
 */
interface Gate {
  promise: Promise<void>;
  release: () => void;
}

/**
 * Build a gate that nothing but {@link Gate.release} opens.
 *
 * @returns The gate's promise and the function that settles it.
 */
function deferred(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

/**
 * An iterable whose first step rejects, the way a provider that fails on its first read behaves.
 *
 * @returns An async iterable that throws before yielding anything.
 */
async function* failingBeforeItsFirstToken(): AsyncIterable<ProviderEvent> {
  throw new Error('the provider refused before its first token');
}

/**
 * Read one failure response's envelope.
 *
 * @param response A response the handler refused with, whose body the specification declares to be a
 *   {@link GenerateErrorEnvelope}.
 * @returns The envelope, checked to carry its three fields before it is used.
 */
async function readEnvelope(response: Response): Promise<GenerateErrorEnvelope> {
  const envelope = (await response.json()) as Partial<GenerateErrorEnvelope>;

  if (
    typeof envelope.code !== 'string' ||
    typeof envelope.message !== 'string' ||
    typeof envelope.retryable !== 'boolean'
  ) {
    throw new Error('A failure response was not a { code, message, retryable } envelope.');
  }

  return envelope as GenerateErrorEnvelope;
}

/**
 * The single item of a list the contract says holds exactly one.
 *
 * Asserting here keeps every call site reading as the contract does — "the one `done` frame" — while
 * `noUncheckedIndexedAccess` still yields a value that is not possibly `undefined`.
 *
 * @param items The list, which the caller asserts holds one item.
 * @returns That item.
 */
function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [first] = items;

  if (first === undefined) {
    throw new Error('Expected exactly one item.');
  }

  return first;
}

/**
 * The warning sentence a dropped file is named in.
 *
 * @param warnings The sentences a `meta` frame carried.
 * @param name The dropped file's name, as the sentences quote it.
 * @returns That file's sentence.
 */
function warningFor(warnings: readonly string[], name: string): string {
  const quoted = JSON.stringify(name);
  const warning = warnings.find((candidate) => candidate.includes(quoted));

  if (warning === undefined) {
    throw new Error(`No warning named ${quoted}.`);
  }

  return warning;
}

/**
 * The frames of one kind, narrowed by the discriminant the codec writes.
 *
 * @param events The frames a stream carried.
 * @param type The frame kind to keep.
 * @returns Those frames, in the order they arrived.
 */
function eventsOfType<T extends GenerationEvent['type']>(
  events: readonly GenerationEvent[],
  type: T,
): Array<Extract<GenerationEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<GenerationEvent, { type: T }> => event.type === type,
  );
}

beforeEach(() => {
  // A fresh module graph per test: the rate limiter's counters live in module state, so a shared graph
  // would let the tenth request of one test refuse the first request of the next.
  vi.resetModules();
  vi.doUnmock('@/lib/provider');

  // The stub provider is the default posture of this suite: no credential, no network, a deterministic
  // draft. The 503 case is the one that removes it again.
  process.env.PROMPT_PROVIDER = 'stub';
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;

  logLines = [];
  skippedFrameWarnings = [];
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    skippedFrameWarnings.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();

  for (const [name, value] of ORIGINAL_ENVIRONMENT) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('POST /api/generate: the draft it streams', () => {
  it('answers 200 with the SSE headers and writes one meta, delta frames and exactly one done frame', async () => {
    const POST = await loadPost();
    const description = 'A short brief for the support triage tool.';

    const response = await POST(
      generateRequest({ description, files: [sampleRequirementsFile()] }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    // A streamed body's length is unknown when its headers are written, so none is declared.
    expect(response.headers.get('content-length')).toBeNull();

    const events = await readFrames(response);
    const meta = only(eventsOfType(events, 'meta'));
    const deltas = eventsOfType(events, 'delta');
    const done = only(eventsOfType(events, 'done'));

    expect(deltas.length).toBeGreaterThan(0);
    expect(eventsOfType(events, 'error')).toHaveLength(0);
    expect(events[0]?.type).toBe('meta');
    expect(events.at(-1)?.type).toBe('done');
    expect(events.slice(1, -1).every((event) => event.type === 'delta')).toBe(true);

    // The draft the client assembles is the concatenation of the delta frames and nothing else, and
    // the terminal frame's count is that draft's length.
    const draft = deltas.map((delta) => delta.text).join('');
    expect(done.chars).toBe(draft.length);
    expect(done.model).toBe(DEFAULT_MODEL);
    expect(done.truncated).toBe(false);
    expect(done.durationMs).toBeGreaterThanOrEqual(0);

    // What the model was given, reported before generation started.
    expect(meta.documents).toEqual([
      { name: SAMPLE_REQUIREMENTS_NAME, chars: SAMPLE_REQUIREMENTS_TEXT.length, truncated: false },
    ]);
    expect(meta.sourceChars).toBe(description.length + SAMPLE_REQUIREMENTS_TEXT.length);
    expect(meta.warnings).toEqual([]);
    expect(meta.model).toBe(DEFAULT_MODEL);

    // The draft the stub provider writes is one heading per section of the shared skeleton, in the
    // skeleton's order, with nothing appended to it.
    const headings = draft.match(/^## .+$/gm) ?? [];
    expect(headings.map((heading) => heading.slice('## '.length))).toEqual([...SECTION_SKELETON]);
  });

  it('writes frames its own client parser reads back as one meta, deltas and one done, skipping none', async () => {
    const POST = await loadPost();
    const response = await POST(
      generateRequest({ description: 'Route each incoming message to one product area.' }),
    );

    const seen: GenerationEvent[] = [];
    await parseEventStream(response, (event) => seen.push(event), new AbortController().signal);

    expect(seen[0]?.type).toBe('meta');
    expect(seen.at(-1)?.type).toBe('done');
    expect(eventsOfType(seen, 'meta')).toHaveLength(1);
    expect(eventsOfType(seen, 'done')).toHaveLength(1);
    expect(eventsOfType(seen, 'delta').length).toBeGreaterThan(0);
    // The parser reports a frame it cannot decode and skips it; nothing here was skipped.
    expect(skippedFrameWarnings).toEqual([]);
  });

  it('records one metadata line for the request, carrying no pasted or document text', async () => {
    const POST = await loadPost();
    const description = 'Track the overnight queue depth on the operations page.';

    await readFrames(
      await POST(generateRequest({ description, files: [sampleRequirementsFile()] })),
    );

    const line = only(logLines);
    const entry = JSON.parse(line) as Record<string, unknown>;

    expect(entry).toMatchObject({
      route: '/api/generate',
      status: 200,
      sourceChars: description.length + SAMPLE_REQUIREMENTS_TEXT.length,
      documentCount: 1,
      rejectedCount: 0,
      truncatedCount: 0,
      model: DEFAULT_MODEL,
      errorCode: null,
    });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(line).not.toContain(description);
    expect(line).not.toContain(SAMPLE_REQUIREMENTS_TEXT.slice(0, 60));
  });
});

describe('POST /api/generate: what the module declares', () => {
  it('runs on the Node runtime and keeps its own deadline inside the hosting hint', async () => {
    // Both facts are declarations rather than behaviour: the runtime is the one the document
    // extractors need, and `maxDuration` is the hint that stops a hosting platform killing the
    // invocation before the handler can write its terminal frame.
    const route = await import('@/app/api/generate/route');

    expect(route.runtime).toBe('nodejs');
    expect(route.maxDuration).toBe(90);
    // The bound itself is the handler's own, and the deadline case below observes it firing.
    expect(GENERATION_TIMEOUT_MS).toBe(90_000);
    // The hint may not fire before the handler's own deadline, or the graceful path would lose the
    // race to the platform and the client would see a stream with no terminal frame.
    expect(GENERATION_TIMEOUT_MS).toBeLessThanOrEqual(route.maxDuration * 1_000);
  });
});

describe('POST /api/generate: a submission it cannot generate from', () => {
  it('answers 400 INVALID_INPUT for a description past its limit, naming the count and the limit', async () => {
    const POST = await loadPost();
    const description = 'x'.repeat(MAX_DESCRIPTION_CHARS + 1);

    const response = await POST(generateRequest({ description }));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);

    const envelope = await readEnvelope(response);
    expect(envelope.code).toBe('INVALID_INPUT');
    expect(envelope.retryable).toBe(false);
    expect(envelope.message).toContain(formatCount(description.length));
    expect(envelope.message).toContain(formatCount(MAX_DESCRIPTION_CHARS));
  });

  it('answers 400 INVALID_INPUT when nothing usable is left after extraction', async () => {
    const POST = await loadPost();

    // A file validation refuses, and a text file that extracts to nothing: neither leaves the model
    // anything to read, and neither may cost a model call.
    const unsupportedOnly = await POST(
      generateRequest({ files: [textUpload('notes.csv', 'owner,area\nsam,billing\n')] }),
    );
    const emptyOnly = await POST(generateRequest({ files: [textUpload('blank.md', '   \n\n\t')] }));

    for (const response of [unsupportedOnly, emptyOnly]) {
      expect(response.status).toBe(400);

      const envelope = await readEnvelope(response);
      expect(envelope.code).toBe('INVALID_INPUT');
      expect(envelope.retryable).toBe(false);
      expect(envelope.message.length).toBeGreaterThan(0);
    }
  });

  it('answers 400 INVALID_INPUT when the body cannot be read as a multipart form', async () => {
    const POST = await loadPost();

    const response = await POST(generateRequest({ body: 'not a multipart form at all' }));

    expect(response.status).toBe(400);

    const envelope = await readEnvelope(response);
    expect(envelope.code).toBe('INVALID_INPUT');
    expect(envelope.retryable).toBe(false);
    // The sentence for an unreadable body, which is a different situation from a submission with
    // nothing usable in it and names the one action that resolves it.
    expect(envelope.message).toMatch(/could not be read/i);
  });

  it('spends no model call on a submission it refuses', async () => {
    // A double whose only job is to be reached or not reached: the caps are enforced before a provider
    // is selected, so a refused submission must never spend a model call, and reaching this one is a
    // loud failure rather than a quietly successful draft.
    const generate = vi.fn((): AsyncIterable<ProviderEvent> => {
      throw new Error('A refused submission reached the provider.');
    });
    useProvider({ model: 'unreachable-model', generate });
    const POST = await loadPost();

    // Past the description cap, and a submission with nothing usable in it: an unsupported file and
    // no pasted text at all. Neither may cost a model call.
    const overLong = await POST(
      generateRequest({ description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1) }),
    );
    const nothingUsable = await POST(generateRequest({ files: [textUpload('notes.rtf', 'r')] }));

    for (const response of [overLong, nothingUsable]) {
      expect(response.status).toBe(400);

      const envelope = await readEnvelope(response);
      expect(envelope.code).toBe('INVALID_INPUT');
      expect(envelope.retryable).toBe(false);
    }

    expect(generate).not.toHaveBeenCalled();
  });

  it('answers 413 PAYLOAD_TOO_LARGE from Content-Length before the body is read', async () => {
    const POST = await loadPost();
    const declared = MAX_REQUEST_BYTES + 1;

    // A real submission whose declared length is past the cap …
    const declaredTooLarge = await POST(
      generateRequest({
        description: 'A brief with an over-limit declared length.',
        files: [sampleRequirementsFile()],
        contentLength: declared,
      }),
    );
    // … and a body this server could not parse at all. Both are answered 413 rather than 400, which is
    // what shows the guard ran before anything read the body.
    const unreadableBody = await POST(
      generateRequest({ body: 'not a multipart body', contentLength: declared }),
    );

    for (const response of [declaredTooLarge, unreadableBody]) {
      expect(response.status).toBe(413);

      const envelope = await readEnvelope(response);
      expect(envelope.code).toBe('PAYLOAD_TOO_LARGE');
      expect(envelope.retryable).toBe(false);
      expect(envelope.message).toContain('16 MB');
    }
  });

  it('answers 429 RATE_LIMITED on the request past the allowance, saying when the window reopens', async () => {
    const POST = await loadPost();
    const submission = (): Request =>
      generateRequest({ description: 'One brief, sent repeatedly.' });

    // The real clock, deliberately: a Node request carries no peer address, so every request in this
    // in-process run resolves to the rate limiter's shared bucket, and a ten-minute window cannot
    // close inside a sub-second test. No case depends on elapsed time — this one depends on a window
    // that cannot expire before the run ends.
    const allowed: number[] = [];
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX; attempt += 1) {
      const response = await POST(submission());
      allowed.push(response.status);
      // Every stream is drained: a response body nobody reads would hold its writer open.
      await readFrames(response);
    }

    const refused = await POST(submission());

    expect(allowed).toEqual(Array.from({ length: RATE_LIMIT_MAX }, () => 200));
    expect(refused.status).toBe(429);

    const envelope = await readEnvelope(refused);
    expect(envelope.code).toBe('RATE_LIMITED');
    expect(envelope.retryable).toBe(true);
    // The refusal is actionable: it says when the window the allowance was spent in reopens.
    expect(envelope.message).toMatch(/resets at \d{2}:\d{2} UTC/);
  });

  it('answers 503 PROVIDER_UNAVAILABLE when the deployment has no provider credential', async () => {
    // The default selection is the streaming provider, which refuses the request while no key is
    // configured — before the model call is attempted and while a status can still carry the failure.
    delete process.env.PROMPT_PROVIDER;
    const POST = await loadPost();

    const response = await POST(
      generateRequest({ description: 'A brief the server cannot answer.' }),
    );

    expect(response.status).toBe(503);

    const envelope = await readEnvelope(response);
    expect(envelope.code).toBe('PROVIDER_UNAVAILABLE');
    expect(envelope.retryable).toBe(true);
    expect(envelope.message).toContain('OPENAI_API_KEY');
  });
});

describe('POST /api/generate: files that break a file-level rule', () => {
  it('warns about every file it dropped and still streams the draft from the files it read', async () => {
    const POST = await loadPost();
    const appendix = '# Appendix\n\nExtra detail the brief mentions in passing.\n';
    const oversized = new Uint8Array(MAX_FILE_BYTES + 1);

    const response = await POST(
      generateRequest({
        files: [
          sampleRequirementsFile(),
          textUpload('notes.csv', 'owner,area\nsam,billing\n'),
          textUpload('blank.md', '   \n\n\t'),
          upload('huge.md', oversized),
          textUpload('appendix.md', appendix),
          textUpload('sixth.md', '# Sixth\n\nOne file past the count.\n'),
        ],
        // A plain text part under the same field name: not a file, so it is skipped rather than
        // counted, and it changes nothing about what the draft was generated from.
        textParts: [['files', 'this was meant to be an attachment']],
      }),
    );

    expect(response.status).toBe(200);

    const events = await readFrames(response);
    const meta = only(eventsOfType(events, 'meta'));

    // Only the two readable, in-limit files reach the model, and the source is exactly their text: the
    // oversized upload was never read.
    expect(meta.documents.map((document) => document.name)).toEqual([
      SAMPLE_REQUIREMENTS_NAME,
      'appendix.md',
    ]);
    expect(meta.sourceChars).toBe(SAMPLE_REQUIREMENTS_TEXT.length + appendix.length);
    expect(events.at(-1)?.type).toBe('done');

    expect(meta.warnings).toHaveLength(4);
    expect(warningFor(meta.warnings, 'notes.csv')).toContain('not a supported file type');
    expect(warningFor(meta.warnings, 'huge.md')).toContain(
      `larger than the ${MAX_FILE_BYTES / BYTES_PER_MB} MB limit`,
    );
    expect(warningFor(meta.warnings, 'sixth.md')).toContain(`at most ${MAX_FILES} files`);
    expect(warningFor(meta.warnings, 'blank.md')).toContain('holds no text that could be read');
  });

  it('reaches the model with the document it kept and never with the one it dropped', async () => {
    const keptSentinel = 'SENTINEL-KEPT-DOCUMENT';
    const droppedSentinel = 'SENTINEL-DROPPED-DOCUMENT';
    const pastedSentinel = 'SENTINEL-PASTED-DESCRIPTION';
    const captured: BuildPromptRequest[] = [];

    useProvider({
      model: 'capturing-model',
      async *generate(request: BuildPromptRequest): AsyncIterable<ProviderEvent> {
        captured.push(request);
        yield { type: 'text', text: '## Overview\n\nA draft.' };
      },
    });
    const POST = await loadPost();

    const response = await POST(
      generateRequest({
        description: `${pastedSentinel}: keep the tool small.`,
        files: [
          textUpload('kept.md', `# Kept\n\n${keptSentinel}\n`),
          textUpload('dropped.csv', `owner,area\n${droppedSentinel}\n`),
        ],
      }),
    );

    expect(response.status).toBe(200);
    // The submission still generated, and it generated from the file that passed.
    expect(eventsOfType(await readFrames(response), 'done')).toHaveLength(1);

    const providerRequest = only(captured);

    // The trusted instruction and the untrusted source travel in separate fields of the request, and
    // the instruction is the prompt module's own constant: no source text reaches the instruction
    // role, which is the containment this endpoint's security rests on.
    expect(providerRequest.instructions).toBe(SYSTEM_INSTRUCTION);
    expect(providerRequest.instructions).not.toContain(keptSentinel);
    expect(providerRequest.instructions).not.toContain(pastedSentinel);

    // What the model is given is what was kept and nothing else: no text from the dropped file
    // reaches it, because the sentence explaining a drop is written for the user, not for the model.
    expect(providerRequest.input).toContain(keptSentinel);
    expect(providerRequest.input).toContain(pastedSentinel);
    expect(providerRequest.input).not.toContain(droppedSentinel);

    expect(providerRequest.model).toBe('capturing-model');
    expect(providerRequest.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('keeps a document that does not fit the budget, flags it truncated and warns how much was kept', async () => {
    const POST = await loadPost();
    const description = 'Keep the tool small.';
    const longText = 'a'.repeat(MAX_SOURCE_CHARS + 10_000);

    const response = await POST(
      generateRequest({ description, files: [textUpload('long-requirements.md', longText)] }),
    );

    expect(response.status).toBe(200);

    const events = await readFrames(response);
    const meta = only(eventsOfType(events, 'meta'));
    const document = only(meta.documents);
    const kept = MAX_SOURCE_CHARS - description.length;

    expect(document.name).toBe('long-requirements.md');
    expect(document.chars).toBe(kept);
    expect(document.truncated).toBe(true);
    expect(meta.sourceChars).toBe(MAX_SOURCE_CHARS);
    expect(only(meta.warnings)).toContain(
      `${formatCount(kept)} of its ${formatCount(longText.length)} characters were kept`,
    );
    expect(events.at(-1)?.type).toBe('done');
  });
});

describe('POST /api/generate: a provider that fails', () => {
  it('answers 503 PROVIDER_UNAVAILABLE when the provider fails before its first token', async () => {
    let failing: 'on-the-call' | 'on-the-first-step' = 'on-the-call';
    useProvider({
      model: 'failing-model',
      generate(): AsyncIterable<ProviderEvent> {
        if (failing === 'on-the-call') {
          throw new Error('the upstream call was refused');
        }

        return failingBeforeItsFirstToken();
      },
    });
    const POST = await loadPost();
    const submission = (): Request =>
      generateRequest({ description: 'A brief the provider never begins to answer.' });

    // A provider that refuses when it is called, and one that fails on its first read: both are
    // failures before the first token, and both are answered with a status while one can still carry
    // it.
    const refusedOnTheCall = await POST(submission());
    failing = 'on-the-first-step';
    const refusedOnTheFirstStep = await POST(submission());

    for (const response of [refusedOnTheCall, refusedOnTheFirstStep]) {
      expect(response.status).toBe(503);

      const envelope = await readEnvelope(response);
      expect(envelope.code).toBe('PROVIDER_UNAVAILABLE');
      expect(envelope.retryable).toBe(true);
      // The sentence is written for the person on screen; the failure's own text stays on the server.
      expect(envelope.message).not.toContain('the upstream call was refused');
      expect(envelope.message).not.toContain('refused before its first token');
    }
  });

  it('writes one terminal PROVIDER_ERROR frame when the provider fails after the stream began', async () => {
    // The failure is raised as the application's own error type, from the module the handler itself
    // imports, so the handler's classification keeps the sentence that failure carried.
    const { AppError } = await import('@/lib/errors');
    const partial = '## Overview\n\nA draft that stops partway through.';
    const sentence =
      'The model stopped before the draft was finished. Try again; your inputs are unchanged.';

    useProvider({
      model: 'flaky-model',
      async *generate(): AsyncIterable<ProviderEvent> {
        yield { type: 'text', text: partial };
        throw new AppError('PROVIDER_UNAVAILABLE', { message: sentence });
      },
    });
    const POST = await loadPost();

    const response = await POST(
      generateRequest({ description: 'A brief the provider drops halfway through.' }),
    );

    // The status line went out with the stream, so the failure can only travel inside it.
    expect(response.status).toBe(200);

    const events = await readFrames(response);
    const failure = only(eventsOfType(events, 'error'));

    expect(events[0]?.type).toBe('meta');
    expect(only(eventsOfType(events, 'delta')).text).toBe(partial);
    expect(eventsOfType(events, 'done')).toHaveLength(0);
    expect(events.at(-1)).toBe(failure);
    // The code names the phase — after streaming began — and the sentence is the one that was raised.
    expect(failure.code).toBe('PROVIDER_ERROR');
    expect(failure.message).toBe(sentence);
    expect(failure.retryable).toBe(true);
    // The request's one log line records the terminal frame's code.
    expect((JSON.parse(only(logLines)) as Record<string, unknown>).errorCode).toBe(
      'PROVIDER_ERROR',
    );
  });

  it('ends the generation at its own deadline and writes one GENERATION_TIMEOUT error frame', async () => {
    useProvider({
      model: 'silent-model',
      async *generate(): AsyncIterable<ProviderEvent> {
        // A provider that produces nothing and never finishes: only the handler's own deadline can end
        // this generation.
        await new Promise<never>(() => undefined);
      },
    });
    const POST = await loadPost();

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const pending = POST(generateRequest({ description: 'A brief whose draft never arrives.' }));

    // The handler takes the first provider event before it commits the response, so the request stays
    // open until its deadline fires. Advancing the fake clock is what fires it; nothing waits on a
    // real one.
    let response: Response | null = null;
    for (let advance = 0; advance < 5 && response === null; advance += 1) {
      await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS);
      response = await Promise.race([pending, Promise.resolve(null)]);
    }

    if (response === null) {
      throw new Error('The generation did not end when the handler’s deadline fired.');
    }

    const events = await readFrames(response);
    const failure = only(eventsOfType(events, 'error'));

    expect(events[0]?.type).toBe('meta');
    expect(eventsOfType(events, 'done')).toHaveLength(0);
    expect(events.at(-1)).toBe(failure);
    expect(failure.code).toBe('GENERATION_TIMEOUT');
    expect((JSON.parse(only(logLines)) as Record<string, unknown>).errorCode).toBe(
      'GENERATION_TIMEOUT',
    );
  });
});

describe('POST /api/generate: a generation the handler keeps alive and ends', () => {
  it('keeps a stalled stream open with a keepalive and marks the done frame truncated when the model is cut off', async () => {
    const gate = deferred();
    const firstSection = '## Overview\n\n';
    useProvider({
      model: 'capped-model',
      async *generate(): AsyncIterable<ProviderEvent> {
        yield { type: 'text', text: firstSection };
        await gate.promise;
        // The model reached its output cap: the draft is partial, and the provider says so.
        yield { type: 'truncated' };
      },
    });
    const POST = await loadPost();

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const response = await POST(
      generateRequest({ description: 'A brief whose draft is cut off.' }),
    );
    const pending = readStream(response);

    // A model that says nothing for a whole keepalive interval would otherwise leave an intermediary
    // reading the silence as an idle connection.
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    gate.release();

    const { events, text } = await pending;
    const done = only(eventsOfType(events, 'done'));

    expect(text).toContain(': ping');
    expect(events.map((event) => event.type)).toEqual(['meta', 'delta', 'done']);
    expect(only(eventsOfType(events, 'delta')).text).toBe(firstSection);
    expect(done.chars).toBe(firstSection.length);
    // The draft is partial, and the terminal frame is what tells the interface to say so.
    expect(done.truncated).toBe(true);
  });

  it('writes nothing after the meta frame when the client stops the request mid-generation', async () => {
    const askedForTheNextStep = deferred();
    const gate = deferred();
    useProvider({
      model: 'slow-model',
      async *generate(): AsyncIterable<ProviderEvent> {
        yield { type: 'text', text: '## Overview\n\n' };
        // The handler is now asking for the next piece of the draft, and this generator is what holds
        // it: the Stop below therefore arrives while the stream is waiting on the provider.
        askedForTheNextStep.release();
        await gate.promise;
      },
    });
    const POST = await loadPost();
    const controller = new AbortController();

    const response = await POST(
      generateRequest({ description: 'A brief the user stops.', signal: controller.signal }),
    );

    // The stream is read from here on: a write resolves only once its reader has taken the chunk, so
    // reading is what lets the handler reach the provider for the next piece of the draft.
    const pending = readStream(response);

    await askedForTheNextStep.promise;
    // The Stop, arriving through the request it was made on.
    controller.abort();

    const { events } = await pending;

    // There is nobody left to receive a fragment or a terminal frame, so neither is written — and the
    // Stop is not reported as a failure the user should retry.
    expect(events.map((event) => event.type)).toEqual(['meta']);
    expect(JSON.parse(only(logLines)) as Record<string, unknown>).toMatchObject({
      status: 200,
      errorCode: null,
    });
  });

  it('stops writing when the consumer cancels the response body mid-generation', async () => {
    const gate = deferred();
    useProvider({
      model: 'abandoned-model',
      async *generate(): AsyncIterable<ProviderEvent> {
        yield { type: 'text', text: '## Overview\n\n' };
        await gate.promise;
        // Past the write floor, so the handler tries to put this on the wire.
        yield { type: 'text', text: 'x'.repeat(MIN_WRITE_BYTES) };
      },
    });
    const POST = await loadPost();

    const response = await POST(
      generateRequest({ description: 'A brief whose reader goes away.' }),
    );
    const body = response.body;

    if (body === null) {
      throw new Error('The streamed response carried no body.');
    }

    const reader = body.getReader();
    await reader.read();
    // A closed tab or a dead connection: the consumer is gone, and the handler must not keep writing
    // to it or report the abandoned generation as a failure.
    await reader.cancel();

    gate.release();
    await vi.waitFor(() => {
      expect(logLines).toHaveLength(1);
    });

    expect(JSON.parse(only(logLines)) as Record<string, unknown>).toMatchObject({
      status: 200,
      errorCode: null,
    });
  });
});

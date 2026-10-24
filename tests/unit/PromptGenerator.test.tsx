/**
 * Unit suite for the screen's controller, `src/components/PromptGenerator.tsx`: the request it
 * builds, the stream it consumes, and what the screen shows in each state it can be in.
 *
 * Every case drives the component through a stubbed `fetch` that answers with a `Response` the test
 * writes into by hand, so the suite reaches no network, needs no credential and asserts no elapsed
 * time. The frames written into that response are built with the real codec, `encodeEvent` from
 * `@/lib/sse`, so this suite also reads back exactly the format the route handler writes.
 *
 * `Response`, `ReadableStream` and `TextEncoder` are Node's rather than jsdom's — jsdom implements
 * none of them — so the environment keeps the constructors the runtime already exposes and nothing
 * here has to shim or replace a module under test.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { INSTRUCTION_LINE, PromptGenerator } from '@/components/PromptGenerator';
import { encodeEvent } from '@/lib/sse';
import type {
  DeltaEvent,
  DoneEvent,
  ErrorCode,
  GenerateErrorEnvelope,
  GenerationEvent,
  Limits,
  MetaEvent,
} from '@/types';

/** The caps the server page passes down: the same numbers `src/lib/validation.ts` enforces. */
const LIMITS: Limits = {
  maxFiles: 5,
  maxFileBytes: 8388608,
  maxDescriptionChars: 10000,
  acceptedExtensions: ['.txt', '.md', '.markdown', '.pdf', '.docx'],
};

/**
 * The exact accessible names the screen's controls carry.
 *
 * Queried by role and name rather than by class, because every class in the component stylesheets is
 * a hashed CSS Module name and none of them is an interface.
 */
const DESCRIPTION_LABEL = 'Requirements or description';
const DRAFT_LABEL = 'Your draft build prompt';
const FILES_LABEL = 'Choose requirements files to add';
const GENERATE_LABEL = 'Generate draft';
const STOP_LABEL = 'Stop';
const RETRY_LABEL = 'Retry';

/**
 * The sentences `src/components/StatusBanner.tsx` renders in its live region, mirrored here.
 *
 * They are the observable a state is asserted on: the status union is internal, and what a reader
 * actually gets from a transition is the sentence. Wording changed there has to be changed here,
 * which is the intent — the announcement is part of the contract, not an implementation detail.
 *
 * The ones matched as patterns are matched that way because the banner appends to them: a warning
 * list adds a clause, and a cut-off draft adds another, all inside the same sentence.
 */
const IDLE_SENTENCE = 'Ready: add a file or paste requirements, then choose Generate.';
const STREAMING_SENTENCE = /Writing the draft/;
const DONE_SENTENCE = /The draft is ready to edit, copy or download\./;
const ERROR_SENTENCE = /Generation did not finish/;
const STOPPED_SENTENCE = /Generation was stopped/;
const WARNING_CLAUSE = /One note about your input is listed below/;
const PARTIAL_CLAUSE = /It was cut off before the end/;
const CUT_OFF_NOTICE = /cut off at the model output limit/;

/** A description long enough to stand for a real submission. */
const DESCRIPTION = 'A tool that turns requirements documents into a draft build prompt.';

/** The warning sentence the `meta` frame of these cases carries. */
const WARNING = 'sample-requirements.md was dropped: unsupported type';

/** The frame the route handler sends first: what was accepted, refused or shortened. */
const META: MetaEvent = {
  type: 'meta',
  documents: [{ name: 'sample-requirements.md', chars: 120, truncated: false }],
  sourceChars: 120,
  warnings: [WARNING],
  model: 'stub',
};

const DELTA_ONE: DeltaEvent = { type: 'delta', text: '# Build prompt\n\n' };
const DELTA_TWO: DeltaEvent = { type: 'delta', text: '## Overview\n' };
const DELTA_THREE: DeltaEvent = {
  type: 'delta',
  text: 'A tool that turns requirements into a draft.\n',
};

/** The finished draft, in the order the deltas carry it. */
const DRAFT_TEXT = `${DELTA_ONE.text}${DELTA_TWO.text}${DELTA_THREE.text}`;

const DONE: DoneEvent = {
  type: 'done',
  chars: DRAFT_TEXT.length,
  model: 'stub',
  durationMs: 12,
  truncated: false,
};

/** The same terminal frame for a model that hit its own output cap: a partial draft, said so. */
const TRUNCATED_DONE: DoneEvent = { ...DONE, truncated: true };

/**
 * A frame of a kind this version does not know, written as the raw wire text.
 *
 * It is built by hand because `encodeEvent` accepts only the four contracted frames: a frame from a
 * newer writer is exactly what the reader has to survive, and the codec cannot produce one.
 */
const UNKNOWN_FRAME = 'data: {"type":"future"}\n\n';

/** The pre-stream failures the screen can be handed, one per status the route handler returns. */
const FAILURES: ReadonlyArray<{ code: ErrorCode; status: number; message: string }> = [
  {
    code: 'RATE_LIMITED',
    status: 429,
    message: 'Too many requests from this browser. Try again in a few minutes.',
  },
  {
    code: 'PROVIDER_UNAVAILABLE',
    status: 503,
    message: 'The model provider is unavailable, so no draft was generated. Try again shortly.',
  },
];

/** One request the component made, with the parts of it this suite asserts on. */
interface CapturedRequest {
  /** The input `fetch` was handed. The application sends a bare path. */
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
  /** The signal the browser's `fetch` would abort on, so a Stop can be observed at the request. */
  signal: AbortSignal | null;
}

/** What the stub answers one request with, built when that request arrives. */
type FetchBehaviour = () => Response;

/** The `userEvent` instance type, so a helper can take one without naming a dependency's internals. */
type User = ReturnType<typeof userEvent.setup>;

/**
 * Records the request `fetch` was handed.
 *
 * @param input The request input, a path in this application.
 * @param init The request options the component passed.
 * @returns The captured request.
 */
function captureRequest(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  return {
    url,
    method: init?.method ?? 'GET',
    headers: new Headers(init?.headers ?? undefined),
    body: init?.body ?? null,
    signal: init?.signal ?? null,
  };
}

/**
 * Stubs the global `fetch` and records every request the component makes.
 *
 * The nth request is answered by the nth behaviour, and once the behaviours run out the last one
 * answers again, so a Retry can be driven with a fresh response of the same kind. No path here
 * reaches the network.
 *
 * @param behaviours What to answer each request with, in order.
 * @returns The recorded requests, appended to in order, for the assertions to read.
 */
function installFetch(...behaviours: readonly FetchBehaviour[]): CapturedRequest[] {
  const requests: CapturedRequest[] = [];

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const behaviour = behaviours[requests.length] ?? behaviours[behaviours.length - 1];
    requests.push(captureRequest(input, init));

    if (behaviour === undefined) {
      throw new Error('This suite stubbed fetch with no response for the request it received.');
    }

    return Promise.resolve(behaviour());
  });

  return requests;
}

/**
 * Answers one request with the JSON failure envelope the route handler sends before streaming.
 *
 * @param status The HTTP status the failure carries.
 * @param body The envelope: code, user-facing message and retryable flag.
 * @returns The response the component reads as a failure.
 */
function envelopeResponse(status: number, body: GenerateErrorEnvelope): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A streamed response a test writes into by hand.
 *
 * The controller is held in a class field rather than a local, which is the shape TypeScript can see
 * across method calls: a `let` assigned inside the stream's `start` callback is narrowed to `null`
 * at every later use.
 */
class StreamedResponse {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  private readonly encoder = new TextEncoder();

  readonly response: Response;

  constructor() {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });

    this.response = new Response(stream, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  }

  /** Writes one frame through the real codec, so the suite reads only the format the app writes. */
  enqueue(event: GenerationEvent): void {
    this.controller?.enqueue(this.encoder.encode(encodeEvent(event)));
  }

  /** Writes raw wire text, for a frame the codec refuses to encode. */
  pushFrame(frame: string): void {
    this.controller?.enqueue(this.encoder.encode(frame));
  }

  /** Ends the body: what the browser sees when the server's stream closes. */
  close(): void {
    this.controller?.close();
  }
}

/**
 * The multipart body of one recorded request.
 *
 * @param requests The recorded requests.
 * @param index Which request to read, first by default.
 * @returns The posted form data.
 * @throws {Error} When no request was recorded, or its body is not form data.
 */
function postedFormData(requests: readonly CapturedRequest[], index = 0): FormData {
  const request = requests[index];
  if (request === undefined) {
    throw new Error(`The component made no request numbered ${index}.`);
  }
  if (!(request.body instanceof FormData)) {
    throw new Error('The request body was not the multipart form data the server parses.');
  }

  return request.body;
}

/**
 * The abort signal one recorded request carried.
 *
 * @param requests The recorded requests.
 * @param index Which request to read, first by default.
 * @returns The signal handed to `fetch`.
 * @throws {Error} When no request was recorded, or it carried no signal.
 */
function requestSignal(requests: readonly CapturedRequest[], index = 0): AbortSignal {
  const request = requests[index];
  if (request === undefined) {
    throw new Error(`The component made no request numbered ${index}.`);
  }
  if (request.signal === null) {
    throw new Error('The request carried no abort signal.');
  }

  return request.signal;
}

/**
 * The pasted-requirements field.
 *
 * There are two text boxes on this screen, so every text-box query is disambiguated by label; an
 * unqualified one would resolve to both of them.
 */
function requirementsField(): HTMLTextAreaElement {
  const field = screen.getByRole('textbox', { name: DESCRIPTION_LABEL });
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error('The requirements field is not a textarea.');
  }

  return field;
}

/** The draft field, named by its own label. */
function draftField(): HTMLTextAreaElement {
  const field = screen.getByRole('textbox', { name: DRAFT_LABEL });
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error('The draft field is not a textarea.');
  }

  return field;
}

/** The one primary action on the screen. */
function generateButton(): HTMLButtonElement {
  const button = screen.getByRole('button', { name: GENERATE_LABEL });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('The Generate control is not a button.');
  }

  return button;
}

/** The file input, reached by its label: the keyboard path to choosing files. */
function filesInput(): HTMLInputElement {
  const input = screen.getByLabelText(FILES_LABEL);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('The file picker rendered no file input.');
  }

  return input;
}

/**
 * The banner's live region: the one `role="status"` element carrying a sentence.
 *
 * `DraftPanel` renders a second `role="status"` element for its copy confirmation, which stays empty
 * unless a copy is made, so the region with text in it is the status announcement and the empty one
 * is not.
 *
 * @returns The element the screen announces its state through.
 * @throws {Error} When no live region is carrying a sentence.
 */
function statusRegion(): HTMLElement {
  const region = screen
    .getAllByRole('status')
    .find((candidate) => (candidate.textContent ?? '').trim().length > 0);

  if (region === undefined) {
    throw new Error("The status banner's live region was not found or carried no sentence.");
  }

  return region;
}

/**
 * Renders the controller with the server's limits and a stubbed transport.
 *
 * @param behaviours What the stub answers each request with, in order.
 * @returns The recorded requests, and a user ready to interact with the screen.
 */
function setupGenerator(...behaviours: readonly FetchBehaviour[]): {
  user: User;
  requests: CapturedRequest[];
} {
  const user = userEvent.setup();
  const requests = installFetch(...behaviours);
  render(<PromptGenerator limits={LIMITS} />);

  return { user, requests };
}

/** The common case: the first request is answered by a stream the test writes into. */
function setupStreamed(): {
  user: User;
  requests: CapturedRequest[];
  stream: StreamedResponse;
} {
  const stream = new StreamedResponse();
  const { user, requests } = setupGenerator(() => stream.response);

  return { user, requests, stream };
}

/**
 * Writes frames into the open stream and lets React settle what they changed.
 *
 * The read loop dispatches each frame from a microtask, outside the click that started the request,
 * so the state update needs `act` to cover it; the assertions that follow then wait for the DOM to
 * show the result rather than for a duration to pass.
 *
 * @param stream The stream the component is reading.
 * @param frames The frames to write, in order.
 */
async function emit(
  stream: StreamedResponse,
  ...frames: readonly GenerationEvent[]
): Promise<void> {
  await act(async () => {
    for (const frame of frames) {
      stream.enqueue(frame);
    }
  });
}

/**
 * Types a description and presses Generate, leaving the request in flight.
 *
 * @param user The user driving the screen.
 * @param description The text to type.
 */
async function submit(user: User, description: string = DESCRIPTION): Promise<void> {
  await user.type(requirementsField(), description);
  await user.click(generateButton());
}

describe('PromptGenerator', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the typed description as one multipart request to the generation endpoint', async () => {
    const { user, requests, stream } = setupStreamed();

    await submit(user);

    const request = requests[0];
    if (request === undefined) {
      throw new Error('The component made no request.');
    }

    expect(new URL(request.url, 'http://localhost').pathname).toBe('/api/generate');
    expect(request.method).toBe('POST');
    // The runtime writes the multipart content type itself, boundary and all: a header set by hand
    // would leave the boundary out and the server unable to parse the body.
    expect(request.headers.has('content-type')).toBe(false);

    const body = postedFormData(requests);
    expect(body.get('description')).toBe(DESCRIPTION);
    expect(body.getAll('files')).toHaveLength(0);

    // The stream is driven to its terminal frame so the request this test started does not outlive it.
    await emit(stream, META, DELTA_ONE, DONE);
  });

  it('shows the first delta while the response is still open, then the whole draft once it ends', async () => {
    const { user, stream } = setupStreamed();

    await submit(user);
    await emit(stream, META, DELTA_ONE);

    // Partial text is on screen with the stream still open, which is the whole point of streaming it.
    await waitFor(() => {
      expect(draftField()).toHaveValue(DELTA_ONE.text);
    });
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent(STREAMING_SENTENCE);
    });
    expect(screen.getByRole('button', { name: STOP_LABEL })).toBeInTheDocument();
    expect(screen.queryByText(DONE_SENTENCE)).not.toBeInTheDocument();

    await emit(stream, DELTA_TWO, DELTA_THREE, DONE);

    await waitFor(() => {
      expect(draftField()).toHaveValue(DRAFT_TEXT);
    });
  });

  it('lists the warnings the meta frame carried beside the status', async () => {
    const { user, stream } = setupStreamed();

    await submit(user);
    await emit(stream, META);

    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    expect(await screen.findByText(WARNING_CLAUSE)).toBeInTheDocument();
  });

  it('reports the finished draft, its character count and the ready status after the terminal frame', async () => {
    const { user, stream } = setupStreamed();

    await submit(user);
    await emit(stream, META, DELTA_ONE, DELTA_TWO, DELTA_THREE, DONE);

    await waitFor(() => {
      expect(draftField()).toHaveValue(DRAFT_TEXT);
    });
    expect(screen.getByText(`${DRAFT_TEXT.length} characters`)).toBeInTheDocument();
    expect(await screen.findByText(DONE_SENTENCE)).toBeInTheDocument();
    // Stop belongs to a generation in progress, so it is gone once this one has finished.
    expect(screen.queryByRole('button', { name: STOP_LABEL })).not.toBeInTheDocument();
  });

  it('says the draft is partial when the terminal frame reports the model was cut off', async () => {
    const { user, stream } = setupStreamed();

    await submit(user);
    await emit(stream, META, DELTA_ONE, DELTA_TWO, TRUNCATED_DONE);

    expect(await screen.findByText(PARTIAL_CLAUSE)).toBeInTheDocument();
    expect(screen.getByText(CUT_OFF_NOTICE)).toBeInTheDocument();
    // The draft is still there and still editable: a partial draft is not a failure.
    expect(draftField()).toHaveValue(`${DELTA_ONE.text}${DELTA_TWO.text}`);
  });

  it('moves focus into the draft field when the generation completes', async () => {
    const { user, stream } = setupStreamed();

    await submit(user);
    await emit(stream, META, DELTA_ONE, DONE);

    await waitFor(() => {
      expect(document.activeElement).toBe(draftField());
    });
  });

  it.each(FAILURES)(
    'shows the $code message inside an alert, keeps the description and offers Retry',
    async ({ code, status, message }) => {
      const envelope: GenerateErrorEnvelope = { code, message, retryable: true };
      const { user, requests } = setupGenerator(() => envelopeResponse(status, envelope));

      await submit(user);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(message);
      expect(screen.getByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
      expect(await screen.findByText(ERROR_SENTENCE)).toBeInTheDocument();
      // The failure costs the user nothing: the inputs are exactly as submitted, so Retry re-sends
      // what they typed rather than asking them to type it again.
      expect(requirementsField()).toHaveValue(DESCRIPTION);
      expect(requests).toHaveLength(1);
    },
  );

  it('offers no Retry when the failure is one the same submission cannot get past', async () => {
    const envelope: GenerateErrorEnvelope = {
      code: 'INVALID_INPUT',
      message:
        'Nothing usable was submitted, so there was nothing to generate from. Add a file or a description.',
      retryable: false,
    };
    const { user } = setupGenerator(() => envelopeResponse(400, envelope));

    await submit(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(envelope.message);
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).not.toBeInTheDocument();
  });

  it('sends the inputs again on Retry and fills the draft from the second response', async () => {
    const stream = new StreamedResponse();
    const envelope: GenerateErrorEnvelope = {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The model provider is unavailable, so no draft was generated. Try again shortly.',
      retryable: true,
    };
    const { user, requests } = setupGenerator(
      () => envelopeResponse(503, envelope),
      () => stream.response,
    );

    await submit(user);
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(postedFormData(requests, 1).get('description')).toBe(DESCRIPTION);

    await emit(stream, META, DELTA_ONE, DONE);

    await waitFor(() => {
      expect(draftField()).toHaveValue(DELTA_ONE.text);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByText(DONE_SENTENCE)).toBeInTheDocument();
  });

  it('aborts the request in flight on Stop and returns to idle, keeping what was written', async () => {
    const { user, requests, stream } = setupStreamed();

    await submit(user);
    await emit(stream, META, DELTA_ONE);
    await waitFor(() => {
      expect(draftField()).toHaveValue(DELTA_ONE.text);
    });

    await user.click(screen.getByRole('button', { name: STOP_LABEL }));

    // The signal is the one `fetch` was handed, and the server propagates the same abort to the model
    // call, so what stops is the generation being billed rather than only its rendering.
    expect(requestSignal(requests).aborted).toBe(true);
    expect(await screen.findByText(STOPPED_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: STOP_LABEL })).not.toBeInTheDocument();
    expect(generateButton()).toBeEnabled();
    expect(draftField()).toHaveValue(DELTA_ONE.text);
  });

  it('reports a stream that ends before its terminal frame as a failure, not a finished draft', async () => {
    const { user, stream } = setupStreamed();

    await submit(user);
    await emit(stream, META, DELTA_ONE);
    await waitFor(() => {
      expect(draftField()).toHaveValue(DELTA_ONE.text);
    });

    await act(async () => {
      stream.close();
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/ended before the draft finished/i);
    expect(await screen.findByText(ERROR_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(DONE_SENTENCE)).not.toBeInTheDocument();
  });

  it('skips a frame whose type it does not know and still completes on the terminal frame', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { user, stream } = setupStreamed();

    await submit(user);
    await emit(stream, META, DELTA_ONE);
    await act(async () => {
      stream.pushFrame(UNKNOWN_FRAME);
    });
    await emit(stream, DONE);

    await waitFor(() => {
      expect(draftField()).toHaveValue(DELTA_ONE.text);
    });
    expect(await screen.findByText(DONE_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The codec reports the frame it skipped; the warning is silenced above to keep output readable.
    expect(warn).toHaveBeenCalled();
  });

  it('offers Generate only once there is something to send, enabling it as soon as a description is typed', async () => {
    const { user } = setupStreamed();

    expect(generateButton()).toBeDisabled();

    await user.type(requirementsField(), DESCRIPTION);

    expect(generateButton()).toBeEnabled();
  });

  it('enables Generate when only a file is chosen, with nothing typed', async () => {
    const { user } = setupStreamed();

    expect(generateButton()).toBeDisabled();

    await user.upload(
      filesInput(),
      new File(['# Requirements\n'], 'notes.md', { type: 'text/markdown' }),
    );

    expect(await screen.findByText('notes.md')).toBeInTheDocument();
    expect(generateButton()).toBeEnabled();
  });

  it('sends a chosen file as a repeating part of the same multipart request', async () => {
    const { user, requests, stream } = setupStreamed();

    await user.upload(
      filesInput(),
      new File(['# Requirements\n'], 'notes.md', { type: 'text/markdown' }),
    );
    await user.click(generateButton());

    const body = postedFormData(requests);
    const parts = body.getAll('files');
    expect(parts).toHaveLength(1);
    const part = parts[0];
    if (!(part instanceof File)) {
      throw new Error('The chosen file was not sent as a file part.');
    }
    expect(part.name).toBe('notes.md');
    // A file on its own is a complete submission: the description field stays empty and is still sent.
    expect(body.get('description')).toBe('');

    await emit(stream, META, DELTA_ONE, DONE);
  });

  it('names both fields by their own labels and announces the status in a polite live region', () => {
    setupStreamed();

    expect(requirementsField()).toHaveAccessibleName(DESCRIPTION_LABEL);
    expect(draftField()).toHaveAccessibleName(DRAFT_LABEL);
    expect(generateButton()).toHaveAccessibleName(GENERATE_LABEL);
    expect(statusRegion()).toHaveAttribute('aria-live', 'polite');
    expect(statusRegion()).toHaveTextContent(IDLE_SENTENCE);
  });

  it('renders the instruction line verbatim exactly once', () => {
    setupStreamed();

    // The page shell renders the same sentence and guards against rendering it twice; this is the
    // controller's own half of that agreement, and the guard belongs to both.
    expect(screen.getAllByText(INSTRUCTION_LINE)).toHaveLength(1);
  });
});

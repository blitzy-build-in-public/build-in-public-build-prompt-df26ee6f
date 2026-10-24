/**
 * `POST /api/generate` — the product's only endpoint and its only trust boundary.
 *
 * One request carries the pasted requirements and up to five uploaded files; this handler validates
 * them, extracts their text, assembles the source the model receives, takes the per-source rate
 * limit, and answers with a `text/event-stream` body that carries the draft while it is written. The
 * sequence here is composition only: every step belongs to the module that owns it, and nothing in
 * this file restates a limit, a user-facing sentence, a frame's grammar, a provider setting or the
 * shape of a log line.
 *
 * Three properties of this file are contract rather than style:
 *
 * - **One rule decides a breach.** A request-level violation fails the request: a body past
 *   `MAX_REQUEST_BYTES` (413, refused from `Content-Length` before the body is read), a pasted
 *   description past its cap, or a submission with nothing usable in it (both 400). A file-level
 *   violation is a warning on the response and the rest of the submission still generates.
 * - **Exactly one terminal frame.** A stream carries one `meta`, then `delta` frames, then exactly
 *   one `done` or `error`. The terminal frame has a single write site below, so the invariant holds
 *   structurally instead of being monitored.
 * - **Stateless.** Nothing here survives the request: no module-level mutable state, no memoised
 *   provider, no cache, no environment read. The only cross-request state in the process is the rate
 *   limiter's, which a second instance of this deployment needs no coordination to use.
 *
 * Every completed request — a finished stream, a failure before it, or a client's Stop — writes one
 * metadata-only line through `@/lib/log`, whose entry type has no field able to carry user text.
 */

import { AppError, toErrorEnvelope } from '@/lib/errors';
import { extractDocument } from '@/lib/extract';
import { logRequest } from '@/lib/log';
import { MAX_OUTPUT_TOKENS, getProvider, type Provider } from '@/lib/provider';
import { SYSTEM_INSTRUCTION, renderInput } from '@/lib/prompt';
import { checkRateLimit, resolveRateLimitKey } from '@/lib/rate-limit';
import { buildSourceBundle } from '@/lib/source';
import { KEEPALIVE_INTERVAL_MS, MIN_WRITE_BYTES, PING_FRAME, encodeEvent } from '@/lib/sse';
import {
  GENERATION_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  type SubmittedFile,
  validateSubmission,
} from '@/lib/validation';
import type {
  BuildPromptRequest,
  ErrorCode,
  ExtractedDocument,
  GenerationEvent,
  MetaEvent,
  ProviderEvent,
  RejectedDocument,
  SourceBundle,
} from '@/types';

/** The endpoint's own label for the one metadata line each completed request writes. */
const ROUTE = '/api/generate';

/** The multipart field carrying the pasted requirements. */
const DESCRIPTION_FIELD = 'description';

/** The multipart field carrying uploads; the browser repeats it once per file. */
const FILES_FIELD = 'files';

/** The status a streamed response is committed with, before any frame exists. */
const STREAM_STATUS = 200;

/**
 * The headers of a streamed response.
 *
 * No `Content-Length` is sent: the body's length is unknown when the headers are written, and stating
 * one would make a progressive response impossible. `no-transform` and `X-Accel-Buffering` are what
 * keep an intermediary from holding frames back while it waits for more of the body.
 */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
} as const;

/**
 * What the user is told when the multipart body itself cannot be read.
 *
 * The envelope's own `INVALID_INPUT` sentence describes a submission with nothing usable in it, which
 * is a different situation from a body the server could not parse at all, so this case names the one
 * action that resolves it.
 */
const UNREADABLE_BODY_MESSAGE =
  'The request body could not be read. Please send the description and files again.';

/**
 * The value {@link nextOrAbort} returns when the signal aborted before the provider produced a step.
 */
const ABORTED = 'aborted';

/** The sentinel's type, so the race's result narrows on the value it carries. */
type AbortSentinel = typeof ABORTED;

/** One step of the provider's iteration. */
type ProviderStep = IteratorResult<ProviderEvent>;

/**
 * The Node.js runtime, which the document extractors require: `unpdf` and `mammoth` are Node
 * libraries, and a PDF or `.docx` upload cannot be read anywhere else.
 */
export const runtime = 'nodejs';

/**
 * The generation deadline as the hosting layer understands it.
 *
 * This is a hint that stops a platform killing the invocation before the handler can finish writing
 * its terminal frame; it is not what enforces the bound. The deadline itself is the handler's own
 * (`GENERATION_TIMEOUT_MS`), which aborts the provider call and writes the `GENERATION_TIMEOUT` frame
 * that tells the user what happened.
 */
export const maxDuration = 90;

/**
 * Handle one generation request.
 *
 * The whole pre-stream sequence runs in one `try`, ordered so that nothing is spent before the input
 * is known to be usable: refuse an over-limit `Content-Length` before the body is read, read the two
 * form fields, validate the submission under the one breach rule, extract each accepted file,
 * assemble the source under its budget, refuse a submission with nothing usable in it, take the
 * per-source rate limit, and only then select a provider and take the first event of its stream.
 *
 * That first event is taken before the response is committed, deliberately: the failure table answers
 * a provider that refused or failed *before* the first token with 503 `PROVIDER_UNAVAILABLE`, and no
 * status code can carry that once the stream's status line is on the wire.
 *
 * Anything that fails before that point becomes the JSON error envelope with its status. Everything
 * afterwards travels in the stream, which always ends on exactly one terminal frame. The handler owns
 * the generation deadline, combines it with the client's own signal, hands the combination to the
 * provider, and writes the terminal `GENERATION_TIMEOUT` frame itself when the deadline ended the
 * generation.
 *
 * @param request The incoming request: its `Content-Length`, its multipart body, its abort signal and
 *   the connection identity the rate limiter resolves. No other part of it is consulted.
 * @returns The streamed response once generation has begun, or the JSON error envelope when the
 *   request failed before the stream started.
 */
export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();

  // The facts the one log line carries, held in locals so that every exit path can report them: the
  // bundle is absent until the source is assembled, and the model until a provider is selected.
  let bundle: SourceBundle | undefined;
  let rejectedCount = 0;
  let model: string | undefined;
  let generation: Generation | undefined;

  /**
   * Write this request's one metadata line, whatever the request did.
   *
   * @param status The status the response carries, or the one it was committed with when a streamed
   *   response failed after its headers were sent.
   * @param errorCode The terminal frame's failure code, or the envelope's, when there was one.
   */
  const writeLog = (status: number, errorCode?: ErrorCode): void => {
    logRequest({
      route: ROUTE,
      status,
      durationMs: Date.now() - startedAt,
      sourceChars: bundle?.sourceChars ?? 0,
      documentCount: bundle?.documents.length ?? 0,
      rejectedCount,
      truncatedCount: bundle?.documents.filter((document) => document.truncated).length ?? 0,
      model,
      errorCode,
    });
  };

  try {
    const declaredLength = readContentLength(request.headers.get('content-length'));
    if (declaredLength !== null && declaredLength > MAX_REQUEST_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE');
    }

    const form = await readForm(request);
    const description = readDescription(form);
    const { accepted, rejected } = validateSubmission(description, await readFiles(form));

    // Extraction runs over the accepted list in upload order and the outcomes are read back in the
    // same order, so the source budget spends itself on the same documents however often the same
    // submission is sent.
    const outcomes = await Promise.all(accepted.map((file) => extractDocument(file)));
    const documents: ExtractedDocument[] = [];
    const refused: RejectedDocument[] = [...rejected];

    for (const outcome of outcomes) {
      if (isRejected(outcome)) {
        refused.push(outcome);
      } else {
        documents.push(outcome);
      }
    }

    // Every file-level refusal travels on inside the bundle, so the first frame tells the user
    // everything that was learned about their submission at once.
    rejectedCount = refused.length;
    bundle = buildSourceBundle(description, documents, refused);

    // Request-level, and therefore fatal: a submission can pass validation and still have every
    // accepted file extract to nothing — a scanned PDF, or a file of blank lines — and that must not
    // cost a model call.
    if (bundle.sourceChars === 0) {
      throw new AppError('INVALID_INPUT');
    }

    const decision = checkRateLimit(resolveRateLimitKey(request));
    if (!decision.allowed) {
      // The reset time is what makes the refusal actionable, and the sentence that states it is
      // built from `resetAt` inside the errors module, so no user-facing text is written here.
      throw new AppError('RATE_LIMITED', { resetAt: decision.resetAt });
    }

    const provider = getProvider();
    model = provider.model;

    const deadline = beginGeneration(request.signal);
    generation = deadline;

    const providerRequest: BuildPromptRequest = {
      model: provider.model,
      // The trusted instruction and the rendered untrusted source travel in separate fields of the
      // request. They are never concatenated: document text must not reach the instruction role.
      instructions: SYSTEM_INSTRUCTION,
      input: renderInput(bundle),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };

    const opened = await openGeneration(provider, providerRequest, deadline.signal);

    return streamDraft({
      request,
      bundle,
      iterator: opened.iterator,
      firstStep: opened.firstStep,
      generation: deadline,
      model: provider.model,
      startedAt,
      report: (errorCode) => writeLog(STREAM_STATUS, errorCode),
    });
  } catch (error) {
    // One conversion for every pre-stream failure: the envelope's status is what the response
    // carries, and its code is what the log line records. Nothing has been written to the client yet
    // on this path, so no stream is opened with the SSE headers.
    generation?.dispose();

    const { status, body } = toErrorEnvelope(error);
    writeLog(status, body.code);

    return Response.json(body, { status });
  }
}

/**
 * Whether an extraction outcome is a refusal rather than a document.
 *
 * The two are told apart by `reason`, which only a refusal carries: every member of `RejectionReason`
 * is a file-level violation, so a refusal becomes a warning and never fails the request.
 *
 * @param outcome What `extractDocument` returned for one accepted file.
 * @returns True when the file could not contribute text.
 */
function isRejected(outcome: ExtractedDocument | RejectedDocument): outcome is RejectedDocument {
  return 'reason' in outcome;
}

/**
 * The declared length of the request body, when the header carries a number.
 *
 * A header that is absent or unparsable yields `null`, which skips the pre-flight check rather than
 * failing the request. The specification requires the header for that check, and every per-field and
 * per-file cap still applies without it, so a submission that omits it is limited by exactly the same
 * rules as one that sends it, while failing on its absence would refuse a request whose size nothing
 * had established. Reading that gap in the specification this way is recorded rather than left
 * implicit.
 *
 * @param header The `Content-Length` header as received, or `null` when the request carried none.
 * @returns The declared length, or `null` when there was none to read.
 */
function readContentLength(header: string | null): number | null {
  const value = header?.trim() ?? '';
  if (value === '') {
    return null;
  }

  const length = Number(value);

  return Number.isFinite(length) ? length : null;
}

/**
 * Read the request's multipart body.
 *
 * Parsing the body is an external boundary, and a body that cannot be parsed is broken client input
 * rather than a failure of this server: it is answered as a 400 naming what to send again instead of
 * degrading to a 500 that tells the user nothing about what to do.
 *
 * @param request The incoming request.
 * @returns The parsed form data.
 * @throws {AppError} With code `INVALID_INPUT` when the body is not a readable multipart form.
 */
async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new AppError('INVALID_INPUT', { message: UNREADABLE_BODY_MESSAGE });
  }
}

/**
 * The pasted requirements, or the empty string when the submission carries none.
 *
 * Only a string part is read: a file sent under the description's field name is not a description, and
 * treating it as one would put file content where the user believes their own words are.
 *
 * @param form The parsed multipart body.
 * @returns The pasted text, or `''`.
 */
function readDescription(form: FormData): string {
  const entry = form.get(DESCRIPTION_FIELD);

  return typeof entry === 'string' ? entry : '';
}

/**
 * Whether one multipart part is an uploaded file rather than a plain text field.
 *
 * The brand check stands in for `instanceof File` deliberately, and it is what keeps uploads from
 * being dropped in silence. `request.formData()` builds its entries with the runtime's own `File`,
 * while this module sees whichever global its environment installed — under a DOM test environment
 * those are two different classes, so a part that is exactly a file fails `instanceof` while carrying
 * the same two members this handler reads. The brand is the one thing every File shares, and a parsed
 * multipart body cannot forge it.
 *
 * @param part One entry of the parsed multipart body.
 * @returns True when the entry is an uploaded file.
 */
function isFilePart(part: FormDataEntryValue): part is File {
  return typeof part !== 'string' && Object.prototype.toString.call(part) === '[object File]';
}

/**
 * The uploaded files, in the order the browser sent them.
 *
 * The client-declared MIME type is deliberately not read: kind is decided in the validation module
 * from the extension allow-list and then confirmed from the leading bytes, so a mislabelled file is
 * refused rather than routed to a parser that cannot read it.
 *
 * @param form The parsed multipart body.
 * @returns One entry per file part, each with the name it was sent under and its bytes.
 */
async function readFiles(form: FormData): Promise<SubmittedFile[]> {
  const files: SubmittedFile[] = [];

  for (const part of form.getAll(FILES_FIELD)) {
    if (!isFilePart(part)) {
      continue;
    }

    files.push({ name: part.name, bytes: new Uint8Array(await part.arrayBuffer()) });
  }

  return files;
}

/**
 * The one abort mechanism for a generation, and the generation's deadline.
 *
 * The handler owns the deadline rather than the provider or the hosting platform: one controller is
 * aborted by a timer at `GENERATION_TIMEOUT_MS`, its signal is combined with the client's own, and the
 * combination is what the provider call receives — so a Stop and the deadline both reach the upstream
 * request through a single mechanism.
 */
interface Generation {
  /** The combined signal: aborted by the client's signal or by the deadline. */
  signal: AbortSignal;
  /**
   * Whether the deadline is what ended the generation.
   *
   * A Stop that arrives after the deadline is reported as the Stop it is, so the client's own signal
   * is tested first.
   */
  timedOut: () => boolean;
  /** Clears the deadline, so a finished request leaves no pending timer behind. */
  dispose: () => void;
}

/**
 * Start the generation's deadline and combine it with the client's signal.
 *
 * @param requestSignal The signal of the request being handled — a Stop in the browser.
 * @returns The combined signal, the deadline test, and the disposer that clears the timer.
 */
function beginGeneration(requestSignal: AbortSignal): Generation {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), GENERATION_TIMEOUT_MS);

  return {
    signal: AbortSignal.any([requestSignal, deadline.signal]),
    timedOut: () => deadline.signal.aborted && !requestSignal.aborted,
    dispose: () => clearTimeout(timer),
  };
}

/**
 * Wait for one provider step, or for the generation's signal, whichever settles first.
 *
 * Both provider implementations return once the signal aborts, so a pending step normally settles on
 * an abort by itself. Racing the signal here as well is what makes the deadline this handler's own: a
 * provider that does not watch the signal cannot hold the stream open past it, and a Stop takes effect
 * while a step is still pending rather than after the next one arrives. The losing promise's rejection
 * is claimed, so an abort cannot resurface later as an unhandled rejection.
 *
 * @param pending The provider's next step.
 * @param signal The combined Stop-and-deadline signal.
 * @returns The step, or {@link ABORTED} when the signal aborted first.
 */
function nextOrAbort(
  pending: Promise<ProviderStep>,
  signal: AbortSignal,
): Promise<ProviderStep | AbortSentinel> {
  if (signal.aborted) {
    void pending.catch(() => undefined);

    return Promise.resolve(ABORTED);
  }

  let detach: () => void = () => undefined;
  const aborted = new Promise<AbortSentinel>((resolve) => {
    const listener = (): void => resolve(ABORTED);
    signal.addEventListener('abort', listener, { once: true });
    detach = () => signal.removeEventListener('abort', listener);
  });

  return Promise.race([pending, aborted]).finally(detach);
}

/**
 * Classify a failure that came out of the provider call.
 *
 * The provider raises `PROVIDER_UNAVAILABLE` for a call it refused, failed, or saw end without a
 * terminal event, which is the right code while a status can still carry it — 503 — and the wrong one
 * once the response's status line has gone out. So the phase decides the code: the failure keeps
 * `PROVIDER_UNAVAILABLE` before the first token, and becomes `PROVIDER_ERROR`, the contract's code for
 * "the provider failed after streaming began", after it. A failure raised as an `AppError` keeps its
 * sentence, because those sentences are written for the person on screen and name the next action;
 * anything else gets the code's own sentence rather than being reported as an unexplained internal
 * failure.
 *
 * @param error The caught value, exactly as the `catch` bound it.
 * @param code The code for this phase: `PROVIDER_UNAVAILABLE` before the first token, otherwise
 *   `PROVIDER_ERROR`.
 * @returns The failure to report, carrying the code, the sentence and the retryable flag.
 */
function asProviderFailure(
  error: unknown,
  code: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR',
): AppError {
  if (error instanceof AppError) {
    return new AppError(code, { message: error.message, retryable: error.retryable });
  }

  return new AppError(code);
}

/**
 * Open the provider's stream and take its first event.
 *
 * The first event is taken here, before the response is committed, because the failure table answers a
 * provider that refused or failed *before* the first token with 503 — and once the stream's status
 * line is on the wire no status can be sent, so a failure at this point could only be reported as a
 * mid-stream `error` frame instead of the 503 it is.
 *
 * An abort is not a failure. The handler reports the Stop it was given or the deadline it set itself,
 * so an aborted wait returns with no step taken and lets the stream open and write the terminal frame
 * that answers it.
 *
 * @param provider The selected provider.
 * @param request The provider-facing request: the trusted instruction, the rendered source, the model
 *   and the output cap.
 * @param signal The combined Stop-and-deadline signal.
 * @returns The open iterator, and its first step — or `null` for the step when the signal aborted
 *   before the provider produced one.
 * @throws {AppError} With code `PROVIDER_UNAVAILABLE` for a provider that refused or failed before the
 *   first token.
 */
async function openGeneration(
  provider: Provider,
  request: BuildPromptRequest,
  signal: AbortSignal,
): Promise<{ iterator: AsyncIterator<ProviderEvent>; firstStep: ProviderStep | null }> {
  let iterator: AsyncIterator<ProviderEvent>;

  try {
    iterator = provider.generate(request, signal)[Symbol.asyncIterator]();
  } catch (error) {
    throw asProviderFailure(error, 'PROVIDER_UNAVAILABLE');
  }

  try {
    const step = await nextOrAbort(iterator.next(), signal);

    return { iterator, firstStep: step === ABORTED ? null : step };
  } catch (error) {
    if (signal.aborted) {
      return { iterator, firstStep: null };
    }

    throw asProviderFailure(error, 'PROVIDER_UNAVAILABLE');
  }
}

/**
 * Everything a streamed generation needs once its response has been committed.
 */
interface DraftStream {
  /** The request, read only for its abort signal: that is how a Stop reaches this stream. */
  request: Request;
  /** The assembled source: its documents, character count and warnings are the first frame. */
  bundle: SourceBundle;
  /** The provider's events, already advanced past the first one. */
  iterator: AsyncIterator<ProviderEvent>;
  /** The first step of that iteration, or `null` when the signal aborted before it was produced. */
  firstStep: ProviderStep | null;
  /** The one abort mechanism, so a Stop and the deadline reach the provider and this stream. */
  generation: Generation;
  /** The model the draft is written with, named in the first and the last frame. */
  model: string;
  /** Handler entry, so the terminal frame can report the whole request's duration. */
  startedAt: number;
  /**
   * Writes this request's one log line. Called once, when the stream has ended, with the terminal
   * failure's code when the stream ended on an `error` frame.
   */
  report: (errorCode?: ErrorCode) => void;
}

/**
 * Commit the response and hand its body to the writer task.
 *
 * The response is returned before any frame exists, which is what makes the draft arrive
 * progressively: the status line and the headers reach the browser while the model is still writing.
 *
 * @param input Everything the stream needs; see {@link DraftStream}.
 * @returns The 200 response whose body is the generation stream.
 */
function streamDraft(input: DraftStream): Response {
  const body = new TransformStream<Uint8Array, Uint8Array>();
  const response = new Response(body.readable, { status: STREAM_STATUS, headers: SSE_HEADERS });

  // The task runs beside the response rather than before it, so returning this response commits the
  // headers immediately. It handles every failure of its own and never rejects.
  void writeDraft(input, body.writable.getWriter());

  return response;
}

/**
 * Write the draft to the response body as the provider produces it.
 *
 * Nothing here throws: a failure becomes the stream's terminal frame, and a consumer that has gone is
 * left alone rather than reported.
 *
 * @param input Everything the stream needs; see {@link DraftStream}.
 * @param writer The response body's writer. It is closed on every path, so no consumer is left waiting
 *   for a stream that has stopped producing.
 */
async function writeDraft(
  input: DraftStream,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const { bundle, generation, iterator, model, report, request, startedAt } = input;
  const encoder = new TextEncoder();

  // The text that has arrived but is not yet on the wire, and its encoded size. Coalescing deltas here
  // is what keeps every write above the floor a browser needs before it hands the text to the reader;
  // `chars` is the whole draft's length, which is what the terminal frame reports.
  let pending = '';
  let pendingBytes = 0;
  let chars = 0;
  let truncated = false;

  let consumerGone = false;
  let failure: unknown = null;
  let finished = false;
  let lastWriteAt = Date.now();

  /**
   * Put one whole frame on the wire, and note when it went.
   *
   * A write that fails means the consumer is gone — a Stop, a closed tab, a dead connection — not that
   * this handler failed, so it stops the stream rather than being reported.
   *
   * @param frame A complete frame, encoded by {@link encodeEvent} or {@link PING_FRAME}.
   */
  const write = async (frame: string): Promise<void> => {
    lastWriteAt = Date.now();
    if (consumerGone) {
      return;
    }

    try {
      await writer.write(encoder.encode(frame));
    } catch {
      consumerGone = true;
    }
  };

  /** Write the text that has accumulated as one `delta` frame. */
  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }

    const text = pending;
    pending = '';
    pendingBytes = 0;
    await write(encodeEvent({ type: 'delta', text }));
  };

  /**
   * Take one provider event, writing a frame once the pending text reaches the write floor.
   *
   * @param event One event from the provider.
   */
  const consume = async (event: ProviderEvent): Promise<void> => {
    if (event.type === 'truncated') {
      // The model was cut off at its output cap, so the draft is partial. This is the only thing that
      // sets the flag: the iteration ending is not evidence of an incomplete response, because it ends
      // normally on a completion, an incompletion and an abort alike.
      truncated = true;
      return;
    }

    chars += event.text.length;
    pending += event.text;
    // Measured in bytes rather than code units: what a browser buffers is bytes, and an astral
    // character costs one code unit more than the two it is made of.
    pendingBytes += encoder.encode(event.text).byteLength;

    if (pendingBytes >= MIN_WRITE_BYTES) {
      await flush();
    }
  };

  // A stream that says nothing while the model thinks is liable to be closed by an intermediary that
  // reads the silence as an idle connection, so a comment frame goes out whenever a whole interval has
  // passed without any other write.
  const keepalive = setInterval(() => {
    if (consumerGone || Date.now() - lastWriteAt < KEEPALIVE_INTERVAL_MS) {
      return;
    }

    void write(PING_FRAME);
  }, KEEPALIVE_INTERVAL_MS);

  try {
    // A Stop means the consumer has already gone: there is nobody left to receive a first frame or a
    // terminal one, so nothing is written at all.
    if (!request.signal.aborted) {
      const meta: MetaEvent = {
        type: 'meta',
        documents: bundle.documents.map((document) => ({
          name: document.name,
          chars: document.chars,
          truncated: document.truncated,
        })),
        sourceChars: bundle.sourceChars,
        warnings: bundle.warnings,
        model,
      };
      await write(encodeEvent(meta));

      // The first event was taken before this response was committed, and it is written after `meta`
      // so the frame order the contract describes holds from the very first byte.
      if (input.firstStep !== null && input.firstStep.done !== true) {
        await consume(input.firstStep.value);
      }

      while (!generation.signal.aborted && !consumerGone) {
        const step = await nextOrAbort(iterator.next(), generation.signal);
        if (step === ABORTED) {
          break;
        }

        if (step.done === true) {
          finished = true;
          break;
        }

        await consume(step.value);
      }
    }
  } catch (error) {
    // The loop only awaits the provider, so a failure here came from upstream. It is reported as the
    // terminal frame below: the status line went out with the response.
    failure = error;
  } finally {
    clearInterval(keepalive);
    generation.dispose();
    releaseUpstream(iterator);
  }

  const done: GenerationEvent = {
    type: 'done',
    chars,
    model,
    durationMs: Date.now() - startedAt,
    truncated,
  };

  // The stream's one terminal frame, and the only place one is written. A generation that timed out
  // is reported as a timeout even when the provider simply stopped producing steps, and a Stop leaves
  // nothing to report at all.
  const terminal: GenerationEvent =
    failure !== null
      ? terminalError(asProviderFailure(failure, 'PROVIDER_ERROR'))
      : generation.timedOut() && !finished
        ? terminalError(new AppError('GENERATION_TIMEOUT'))
        : done;

  if (!consumerGone && !request.signal.aborted) {
    // The remainder of the draft is flushed immediately before the terminal frame, so no text the
    // model produced is lost to the write floor.
    await flush();
  }

  // The one metadata line for this request, written before the terminal frame rather than after it:
  // a write resolves only once a consumer has taken the frame, so a reader that has seen the stream
  // end could otherwise observe the request as unlogged.
  report(terminal.type === 'error' ? terminal.code : undefined);

  if (!consumerGone && !request.signal.aborted) {
    await write(encodeEvent(terminal));
  }

  await closeWriter(writer);
}

/**
 * The terminal `error` frame for a failure, taking its three fields from the errors module.
 *
 * @param error The classified failure, which fixes the code, the sentence and the retryable flag.
 * @returns The frame to write.
 */
function terminalError(error: AppError): GenerationEvent {
  return { type: 'error', ...toErrorEnvelope(error).body };
}

/**
 * End the response body and release its writer, whatever state the consumer is in.
 *
 * A close after a cancellation, and a second close, are reported as rejections rather than thrown out
 * of the stream; they are swallowed because there is nothing left to deliver and no consumer to tell.
 *
 * @param writer The response body's writer.
 */
async function closeWriter(writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  try {
    await writer.close();
  } catch {
    // The consumer is gone, or the stream is already closed.
  }

  try {
    writer.releaseLock();
  } catch {
    // A write was still outstanding when the consumer vanished, so the lock cannot be released.
  }
}

/**
 * Release the provider's stream without waiting on it.
 *
 * The upstream request is abandoned as soon as this stream stops reading, so a draft nobody will
 * receive stops being generated. The release is not awaited because a generator that is mid-await when
 * it is released must not be able to hold the response open, and its failure is swallowed for the same
 * reason.
 *
 * @param iterator The provider's iterator.
 */
function releaseUpstream(iterator: AsyncIterator<ProviderEvent>): void {
  try {
    const released = iterator.return?.();
    if (released !== undefined) {
      void released.catch(() => undefined);
    }
  } catch {
    // A generator that refuses to be released holds nothing this handler still needs.
  }
}

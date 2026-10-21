/**
 * The application's single shared contract module.
 *
 * The request-scoped structures and the wire events of the Build Prompt Generator are declared here
 * and nowhere else, so the server tier and the browser tier cannot drift apart. The module is
 * types-only: it carries no imports and no runtime declaration of any kind, so importing it adds
 * nothing to the browser bundle and either tier may do so. The server-only modules (`validation`,
 * `extract`, `source`, `prompt`, `provider`, `rate-limit`, `errors`, `log`) and the client-safe
 * ones (`sse`, `components/**`) all import from here.
 *
 * The relationship chain, which is the whole of it — nothing is persisted, so there is no entity
 * graph and no identity to manage:
 *
 * - `AcceptedFile` (0..5) becomes an `ExtractedDocument` (0..5), with a `RejectedDocument` carrying
 *   the remainder;
 * - `description` plus `ExtractedDocument[]` becomes a `SourceBundle`;
 * - `SourceBundle` plus the prompt template becomes a `BuildPromptRequest`;
 * - the provider's deltas become `GenerationEvent` frames and then the client's `draft` string.
 */

/**
 * The kind of an accepted upload, decided from the extension allow-list and then confirmed from the
 * file's leading bytes — never from the client-supplied MIME type, which is untrusted input.
 */
export type FileKind = 'text' | 'pdf' | 'docx';

/**
 * A file that passed validation and is ready to be extracted.
 *
 * Produced by `validateSubmission` once the extension allow-list has been checked and the leading
 * bytes confirm the kind.
 */
export interface AcceptedFile {
  /** Original name as uploaded, used for provenance in the prompt and in the warnings. */
  name: string;
  kind: FileKind;
  /** Uploaded byte length as received. */
  bytes: number;
  /** The uploaded bytes, held in memory only for the duration of the request. */
  body: ArrayBuffer;
}

/**
 * Why a file was dropped.
 *
 * Every member is a file-level violation, so a rejected file becomes a warning on the response and
 * the rest of the submission still proceeds.
 */
export type RejectionReason =
  'unsupported-type' | 'too-large' | 'too-many-files' | 'extraction-failed' | 'empty';

/**
 * A file that did not make it through validation or extraction.
 *
 * Carries the name and the reason and nothing else: no file content ever leaves the request with a
 * rejection, and the reason is what the user's warning sentence is built from.
 */
export interface RejectedDocument {
  name: string;
  reason: RejectionReason;
}

/**
 * A document's plain text as it enters the source bundle.
 *
 * `chars` is what was kept once the source budget was applied, and `truncated` says that kept text
 * is shorter than what extraction produced. Both are per-document facts about the input; the model
 * being cut off at its own output cap is a different `truncated`, on {@link ProviderEvent} and
 * {@link DoneEvent}.
 */
export interface ExtractedDocument {
  name: string;
  kind: FileKind;
  /** Uploaded byte length, carried through from {@link AcceptedFile}. */
  bytes: number;
  /** Characters of extracted text kept within the source budget. */
  chars: number;
  /** The document text. Server-side only: it reaches the model, never the browser. */
  text: string;
  /** True when `text` is shorter than what extraction produced, because the budget ran out. */
  truncated: boolean;
}

/**
 * Everything the model is given, assembled deterministically.
 *
 * This is the one structure the prompt template renders. `sourceChars` is the total character count
 * the model receives and is what the request log records. `warnings` also carries every file-level
 * rejection from validation, so one response tells the user everything at once.
 */
export interface SourceBundle {
  /** Pasted requirements, counted first against the budget. Server-side only. */
  description: string;
  documents: ExtractedDocument[];
  /** Total characters the model receives: the description plus each document's kept text. */
  sourceChars: number;
  /** User-facing sentences: files dropped, and how much of a document was kept. */
  warnings: string[];
}

/**
 * The provider-facing request — the only structure the provider module understands.
 *
 * `instructions` is the trusted system instruction from the prompt template. `input` is the
 * rendered user message, which carries the untrusted source text as delimited data.
 */
export interface BuildPromptRequest {
  instructions: string;
  input: string;
  model: string;
  maxOutputTokens: number;
}

/**
 * One thing the provider yields while it generates.
 *
 * `text` is a piece of the draft, in order. `truncated` means the provider stream ended with
 * `response.incomplete`, so the model was cut off at `maxOutputTokens` — that is the output cap,
 * not the source budget, and this member is what makes the terminal `done` frame carry `truncated`.
 */
export type ProviderEvent = { type: 'text'; text: string } | { type: 'truncated' };

/**
 * The closed set of failure codes the application can report.
 *
 * `INVALID_INPUT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE` and `INTERNAL_ERROR`
 * fail a request before streaming begins and travel in a {@link GenerateErrorEnvelope}.
 * `PROVIDER_ERROR` and `GENERATION_TIMEOUT` can only happen once the status line is already on the
 * wire, so they travel in an in-stream {@link ErrorEvent} frame instead.
 *
 * The mapping from a code to its HTTP status (400, 413, 429, 500, 503) belongs to the errors
 * module, not here.
 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'PROVIDER_ERROR'
  | 'GENERATION_TIMEOUT';

/**
 * The JSON body of a failed request, sent only before streaming begins.
 *
 * `message` is written for the person looking at the screen and names the next action; `retryable`
 * is what decides whether the interface offers a Retry action.
 */
export interface GenerateErrorEnvelope {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

/**
 * The first frame of a successful stream: what was accepted, what was refused, and which model
 * runs.
 *
 * It is sent before generation starts, so the user learns immediately that a file was dropped or a
 * document truncated rather than discovering it in the draft. Each `documents` entry is a
 * projection of {@link ExtractedDocument}: the kept characters and whether the source budget cut
 * the text.
 */
export interface MetaEvent {
  type: 'meta';
  documents: Array<{ name: string; chars: number; truncated: boolean }>;
  sourceChars: number;
  warnings: string[];
  model: string;
}

/** One piece of the draft, appended in the order it arrives. */
export interface DeltaEvent {
  type: 'delta';
  text: string;
}

/**
 * Terminal success frame: the draft is complete.
 *
 * `chars` is the character count of the finished draft — the client's string, not the source's.
 * `truncated` says the model was cut off at its output cap, so the draft is partial and the
 * interface must present it as partial rather than complete.
 */
export interface DoneEvent {
  type: 'done';
  chars: number;
  model: string;
  durationMs: number;
  truncated: boolean;
}

/**
 * Terminal failure frame for a request whose response headers are already sent, so no status code
 * can carry the failure any more. It adds only its discriminant to the envelope's three fields, so
 * the error payload is declared once.
 */
export interface ErrorEvent extends GenerateErrorEnvelope {
  type: 'error';
}

/**
 * Every frame a stream can carry, discriminated on `type`.
 *
 * A stream holds exactly one `meta`, then zero or more `delta`, then exactly one terminal `done` or
 * `error`. The stream codec encodes and parses these, and the client narrows them exhaustively.
 */
export type GenerationEvent = MetaEvent | DeltaEvent | DoneEvent | ErrorEvent;

/**
 * The caps a browser-side check needs, passed from the server page down to the client components.
 *
 * The validation module is server-only, so it never reaches the browser; these four values are how
 * the client learns the server's own rules and keeps an avoidable rejection off the wire, while the
 * server stays the authoritative gate. `acceptedExtensions` is mutable rather than readonly so it
 * assigns straight to a `string[]` prop, which means a `readonly` or `as const` allow-list has to
 * be spread into a copy where the `Limits` object is built.
 */
export interface Limits {
  maxFiles: number;
  maxFileBytes: number;
  maxDescriptionChars: number;
  acceptedExtensions: string[];
}

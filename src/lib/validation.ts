/**
 * The single declaration of what a valid submission is, and the gate that runs before any document
 * is extracted and before any model call is paid for.
 *
 * Two rules live here and nowhere else.
 *
 * A file's kind comes from the extension allow-list and is then confirmed from the file's leading
 * bytes. The client-supplied MIME type is never read anywhere: trusting it would route a mislabelled
 * file to the wrong parser, and it arrives from the browser with the rest of the untrusted input.
 *
 * One rule decides every limit breach. A request-level violation fails the request with a typed
 * {@link AppError} - the pasted description past its cap, or a body past the request cap, which the
 * route handler refuses from `Content-Length` before reading it. A file-level violation - too many
 * files, a file too large, an unsupported or mislabelled type - becomes a {@link RejectedDocument}
 * warning and the rest of the submission proceeds, so one bad attachment never costs the user the
 * draft the other files would have produced.
 *
 * Server-only by tier. This module imports zod, so no client component may import it; the browser
 * learns the caps through `Limits` in `@/types`, which the server page builds from the constants
 * below and passes down as props.
 *
 * Every character count here and in `src/lib/source.ts` is a JavaScript string length, that is,
 * UTF-16 code units. Measuring the same text by code points in one place and code units in the other
 * would let a submission pass one cap and fail the next.
 */

import { z } from 'zod';

import { AppError } from '@/lib/errors';
import type { AcceptedFile, FileKind, RejectedDocument, RejectionReason } from '@/types';

/**
 * Largest number of files one submission may carry.
 *
 * Every file past this count is rejected as `too-many-files` and the first five proceed, so a
 * submission with too many attachments still generates from the ones that fit.
 */
export const MAX_FILES = 5;

/**
 * Largest single file accepted, in bytes - 8 MiB.
 *
 * A larger file is rejected as `too-large`; it is never read, so an oversized upload costs one
 * comparison rather than a parse.
 */
export const MAX_FILE_BYTES = 8_388_608;

/**
 * Largest request body accepted, in bytes - 16 MiB.
 *
 * The route handler reads this from `Content-Length` and refuses the request with 413 before the
 * body is parsed, so an oversized submission never reaches `request.formData()` at all. The constant
 * lives here because it is a limit on a submission; raising it is the handler's, since only the
 * handler sees the header.
 */
export const MAX_REQUEST_BYTES = 16_777_216;

/**
 * Largest pasted description accepted, in UTF-16 code units.
 *
 * A longer description fails the request as `INVALID_INPUT`. Kept below the source budget of
 * {@link MAX_SOURCE_CHARS} on purpose: the pasted text is counted first when the source is
 * assembled, so a description within this cap can never displace an uploaded document.
 */
export const MAX_DESCRIPTION_CHARS = 10_000;

/**
 * Largest assembled source handed to the model, in the same UTF-16 code units.
 *
 * Not enforced here: `src/lib/source.ts` applies this budget while assembling the source bundle and
 * reports what it truncated. Declared here because it is a limit on a submission, and declared with
 * the two constants above because all three are counted the same way.
 */
export const MAX_SOURCE_CHARS = 60_000;

/** Requests one client identity may make within {@link RATE_LIMIT_WINDOW_MS}. */
export const RATE_LIMIT_MAX = 10;

/** Length of the rate-limit window in milliseconds - ten minutes. */
export const RATE_LIMIT_WINDOW_MS = 600_000;

/**
 * The route handler's own generation deadline, in milliseconds - ninety seconds.
 *
 * The handler builds one abort signal from this deadline and the user's Stop and passes it to the
 * provider call, so the bound is enforced by the application rather than by a hosting platform, and
 * the terminal `GENERATION_TIMEOUT` frame is written by the same code that opened the stream.
 */
export const GENERATION_TIMEOUT_MS = 90_000;

/**
 * The extension allow-list and the kind each extension claims.
 *
 * One table, so the exported allow-list cannot disagree with what classification actually does: the
 * list is read back out of these keys rather than written a second time. Extensions are lower case
 * and include the dot, which is the form {@link fileExtension} produces.
 */
const KIND_BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map<string, FileKind>([
  ['.txt', 'text'],
  ['.md', 'text'],
  ['.markdown', 'text'],
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
]);

/**
 * The extensions a submission may use, in allow-list order.
 *
 * Exported because the browser's pre-checks and its drop target are sized from the same list the
 * server enforces: `src/app/page.tsx` spreads it into the `Limits` object it passes to the client
 * components. Read-only by declaration, since it is the server's rule; a consumer that needs a
 * mutable `string[]`, such as that `Limits` object, copies it.
 */
export const ACCEPTED_EXTENSIONS: readonly string[] = [...KIND_BY_EXTENSION.keys()];

/** `%PDF-`: the five bytes every PDF file opens with. */
const PDF_SIGNATURE: readonly number[] = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** `PK\x03\x04`: the local file header that opens a `.docx` ZIP container. */
const ZIP_SIGNATURE: readonly number[] = [0x50, 0x4b, 0x03, 0x04];

/**
 * Whether a byte sequence opens with a format signature.
 *
 * @param bytes The uploaded content.
 * @param signature The bytes the format must start with.
 * @returns True when the leading bytes match. A file shorter than the signature is not of that
 *   format, however its extension is spelled.
 */
function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) {
    return false;
  }

  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Whether a byte sequence is valid UTF-8 text.
 *
 * The whole file is decoded rather than a prefix: cutting a multi-byte sequence at an arbitrary
 * length would report valid text as invalid. The decoder is fatal, so an undecodable sequence is
 * reported as not being text instead of being turned into replacement characters and then handed to
 * the model as if it were the document. An empty file decodes to the empty string and is therefore
 * text by this check; that it carries no requirements is decided when it is extracted, which is a
 * fact about its content rather than about its bytes.
 */
function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The lower-cased extension of a file name, including its dot, or an empty string when there is none.
 *
 * Only the last path segment is considered, so a directory in a client-supplied name cannot supply
 * the extension that segment is missing, and `BRIEF.PDF` is recognised the same way `brief.pdf` is.
 *
 * @param name The name as the browser sent it.
 * @returns The extension in allow-list form, or an empty string when the name carries none.
 */
function fileExtension(name: string): string {
  const lastSeparator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = name.slice(lastSeparator + 1);
  const dot = base.lastIndexOf('.');

  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Render a count for a person to read, with the thousands separator the user-facing sentences use.
 *
 * @param value A character count.
 * @returns The count with thousands separated, for example `10,000`.
 */
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The pasted description, validated here against the same cap the browser's counter is sized from.
 *
 * Maximum rather than exact length: the description is optional, so the empty string is valid and
 * only a description past {@link MAX_DESCRIPTION_CHARS} fails. The issue message names the actual
 * count and the limit because the route handler forwards it as the user-facing sentence of the 400
 * it raises - a refusal that reported only "invalid input" would leave the user guessing which of
 * their two inputs was too long.
 *
 * The cap is stated over the string's own length rather than through zod's `.max()`, which measures
 * code points. An astral character is two UTF-16 code units and one code point, so `.max(10_000)`
 * would accept a 10,002-unit description of emoji while `src/lib/source.ts` charged it 10,002 against
 * the source budget and the browser's counter displayed 10,002. Counting UTF-16 code units here, in
 * that budget and in that counter is what keeps the tiers from disagreeing about the same text.
 */
export const descriptionSchema = z
  .string()
  .refine((value) => value.length <= MAX_DESCRIPTION_CHARS, {
    error: (issue) =>
      `The pasted description is ${formatCount(String(issue.input).length)} characters; the limit is ${formatCount(MAX_DESCRIPTION_CHARS)}. Shorten it, or put the rest of the detail in a file.`,
  });

/**
 * One uploaded file as validation receives it: the name the browser sent and the content itself.
 *
 * Deliberately not a DOM `File`. Taking the content as data is what makes this module pure and
 * testable without a DOM, and what leaves a client-declared MIME type nowhere to enter the decision.
 * `bytes` here is the file's **content**; on {@link AcceptedFile} the field of the same name is the
 * file's **size**, and every use of either is written from the one source that knows it.
 */
export interface SubmittedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * What validation made of one submission: the files that proceed to extraction, in the order they
 * arrived, and the files that did not, each with the reason the user is shown.
 */
export interface ValidationResult {
  accepted: AcceptedFile[];
  rejected: RejectedDocument[];
}

/**
 * Copy a caller's bytes into an `ArrayBuffer` of exactly that length.
 *
 * A view's own `buffer` is the whole underlying allocation, which for a slice of a pooled buffer or
 * a subarray of a larger read is longer than the file and starts somewhere else, so passing it on
 * would pad one file with another file's bytes. The copy is what makes the content the file's own.
 *
 * @param bytes The uploaded content, possibly a view.
 * @returns A buffer holding exactly those bytes.
 */
function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);

  return body;
}

/**
 * Build one rejection.
 *
 * One place, so a rejected file is always a name and a reason and nothing else: no file content ever
 * travels with a rejection, and the reason is typed as the union the rest of the tree narrows on.
 *
 * @param name The file's name as sent, for the warning sentence.
 * @param reason Which file-level rule it broke.
 * @returns The rejection.
 */
function reject(name: string, reason: RejectionReason): RejectedDocument {
  return { name, reason };
}

/**
 * Decide what a file is, from its extension and then from its leading bytes.
 *
 * The extension must be on the allow-list before the bytes are consulted, and the bytes must then
 * confirm what the extension claimed: `%PDF-` for a `.pdf`, the ZIP container header `PK\x03\x04`
 * for a `.docx`, and valid UTF-8 for the text formats. A file whose bytes contradict its extension
 * is not reported as that kind, and since there is no parser it could safely be handed to, it is
 * refused as `unsupported-type` by {@link validateSubmission}.
 *
 * @param file The name and content of one upload. No MIME type is a parameter, because the only
 *   kinds this application reads are the ones the bytes themselves support.
 * @returns The kind, or `null` when the extension is not allow-listed or the leading bytes
 *   contradict it.
 */
export function classifyFile(file: SubmittedFile): FileKind | null {
  const kind = KIND_BY_EXTENSION.get(fileExtension(file.name));

  if (kind === undefined) {
    return null;
  }

  switch (kind) {
    case 'pdf':
      return startsWithBytes(file.bytes, PDF_SIGNATURE) ? 'pdf' : null;
    case 'docx':
      return startsWithBytes(file.bytes, ZIP_SIGNATURE) ? 'docx' : null;
    case 'text':
      return isUtf8Text(file.bytes) ? 'text' : null;
    default: {
      // FileKind is closed, so this is unreachable for a typed caller; a value outside it is refused
      // rather than guessed at, so an added kind cannot silently classify as an existing one.
      const unsupported: never = kind;
      throw new TypeError(`Unsupported file kind: ${String(unsupported)}`);
    }
  }
}

/**
 * Decide one submission's fate: what the draft may be generated from, and what the user is told was
 * dropped.
 *
 * The checks run in one fixed order - count, then each file's size, then its kind - and the files are
 * processed in the order received, so the same submission always yields the same accepted list, the
 * same rejections and the same warnings. Nothing here throws for a bad file, however bad: a
 * file-level violation is recorded and the rest of the submission proceeds.
 *
 * Two request-level violations are deliberately not decided here. A body past
 * {@link MAX_REQUEST_BYTES} is refused by the route handler from `Content-Length` before the body is
 * read, since nothing can be validated without reading it. A submission with nothing usable in it is
 * decided by the handler after extraction, because only extraction can say whether a document
 * contributed any text; an empty file list and an empty description are therefore accepted here and
 * answered there.
 *
 * @param description The pasted requirements, exactly as the form sent them.
 * @param files The uploaded parts, in the order they arrived.
 * @returns The accepted files, each with its content copied out of the caller's buffer, and the
 *   rejected ones with the reason each broke a file-level rule.
 * @throws {AppError} `INVALID_INPUT` when the description is past {@link MAX_DESCRIPTION_CHARS},
 *   carrying the schema's sentence with both counts, or when it is not a string at all, carrying that
 *   code's own sentence instead.
 */
export function validateSubmission(
  description: string,
  files: readonly SubmittedFile[],
): ValidationResult {
  const parsed = descriptionSchema.safeParse(description);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    // A string that failed the schema failed its one rule, the length cap, and gets the sentence the
    // schema wrote, which names the actual count and the limit. A value that is not a string at all
    // gets the code's own sentence instead: zod's type message is written for a developer, and the
    // person reading a 400 needs to be told what to send rather than what the parser expected.
    if (typeof description === 'string') {
      throw new AppError('INVALID_INPUT', { message: issue?.message });
    }

    throw new AppError('INVALID_INPUT');
  }

  const accepted: AcceptedFile[] = [];
  const rejected: RejectedDocument[] = [];

  for (const [index, file] of files.entries()) {
    // Count, then size, then kind: the first rule a file breaks is the one it is reported under, so a
    // sixth file is reported as too many even when it is also oversized.
    if (index >= MAX_FILES) {
      rejected.push(reject(file.name, 'too-many-files'));
      continue;
    }

    if (file.bytes.byteLength > MAX_FILE_BYTES) {
      rejected.push(reject(file.name, 'too-large'));
      continue;
    }

    const kind = classifyFile(file);

    if (kind === null) {
      rejected.push(reject(file.name, 'unsupported-type'));
      continue;
    }

    accepted.push({
      name: file.name,
      kind,
      bytes: file.bytes.byteLength,
      body: copyToArrayBuffer(file.bytes),
    });
  }

  return { accepted, rejected };
}

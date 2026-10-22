import type { ErrorCode } from '@/types';

/**
 * The metadata describing one completed request, and nothing else.
 *
 * The absence of a text field is the enforcement mechanism, not a convention: there is no member
 * here that can carry prompt text, pasted text, document text, an extracted character, file-name
 * content or a credential, so a request can be logged without any user content being written
 * anywhere. Reviewing this type is therefore enough to verify that the log is metadata-only.
 *
 * The route handler emits exactly one of these per completed request, after the response has been
 * produced, and every count is the same quantity the `meta` and `done` frames carry to the browser:
 * `sourceChars` is the assembled total from the source bundle, `documentCount` the documents the
 * model was given, `rejectedCount` the files dropped as warnings and `truncatedCount` the documents
 * the source budget cut. `truncatedCount` is the source-budget count only; the model being cut off
 * at its own output cap is visible in `status` and `errorCode`, not here.
 */
export interface LogEntry {
  /** Stable label for the endpoint the request went to, for example `POST /api/generate`. */
  route: string;
  /** HTTP status the response carried: 200 for a completed draft, otherwise a failure code's status. */
  status: number;
  /** Wall-clock duration of the request, in milliseconds. */
  durationMs: number;
  /** Total characters the assembled source handed to the model. */
  sourceChars: number;
  /** Documents accepted, extracted and included in the source. */
  documentCount: number;
  /** Files dropped as file-level warnings rather than failing the request. */
  rejectedCount: number;
  /** Documents shortened by the 60,000-character source budget. */
  truncatedCount: number;
  /** Model the request ran against; absent when the request failed before a provider was selected. */
  model?: string;
  /** Failure code from the closed set; absent when the request succeeded. */
  errorCode?: ErrorCode;
}

/**
 * Emits one metadata line for a completed request.
 *
 * The line is a single `JSON.stringify` of the nine fields above, written through `console` so the
 * platform's collector picks it up — no logging dependency is added, and no log-level or transport
 * abstraction exists to configure. It is deliberately one line and one call: a multi-line record
 * would not be a record a collector can read per request.
 *
 * No prompt text, document text, file-name content or credential can be passed to this function by
 * construction, because {@link LogEntry} has no member able to hold one and this function accepts
 * only that type. The object written is built field by field and pinned to those nine keys, so an
 * added field cannot reach the line even if a caller's object carries one.
 *
 * Both optional fields are written as `null` when absent rather than dropped, so the line has the
 * same keys on the success path (no `errorCode`) and the failure path (no `model`) and a collector
 * parsing these lines sees one stable shape. `errorCode` is the code alone — never a message, a
 * stack, a provider response body or a file name.
 *
 * @param entry - The request's metadata. Every value is a number, a route label, a model name or an
 *   error code, so `JSON.stringify` over it is total and this function cannot throw.
 */
export function logRequest(entry: LogEntry): void {
  console.info(
    JSON.stringify({
      route: entry.route,
      status: entry.status,
      durationMs: entry.durationMs,
      sourceChars: entry.sourceChars,
      documentCount: entry.documentCount,
      rejectedCount: entry.rejectedCount,
      truncatedCount: entry.truncatedCount,
      model: entry.model ?? null,
      errorCode: entry.errorCode ?? null,
    } satisfies Record<keyof LogEntry, unknown>),
  );
}

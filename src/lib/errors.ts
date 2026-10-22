/**
 * The one place where a failure becomes a code, an HTTP status, a sentence written for the
 * person looking at the screen, and a retryable flag.
 *
 * Every failure the product can report is a member of `ErrorCode`, which is declared once in
 * `@/types` and never redeclared here. For each member this module fixes three things: the
 * status the response carries while a status line can still carry it, whether resending the
 * same request can succeed (which is what decides whether the interface offers a Retry
 * action), and the message the user reads. The route handler converts a thrown value exactly
 * once, through `toErrorEnvelope`, so no raw exception and no internal detail - a stack, a
 * file path, a provider message, an environment value or a credential - ever reaches the
 * browser.
 *
 * Server-only by tier. Nothing in the browser may import this module, and it imports types
 * only: it carries no runtime dependency, no third-party package and nothing that could enter
 * the client bundle.
 */

import type { ErrorCode, GenerateErrorEnvelope } from '@/types';

/**
 * The HTTP status each failure code carries when a status code can still be sent.
 *
 * Typing this as `Record<ErrorCode, number>` is deliberate rather than incidental: a code
 * added to `ErrorCode` in `@/types` fails type-checking here, in `RETRYABLE` and in
 * `ERROR_MESSAGES` until all three tables are updated, so the contract stays total and is
 * declared once.
 *
 * `PROVIDER_ERROR` and `GENERATION_TIMEOUT` are raised only after the response headers are on
 * the wire - the failure table of the specification marks their status row as in-stream - so
 * no status is ever sent for them and none is specified. Both are listed as 500, the
 * `INTERNAL_ERROR` semantics, purely to keep this table total. That fallback is a record of the
 * reading taken here and not a behaviour: the route handler reports these two codes as an
 * in-stream `error` frame, never as a response status.
 */
const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_ERROR: 500,
  GENERATION_TIMEOUT: 500,
};

/**
 * Whether resending the same request unchanged can succeed.
 *
 * A rate-limited request can succeed once the window reopens, a request the provider refused
 * or failed to answer can succeed when the provider recovers, a request that timed out can
 * succeed on a second attempt, and an unexpected internal failure is worth one more try. Input
 * the server refused for its shape or its size cannot: resending it produces the same refusal,
 * so the interface offers no Retry for those two codes.
 */
const RETRYABLE: Record<ErrorCode, boolean> = {
  INVALID_INPUT: false,
  PAYLOAD_TOO_LARGE: false,
  RATE_LIMITED: true,
  INTERNAL_ERROR: true,
  PROVIDER_UNAVAILABLE: true,
  PROVIDER_ERROR: true,
  GENERATION_TIMEOUT: true,
};

/**
 * The sentence shown for each code when the throwing side supplies none.
 *
 * Each one names the next action rather than the code, and each is free of internal detail -
 * no stack, path, provider text, environment value or credential appears in any of them. The
 * two figures they quote, the 16 MB request limit and the 90 second deadline, restate
 * `MAX_REQUEST_BYTES` and `GENERATION_TIMEOUT_MS` from the validation module, which this module
 * deliberately does not import (its only import is types), so the numbers move together by hand
 * whenever those two constants change.
 */
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT:
    'Nothing usable arrived with that request. Add a supported file or paste your requirements as text, then try again.',
  PAYLOAD_TOO_LARGE:
    'That request is larger than the 16 MB limit. Remove a file or send a smaller one, then try again.',
  RATE_LIMITED: 'You have reached the limit for draft requests from your address.',
  INTERNAL_ERROR:
    'Something went wrong on our end while handling the request. Try again; if it keeps happening, reload the page and start over.',
  PROVIDER_UNAVAILABLE:
    'The model key is not configured on the server, so no draft can be written. Set OPENAI_API_KEY in the environment, then try again.',
  PROVIDER_ERROR:
    'The model stopped responding while the draft was being written. Try again; your inputs are unchanged.',
  GENERATION_TIMEOUT:
    'The draft took longer than 90 seconds to write and was stopped. Try again, or send a shorter description.',
};

/**
 * Say when a rate-limit window reopens, so the 429 message tells the user when they may try
 * again rather than only that they cannot.
 *
 * @param resetAt Epoch milliseconds at which the window reopens, as the rate limiter reports
 * it, or `undefined` when the throwing side reported no time. Both that case and a value that
 * is not a finite number produce a sentence that still tells the user to wait for the reset,
 * because a rate-limit answer that never mentions the reset leaves them with nothing to do.
 * @returns A sentence naming when the window reopens.
 */
function describeRateLimitReset(resetAt: number | undefined): string {
  if (resetAt === undefined || !Number.isFinite(resetAt)) {
    return 'It resets a few minutes after your last request; wait, then try again.';
  }

  const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000));
  const unit = minutes === 1 ? 'minute' : 'minutes';
  const clock = new Date(resetAt).toISOString().slice(11, 16);

  return `Try again in about ${minutes} ${unit}; the limit resets at ${clock} UTC.`;
}

/**
 * Options that shape one {@link AppError}.
 */
interface AppErrorOptions {
  /**
   * The sentence the user reads, when the throwing side has something more specific to say -
   * the description was too long, a particular file could not be read, the rate-limit window
   * reopens at a stated time. Left out, the code's own sentence is used. Ignored for
   * `INTERNAL_ERROR`, whose sentence is always the fixed generic one.
   */
  message?: string;
  /** Overrides the code's default retryability, for a case that differs from the table. */
  retryable?: boolean;
  /**
   * Epoch milliseconds at which the rate-limit window reopens. Read only for `RATE_LIMITED`,
   * and only when no `message` was supplied, where it is appended to that code's sentence so
   * the 429 response states the remaining wait and the clock time of the reset; left out, that
   * sentence still tells the user to wait for the reset. Ignored for every other code.
   */
  resetAt?: number;
}

/**
 * Build the sentence for a code, honouring a caller's own sentence when it gave one.
 *
 * An empty or whitespace-only sentence is treated as none, because a blank message would leave
 * the interface saying nothing at all.
 *
 * @param code The failure code, already known not to be `INTERNAL_ERROR`.
 * @param options The caller's message and rate-limit reset time, if any.
 * @returns The sentence the user reads.
 */
function resolveMessage(code: ErrorCode, options: AppErrorOptions): string {
  const supplied = options.message?.trim();
  if (supplied) {
    return supplied;
  }

  const fallback = ERROR_MESSAGES[code];
  if (code === 'RATE_LIMITED') {
    return `${fallback} ${describeRateLimitReset(options.resetAt)}`;
  }

  return fallback;
}

/**
 * A failure the application knows how to explain.
 *
 * Carrying the code, the sentence and the retryable flag on one error is what lets the route
 * handler convert a failure to its response without a chain of conditionals, and what keeps an
 * internal detail out of the browser: the only text that can reach a user through
 * {@link toErrorEnvelope} is the text an `AppError` was constructed with.
 *
 * @example
 * throw new AppError('PAYLOAD_TOO_LARGE');
 * throw new AppError('INVALID_INPUT', { message: 'The pasted description is 10,241 characters; the limit is 10,000.' });
 * throw new AppError('RATE_LIMITED', { resetAt });
 */
export class AppError extends Error {
  /** The failure code, one of the closed set declared in `@/types`. */
  readonly code: ErrorCode;

  /** Whether resending the same request unchanged can succeed. */
  readonly retryable: boolean;

  /**
   * @param code The failure code; it fixes the status, the default sentence and the default
   * retryability reported by {@link toErrorEnvelope}.
   * @param options The sentence to show, an override for retryability, and the rate-limit reset
   * time. All three are optional, and all three fall back to the tables above.
   */
  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    // `INTERNAL_ERROR` never takes a caller's sentence: an unexpected failure is exactly the
    // case whose text may carry a stack, a path, a provider message or an environment value,
    // and the fixed generic sentence is what guarantees none of it reaches the browser.
    super(
      code === 'INTERNAL_ERROR' ? ERROR_MESSAGES.INTERNAL_ERROR : resolveMessage(code, options),
    );

    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE[code];
  }
}

/**
 * Turn any thrown value into the status and JSON body the browser receives.
 *
 * Total by contract: it never throws, for any input. A value this application raised as an
 * {@link AppError} keeps its code, its message and its retryable flag. Anything else - a bare
 * `Error`, a string, `null`, a provider SDK failure - degrades to 500 `INTERNAL_ERROR` with the
 * generic sentence, so that no internal detail is echoed back and the failed request still has
 * a legible answer.
 *
 * @param error The caught value, of any type, exactly as the `catch` bound it.
 * @returns The HTTP status for the response and the {@link GenerateErrorEnvelope} body, which a
 * failure after streaming has begun reuses as the payload of its terminal `error` frame.
 */
export function toErrorEnvelope(error: unknown): { status: number; body: GenerateErrorEnvelope } {
  const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR');

  return {
    // The status table is total for `ErrorCode`, so the fallback only covers a value that
    // reached an `AppError` from untyped code with a code outside the closed set; returning a
    // sendable status is what keeps this function from throwing that case at the route handler.
    status: ERROR_STATUS[appError.code] ?? ERROR_STATUS.INTERNAL_ERROR,
    body: {
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
    },
  };
}

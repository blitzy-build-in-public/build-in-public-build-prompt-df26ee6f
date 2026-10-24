/**
 * Unit suite for the error mapping, `src/lib/errors.ts`: the `AppError` a known failure is raised
 * as, and `toErrorEnvelope`, the one conversion that turns any thrown value into the status and JSON
 * body the browser receives.
 *
 * Two properties are pinned here because nothing else can hold them. The closed `ErrorCode` set is
 * enumerated once below, with a compile-time exhaustiveness guard beside it, so a code added to
 * `@/types` fails this file's type check until the new member is covered — which is how an unhandled
 * code is caught, before any test runs at all. And because this module is the boundary that keeps
 * internal detail off the wire, the safety cases assert what must *not* appear: no stack frame, no
 * file path, no credential, no exception text, no `Error:` prefix — and exactly three wire fields.
 *
 * The module is pure and synchronous, so every case runs against the real implementation: no
 * network, no credential, no clock and no snapshot.
 */
import { describe, expect, it } from 'vitest';

import { AppError, toErrorEnvelope } from '@/lib/errors';
import type { ErrorCode, GenerateErrorEnvelope } from '@/types';

/**
 * The whole closed set, listed once. `satisfies readonly ErrorCode[]` rejects a member that is not
 * an `ErrorCode`; the guard below rejects a member that is missing.
 */
const ALL_CODES = [
  'INVALID_INPUT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'GENERATION_TIMEOUT',
] as const satisfies readonly ErrorCode[];

/**
 * Compile-time exhaustiveness guard, and the mechanism that catches an unhandled code: `ErrorCode`
 * is a closed union, so a member added in `@/types` without a row here is a type error in this file
 * and `npm run typecheck` fails. The case below additionally asserts the two enumerations agree, so
 * the guard cannot drift from `ALL_CODES` unnoticed.
 */
const CODES_COVERED = {
  INVALID_INPUT: true,
  PAYLOAD_TOO_LARGE: true,
  RATE_LIMITED: true,
  INTERNAL_ERROR: true,
  PROVIDER_UNAVAILABLE: true,
  PROVIDER_ERROR: true,
  GENERATION_TIMEOUT: true,
} satisfies Record<ErrorCode, true>;

/**
 * The five statuses the specification's failure table fixes, for the codes that fail a request while
 * a status line can still carry it. `PROVIDER_ERROR` and `GENERATION_TIMEOUT` are raised only after
 * the response headers are on the wire — the specification marks their status row as in-stream — so
 * the statuses of those two are deliberately not restated here; they are asserted as *handled*
 * (a sendable numeric status and a well-formed body) in the failure-table case.
 */
const FIXED_STATUSES = [
  { code: 'INVALID_INPUT', status: 400 },
  { code: 'PAYLOAD_TOO_LARGE', status: 413 },
  { code: 'RATE_LIMITED', status: 429 },
  { code: 'INTERNAL_ERROR', status: 500 },
  { code: 'PROVIDER_UNAVAILABLE', status: 503 },
] as const satisfies readonly { code: ErrorCode; status: number }[];

/** The two codes whose status row the specification leaves in-stream, so it fixes no number. */
const IN_STREAM_ONLY: readonly ErrorCode[] = ['PROVIDER_ERROR', 'GENERATION_TIMEOUT'];

/**
 * Retryability, stated as the rule it encodes: `retryable` means the *same* request can succeed
 * later, so it is true only when nothing about the request itself was wrong. A rate-limited request
 * succeeds once the window reopens, a request the provider refused, failed to answer or timed out
 * may succeed once the provider recovers or on a second attempt, and an unexpected internal failure
 * is worth one more try. Input the server refused for its shape or its size cannot be fixed by
 * resending it: the input must change, not the retry, so no Retry action is offered for those two.
 *
 * The last two rows cover the codes that can only fail once the response has already started. The
 * specification fixes no status or retryability for them, so these rows pin what the module
 * documents rather than a plan figure, which keeps the table total over the closed set.
 */
const RETRYABLE_EXPECTATIONS = [
  { code: 'INVALID_INPUT', retryable: false },
  { code: 'PAYLOAD_TOO_LARGE', retryable: false },
  { code: 'RATE_LIMITED', retryable: true },
  { code: 'INTERNAL_ERROR', retryable: true },
  { code: 'PROVIDER_UNAVAILABLE', retryable: true },
  { code: 'PROVIDER_ERROR', retryable: true },
  { code: 'GENERATION_TIMEOUT', retryable: true },
] as const satisfies readonly { code: ErrorCode; retryable: boolean }[];

/** The sentence shown for a failure the application does not recognise, read from the module. */
const GENERIC_MESSAGE = toErrorEnvelope(new Error('unexpected')).body.message;

/** A stack frame, which no user-facing sentence may contain. */
const STACK_FRAME = /\bat \S+:\d+:\d+/;

/**
 * Internal identifiers that must not appear in a user-facing sentence: internal path segments and
 * runtime vocabulary a reader cannot act on. `PROVIDER_UNAVAILABLE` legitimately names the
 * `OPENAI_API_KEY` environment variable, which this pattern does not match — an underscore is a
 * word character, so `\bapi\b` finds no word boundary inside that name. The same reasoning is why
 * the pattern carries no exception list.
 */
const INTERNAL_IDENTIFIER = /\b(src|lib|api|route|stack|undefined|null)\b/i;

/** One cue per sentence that tells the reader what to do next. */
const NEXT_ACTION = /try again|wait|reload|reset|paste|attach|add |remove|send|set /i;

/**
 * Thrown values that are not an `AppError`, each with the label its assertion prints. Every one of
 * them must degrade to the generic 500: a plain object shaped like an `AppError` included, since
 * structure is not identity and only a real `instanceof` may pass a code through.
 */
const NON_APP_ERRORS: readonly { label: string; value: unknown }[] = [
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: 'a bare string', value: 'the provider refused the request' },
  { label: 'a number', value: 42 },
  { label: 'a plain object carrying a message', value: { message: 'x' } },
  { label: 'an array', value: [new Error('x')] },
  { label: 'a bare Error', value: new Error('x') },
  {
    label: 'an Error whose cause is another Error',
    value: new Error('outer', { cause: new Error('inner') }),
  },
  {
    label: 'a plain object shaped like an AppError',
    value: { name: 'AppError', code: 'INVALID_INPUT', message: 'x', retryable: false },
  },
  { label: 'a class instance that is not an Error', value: { toString: () => 'Custom' } },
  { label: 'a function', value: (): string => 'thrown' },
  { label: 'a symbol', value: Symbol('thrown') },
];

/** The status and body the browser receives for one code. */
function envelopeForCode(code: ErrorCode): { status: number; body: GenerateErrorEnvelope } {
  return toErrorEnvelope(new AppError(code));
}

describe('AppError', () => {
  it('is an Error that carries the code, its own name and a non-empty sentence', () => {
    const error = new AppError('INVALID_INPUT');

    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(Object.prototype.toString.call(error)).toBe('[object Error]');
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message.trim()).not.toBe('');
  });

  it('fills every code with a sentence of its own when the caller supplies none', () => {
    for (const code of ALL_CODES) {
      const error = new AppError(code);

      expect(error.message.trim(), code).not.toBe('');
      expect(error.message, code).not.toBe(code);
    }
  });

  it('takes the code’s default retryability when the caller supplies none', () => {
    for (const { code, retryable } of RETRYABLE_EXPECTATIONS) {
      expect(new AppError(code).retryable, code).toBe(retryable);
    }
  });

  it('prefers a caller-supplied sentence, trimmed, when the caller knows the failure better', () => {
    const supplied = '  Your description is 12,001 characters; the limit is 10,000.  ';

    expect(new AppError('INVALID_INPUT', { message: supplied }).message).toBe(supplied.trim());
  });

  it('treats a blank caller sentence as none, so the interface never says nothing at all', () => {
    const own = new AppError('INVALID_INPUT').message;

    expect(new AppError('INVALID_INPUT', { message: '   ' }).message).toBe(own);
  });

  it('refuses a caller-supplied sentence for INTERNAL_ERROR, so unexpected text cannot reach a user', () => {
    const leaked = new AppError('INTERNAL_ERROR', {
      message: 'boom at /srv/app/src/lib/x.ts:12 sk-secret-value',
    });

    expect(leaked.message).toBe(GENERIC_MESSAGE);
    expect(leaked.message).not.toContain('boom');
    expect(leaked.message).not.toContain('/srv/app');
    expect(leaked.message).not.toContain('sk-secret-value');
  });

  it('states when the rate-limit window reopens when the caller reports the reset time', () => {
    const resetAt = Date.now() + 5 * 60_000;
    const withReset = new AppError('RATE_LIMITED', { resetAt }).message;
    const withoutReset = new AppError('RATE_LIMITED').message;

    expect(withReset).toMatch(/try again/i);
    expect(withReset).toMatch(/minutes?/i);
    expect(withReset).not.toBe('RATE_LIMITED');
    // The reported time has to reach the sentence, which is what makes the 429 actionable.
    expect(withReset).not.toBe(withoutReset);
  });

  it('still tells the reader to wait when no usable reset time is reported', () => {
    const withoutReset = new AppError('RATE_LIMITED').message;
    const notFinite = new AppError('RATE_LIMITED', { resetAt: Number.NaN }).message;

    expect(withoutReset).toMatch(/reset|try again/i);
    expect(withoutReset).not.toBe('RATE_LIMITED');
    expect(notFinite).toBe(withoutReset);
  });

  it('reads as one minute, not one minutes, when the window reopens that soon', () => {
    // Within the next minute the remaining wait rounds to 1, which is the only case where the
    // sentence has to choose between the singular and the plural.
    const withReset = new AppError('RATE_LIMITED', { resetAt: Date.now() + 60_000 }).message;

    expect(withReset).toMatch(/1 minute\b/);
    expect(withReset).not.toMatch(/minutes/);
  });

  it('honours a caller override of retryability in either direction', () => {
    expect(new AppError('RATE_LIMITED', { retryable: false }).retryable).toBe(false);
    expect(new AppError('INVALID_INPUT', { retryable: true }).retryable).toBe(true);
  });
});

describe('toErrorEnvelope — the failure table', () => {
  // A suite that skipped a member would still pass every assertion in the loop below, so the
  // iteration count at the end is the assertion that makes an unvisited code fail.
  it('maps every code in the closed set to a sendable status and a well-formed envelope', () => {
    let visited = 0;

    for (const code of ALL_CODES) {
      visited += 1;
      const { status, body } = envelopeForCode(code);

      // `PROVIDER_ERROR` and `GENERATION_TIMEOUT` are raised only after the response headers are on
      // the wire, so no status is ever sent for them: `src/lib/errors.ts` documents 500 for both, as
      // the totality fallback of its `Record<ErrorCode, number>` table. What this case requires of
      // them is that they are handled - a finite, sendable status and a full body - rather than
      // falling through to `undefined` or to a default nobody intended.
      expect(Number.isInteger(status), code).toBe(true);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
      expect(body.code, code).toBe(code);
      expect(body.message.trim(), code).not.toBe('');
      expect(typeof body.retryable, code).toBe('boolean');
    }

    expect(visited).toBe(ALL_CODES.length);
    expect(ALL_CODES.length).toBeGreaterThan(0);
  });

  it('fixes the five statuses the specification states for a failure that can still send one', () => {
    for (const { code, status } of FIXED_STATUSES) {
      expect(envelopeForCode(code).status, code).toBe(status);
    }

    // Those five are exactly the codes that can fail before streaming begins; the two in-stream
    // codes are what remains of the closed set, and the specification states no status for them.
    expect(FIXED_STATUSES.map((entry) => entry.code)).toEqual(
      ALL_CODES.filter((code) => !IN_STREAM_ONLY.includes(code)),
    );
  });

  it('enumerates the closed set exactly once, so no code can go unvisited', () => {
    expect([...ALL_CODES].sort()).toEqual(Object.keys(CODES_COVERED).sort());
    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);

    for (const code of ALL_CODES) {
      expect(code, code).toMatch(/^[A-Z][A-Z_]*$/);
    }
  });

  it('marks as retryable only the failures a resend of the same request can fix', () => {
    for (const { code, retryable } of RETRYABLE_EXPECTATIONS) {
      expect(envelopeForCode(code).body.retryable, code).toBe(retryable);
    }
  });

  it('offers a retry for what waiting or resending fixes, and none for input the server refused', () => {
    expect(envelopeForCode('RATE_LIMITED').body.retryable).toBe(true);
    expect(envelopeForCode('PROVIDER_UNAVAILABLE').body.retryable).toBe(true);
    expect(envelopeForCode('INTERNAL_ERROR').body.retryable).toBe(true);
    expect(envelopeForCode('INVALID_INPUT').body.retryable).toBe(false);
    expect(envelopeForCode('PAYLOAD_TOO_LARGE').body.retryable).toBe(false);
  });

  it('passes a recognised AppError through with its own code, status, sentence and flag', () => {
    for (const { code, status } of FIXED_STATUSES) {
      const error = new AppError(code);
      const envelope = toErrorEnvelope(error);

      expect(envelope.status, code).toBe(status);
      expect(envelope.body.code, code).toBe(code);
      expect(envelope.body.message, code).toBe(error.message);
      expect(envelope.body.retryable, code).toBe(error.retryable);
    }

    // A failure the application recognises is never flattened into the generic internal one, which
    // would both hide the real cause from the user and offer the wrong next action.
    for (const { code } of FIXED_STATUSES) {
      if (code === 'INTERNAL_ERROR') {
        continue;
      }

      const envelope = envelopeForCode(code);

      expect(envelope.body.code, code).not.toBe('INTERNAL_ERROR');
      expect(envelope.body.message, code).not.toBe(GENERIC_MESSAGE);
    }

    const supplied = 'Your upload is 9,000,000 bytes; the limit is 8,388,608.';
    const described = toErrorEnvelope(new AppError('INVALID_INPUT', { message: supplied }));
    expect(described.status).toBe(400);
    expect(described.body.message).toBe(supplied);

    const noRetry = toErrorEnvelope(new AppError('RATE_LIMITED', { retryable: false }));
    expect(noRetry.body.retryable).toBe(false);
  });

  it('states when the rate-limit window reopens instead of echoing the code back', () => {
    const resetAt = Date.now() + 120_000;
    const envelope = toErrorEnvelope(new AppError('RATE_LIMITED', { resetAt }));

    expect(envelope.status).toBe(429);
    expect(envelope.body.message).toMatch(/reset|in \d+|try again/i);
    expect(envelope.body.message).not.toBe('RATE_LIMITED');
    expect(envelope.body.retryable).toBe(true);
  });

  it('sends exactly the three wire fields, so no internal field can ride along unnoticed', () => {
    for (const code of ALL_CODES) {
      expect(Object.keys(envelopeForCode(code).body).sort(), code).toEqual([
        'code',
        'message',
        'retryable',
      ]);
    }

    const degraded = toErrorEnvelope(new Error('boom'));

    expect(Object.keys(degraded).sort()).toEqual(['body', 'status']);
    expect(Object.keys(degraded.body).sort()).toEqual(['code', 'message', 'retryable']);
  });
});

describe('toErrorEnvelope — the boundary that keeps internal detail off the wire', () => {
  it('degrades an unexpected exception to a generic 500 that leaks no internal detail', () => {
    const thrown = new Error('boom at /srv/app/src/lib/x.ts:12 sk-secret-value');
    const { status, body } = toErrorEnvelope(thrown);

    expect(status).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.retryable).toBe(true);
    expect(body.message).toBe(GENERIC_MESSAGE);
    expect(body.message).not.toContain('boom');
    expect(body.message).not.toContain('/srv/app');
    expect(body.message).not.toContain('sk-secret-value');
    expect(body.message).not.toMatch(STACK_FRAME);
    expect(body.message.startsWith('Error')).toBe(false);
    expect(body.message).not.toMatch(/^Error:/);
  });

  it('degrades every thrown value that is not an AppError, whatever its shape', () => {
    for (const { label, value } of NON_APP_ERRORS) {
      const { status, body } = toErrorEnvelope(value);

      expect(status, label).toBe(500);
      expect(body.code, label).toBe('INTERNAL_ERROR');
      expect(body.message, label).toBe(GENERIC_MESSAGE);
      expect(body.retryable, label).toBe(true);
    }
  });

  it('reports a rejected promise’s reason exactly as it reports a thrown one', async () => {
    const envelope = await Promise.reject(new Error('boom at /srv/app/src/lib/x.ts:12')).catch(
      (reason: unknown) => toErrorEnvelope(reason),
    );

    expect(envelope.status).toBe(500);
    expect(envelope.body.code).toBe('INTERNAL_ERROR');
    expect(envelope.body.message).toBe(GENERIC_MESSAGE);
    expect(envelope.body.message).not.toContain('boom');
    expect(envelope.body.message).not.toContain('/srv/app');
  });

  it('answers with a sendable status even when a code arrives from untyped code', () => {
    // `AppError` is total over the closed set, so this can only happen to a value that came from
    // untyped code. The conversion still has to answer instead of throwing or sending `undefined`;
    // `src/lib/errors.ts` documents 500 as that fallback.
    const forged = new AppError('INVALID_INPUT');
    Object.assign(forged, { code: 'NOT_A_CODE' });

    const { status, body } = toErrorEnvelope(forged);

    expect(Number.isInteger(status)).toBe(true);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(600);
    expect(body.message.trim()).not.toBe('');
    expect(typeof body.retryable).toBe('boolean');
  });
});

describe('every published sentence is written for the person reading it', () => {
  it('names the next action and carries no code, stack frame or internal identifier', () => {
    for (const code of ALL_CODES) {
      const message = envelopeForCode(code).body.message;

      expect(message.trim(), code).not.toBe('');
      expect(message.trim(), code).toBe(message);
      expect(message, code).toMatch(/^[A-Z]/);
      expect(message, code).not.toBe(code);
      expect(message, code).not.toMatch(/^[A-Z][A-Z_]+$/);
      expect(message, code).not.toMatch(/^Error:/);
      expect(message, code).not.toMatch(STACK_FRAME);
      expect(message, code).not.toMatch(INTERNAL_IDENTIFIER);
      expect(message, code).toMatch(NEXT_ACTION);
    }
  });

  it('says something different for each failure, so a reader can tell them apart', () => {
    const sentences = ALL_CODES.map((code) => envelopeForCode(code).body.message);

    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('quotes no credential, token, environment value or filesystem path', () => {
    for (const code of ALL_CODES) {
      const message = envelopeForCode(code).body.message;

      expect(message, code).not.toMatch(/sk-[A-Za-z0-9]|AKIA|ghp_|github_pat_|Bearer /);
      expect(message, code).not.toMatch(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/);
    }
  });
});

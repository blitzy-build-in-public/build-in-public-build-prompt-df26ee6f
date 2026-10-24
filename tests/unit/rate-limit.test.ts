/**
 * Unit suite for the per-source cost ceiling, `src/lib/rate-limit.ts`: the fixed window that bounds
 * how many draft requests one client identity may make, and the rule that decides which identity a
 * request counts against.
 *
 * The clock is injected, never waited on. `checkRateLimit` takes `now` as its second argument, so
 * every case here crosses a window boundary by arithmetic on one fixed base instant, and no
 * assertion in this file depends on real elapsed time.
 *
 * A module-level `Map` holds the counters, so each test needs a fresh module graph. A static import
 * would let one test's counts leak into the next: `beforeEach` therefore resets the module registry
 * and imports the module again, and the whole suite is expected to be repeatable with identical
 * results.
 *
 * What this suite does not cover. The `RATE_LIMITED` sentence, its 429 status and the response body
 * it travels in belong to `src/lib/errors.ts` and the route handler's own suite - this module
 * returns a decision and never throws. What is asserted here is the behaviour behind the two
 * limitations the README publishes: the counts live in this process only, and with no trustworthy
 * identity every caller shares one bucket.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '@/lib/validation';

/**
 * The window the module measures against, read from its declaration rather than written here.
 *
 * `@/lib/validation` is the one place a limit is declared, so a suite that spelled out 600,000
 * would keep passing while the shipped window changed.
 */
const WINDOW = RATE_LIMIT_WINDOW_MS;

/** The fixed instant every synthetic request in this suite is positioned relative to. */
const BASE = 1_700_000_000_000;

/** The endpoint the key rule is asserted against; the rule does not depend on its path. */
const BASE_URL = 'http://localhost/api/generate';

/** The decision `checkRateLimit` returns, taken from the module that declares it. */
type RateLimitDecision = import('@/lib/rate-limit').RateLimitDecision;

let checkRateLimit: (typeof import('@/lib/rate-limit'))['checkRateLimit'];
let resolveRateLimitKey: (typeof import('@/lib/rate-limit'))['resolveRateLimitKey'];
let SHARED_BUCKET_KEY: (typeof import('@/lib/rate-limit'))['SHARED_BUCKET_KEY'];
let TRUSTED_PROXY_HEADERS: (typeof import('@/lib/rate-limit'))['TRUSTED_PROXY_HEADERS'];

beforeEach(async () => {
  vi.resetModules();

  const rateLimit = await import('@/lib/rate-limit');

  checkRateLimit = rateLimit.checkRateLimit;
  resolveRateLimitKey = rateLimit.resolveRateLimitKey;
  SHARED_BUCKET_KEY = rateLimit.SHARED_BUCKET_KEY;
  TRUSTED_PROXY_HEADERS = rateLimit.TRUSTED_PROXY_HEADERS;
});

/**
 * The instant `offset` milliseconds after {@link BASE}.
 *
 * Windows are opened and crossed by arithmetic on a fixed base instead of by advancing a clock, so
 * the suite neither waits nor depends on how fast it runs.
 */
const advance = (offset: number): number => BASE + offset;

/**
 * Spend a key's entire allowance at `now`.
 *
 * Both ends of the run are handed back: the first decision states when the window opened and when it
 * ends, and the last states that the key is now refused.
 */
function exhaust(key: string, now: number): { first: RateLimitDecision; last: RateLimitDecision } {
  const first = checkRateLimit(key, now);

  let last = first;
  for (let call = 1; call < RATE_LIMIT_MAX; call += 1) {
    last = checkRateLimit(key, now);
  }

  return { first, last };
}

/**
 * A request as a runtime delivers it, optionally carrying the caller's connection address.
 *
 * The address is attached as the single `ip` property the key rule reads rather than smuggled in
 * through a header: the request keeps its own headers, and the address arrives the way a runtime
 * that exposes one would supply it. Leaving it out means the runtime supplies none, which is the
 * documented case on the standard Node deployment.
 */
function incomingRequest(options: { address?: unknown; forwardedFor?: string } = {}): Request {
  const headers = new Headers();

  if (options.forwardedFor !== undefined) {
    headers.set('x-forwarded-for', options.forwardedFor);
  }

  const request = new Request(BASE_URL, { method: 'POST', headers });

  return options.address === undefined ? request : Object.assign(request, { ip: options.address });
}

describe('checkRateLimit: the allowance one window grants', () => {
  it('allows the first request and reports the rest of the window as remaining', () => {
    const decision = checkRateLimit('first-caller', BASE);

    expect(decision).toEqual({
      allowed: true,
      remaining: RATE_LIMIT_MAX - 1,
      resetAt: advance(WINDOW),
    });
  });

  it('allows each further request up to the limit, reducing the count by one each time', () => {
    const first = checkRateLimit('steady-caller', BASE);

    expect(first.remaining).toBe(RATE_LIMIT_MAX - 1);

    for (let call = 2; call <= RATE_LIMIT_MAX; call += 1) {
      const decision = checkRateLimit('steady-caller', BASE);

      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(RATE_LIMIT_MAX - call);
      expect(decision.resetAt).toBe(first.resetAt);
    }
  });

  it('denies the request after the tenth in one window without moving the reset time', () => {
    const { first, last } = exhaust('eleventh-call', BASE);

    expect(last.allowed).toBe(true);

    const denied = checkRateLimit('eleventh-call', BASE);

    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.resetAt).toBe(first.resetAt);
  });

  it('reports nothing remaining, never less, however far past the limit a caller goes', () => {
    exhaust('overrun', BASE);

    for (let call = RATE_LIMIT_MAX + 1; call <= RATE_LIMIT_MAX + 10; call += 1) {
      const decision = checkRateLimit('overrun', BASE);

      expect(decision.allowed).toBe(false);
      expect(decision.remaining).toBe(0);
    }
  });
});

describe('checkRateLimit: crossing a window boundary', () => {
  it('opens the next window at the instant the current one ends, with a full allowance', () => {
    // The boundary belongs to the new window: a request exactly at `resetAt` is the first request of
    // the window that follows, not the last request of the one that ended.
    const { first } = exhaust('boundary', BASE);

    const reopened = checkRateLimit('boundary', first.resetAt);

    expect(reopened.allowed).toBe(true);
    expect(reopened.remaining).toBe(RATE_LIMIT_MAX - 1);
    expect(reopened.resetAt).toBe(first.resetAt + WINDOW);
  });

  it('still refuses a request one millisecond before the window ends', () => {
    const { first } = exhaust('just-before', BASE);

    const decision = checkRateLimit('just-before', advance(WINDOW - 1));

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.resetAt).toBe(first.resetAt);
  });

  it('anchors a window on the instant of its own first request', () => {
    const decision = checkRateLimit('late-arrival', advance(WINDOW + 137));

    expect(decision.resetAt).toBe(advance(2 * WINDOW + 137));
  });

  it('starts a key that returns after its window has passed counting from zero again', () => {
    const { first } = exhaust('returning', BASE);
    const secondWindow = first.resetAt;

    const reopened = checkRateLimit('returning', secondWindow);
    const again = checkRateLimit('returning', secondWindow);

    expect(reopened.allowed).toBe(true);
    expect(reopened.remaining).toBe(RATE_LIMIT_MAX - 1);
    expect(again.remaining).toBe(RATE_LIMIT_MAX - 2);
    expect(again.resetAt).toBe(advance(2 * WINDOW));
  });

  it('clears every key whose window has passed, each then starting a window of its own', () => {
    // The module exposes no accessor for its window map, and none is added here: the contract is
    // fixed by 0.5.1 Component 7, so pruning is asserted only through what a caller can observe -
    // after a whole window has gone by, every key receives a full allowance again and counts from
    // zero, exactly as it did the first time it was seen.
    const keys = ['prune-a', 'prune-b', 'prune-c', 'prune-d'];

    for (const key of keys) {
      exhaust(key, BASE);
    }

    for (const key of keys) {
      const decision = checkRateLimit(key, advance(WINDOW));

      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(RATE_LIMIT_MAX - 1);
      expect(decision.resetAt).toBe(advance(2 * WINDOW));
    }
  });

  it('limits each key separately, so an exhausted caller leaves another at full allowance', () => {
    exhaust('key-a', BASE);

    const other = checkRateLimit('key-b', BASE);

    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(RATE_LIMIT_MAX - 1);
    expect(other.resetAt).toBe(advance(WINDOW));
  });
});

describe('checkRateLimit: a denial that is stable', () => {
  it('returns the same denial for a repeat and for a request later in the window', () => {
    exhaust('stable', BASE);

    const firstDenial = checkRateLimit('stable', BASE);
    const repeatedDenial = checkRateLimit('stable', BASE);
    const laterDenial = checkRateLimit('stable', advance(WINDOW - 1));

    expect(firstDenial.allowed).toBe(false);
    expect(repeatedDenial).toEqual(firstDenial);
    expect(laterDenial).toEqual(firstDenial);
  });
});

/*
 * The trust assumption, in this suite's own words, from 0.5.3 and 0.5.1 Component 7: a limiter is
 * only as trustworthy as the identity it counts against. An address the runtime itself supplies is
 * worth having, because the caller cannot choose it. `x-forwarded-for` is not such an address - a
 * caller can write it per request - so it is honoured only where the deployment is known to
 * overwrite it, and ignored outright in the posture that ships. Where neither is available every
 * caller shares one bucket: the ceiling still holds, it is simply not claimed to be per client.
 * What follows asserts that rule and nothing beyond it.
 */
describe('resolveRateLimitKey: the identity a request counts against', () => {
  it('counts a request against the address the runtime supplies', () => {
    const request = incomingRequest({ address: '203.0.113.7' });

    expect(resolveRateLimitKey(request)).toBe('203.0.113.7');
  });

  it('gives one address one key and two addresses different keys', () => {
    const first = resolveRateLimitKey(incomingRequest({ address: '203.0.113.7' }));
    const repeat = resolveRateLimitKey(incomingRequest({ address: '203.0.113.7' }));
    const other = resolveRateLimitKey(incomingRequest({ address: '198.51.100.2' }));

    expect(repeat).toBe(first);
    expect(other).not.toBe(first);
  });

  it('shares one bucket among all callers the runtime supplies no address for', () => {
    const first = resolveRateLimitKey(incomingRequest());
    const second = resolveRateLimitKey(incomingRequest());

    expect(first).toBe(SHARED_BUCKET_KEY);
    expect(second).toBe(SHARED_BUCKET_KEY);
  });

  it('ignores x-forwarded-for in the shipped posture, which a caller could write itself', () => {
    expect(TRUSTED_PROXY_HEADERS).toBe(false);

    const first = resolveRateLimitKey(incomingRequest({ forwardedFor: '203.0.113.9' }));
    const second = resolveRateLimitKey(incomingRequest({ forwardedFor: '198.51.100.2' }));

    // Two callers presenting different forwarded identities still resolve to one budget, which is
    // what stops the header being a way around the limit.
    expect(first).toBe(SHARED_BUCKET_KEY);
    expect(second).toBe(SHARED_BUCKET_KEY);
  });

  it('honours the first entry of x-forwarded-for where the deployment overwrites it', () => {
    const padded = incomingRequest({ forwardedFor: ' 203.0.113.9 , 198.51.100.2' });
    const single = incomingRequest({ forwardedFor: '198.51.100.2' });

    expect(resolveRateLimitKey(padded, true)).toBe('203.0.113.9');
    expect(resolveRateLimitKey(single, true)).not.toBe('203.0.113.9');
  });

  it('prefers the address the runtime supplies over any forwarded header', () => {
    const request = incomingRequest({ address: '203.0.113.7', forwardedFor: '203.0.113.9' });

    expect(resolveRateLimitKey(request, true)).toBe('203.0.113.7');
  });

  it('falls back to the shared bucket when a trusted header carries nothing usable', () => {
    const empty = incomingRequest({ forwardedFor: '' });
    const blankFirst = incomingRequest({ forwardedFor: ' , 203.0.113.9' });

    expect(resolveRateLimitKey(empty, true)).toBe(SHARED_BUCKET_KEY);
    expect(resolveRateLimitKey(blankFirst, true)).toBe(SHARED_BUCKET_KEY);
    expect(resolveRateLimitKey(incomingRequest(), true)).toBe(SHARED_BUCKET_KEY);
  });

  it('ignores a runtime address that is empty or is not a string', () => {
    expect(resolveRateLimitKey(incomingRequest({ address: '' }))).toBe(SHARED_BUCKET_KEY);
    expect(resolveRateLimitKey(incomingRequest({ address: 42 }))).toBe(SHARED_BUCKET_KEY);
  });

  it('limits callers sharing a bucket together even when each sends a different header', () => {
    const firstKey = resolveRateLimitKey(incomingRequest({ forwardedFor: '203.0.113.9' }));
    const secondKey = resolveRateLimitKey(incomingRequest({ forwardedFor: '198.51.100.2' }));

    expect(secondKey).toBe(firstKey);

    exhaust(firstKey, BASE);

    expect(checkRateLimit(secondKey, BASE).allowed).toBe(false);
  });
});

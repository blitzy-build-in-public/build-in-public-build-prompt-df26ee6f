/**
 * The per-source cost ceiling: how many draft requests one client identity may make inside one
 * window, and when a refused caller may try again.
 *
 * A public endpoint that spends money on every call needs a bound of its own (NFR-2), and this is
 * it - a fixed-window counter held in module state, independent of how large a single input is. The
 * first request for a key opens a window and is allowed; requests are counted against that window
 * until `RATE_LIMIT_WINDOW_MS` has passed, and a request past `RATE_LIMIT_MAX` is refused with
 * `resetAt` naming when the count clears. Nothing here is scheduled, persisted or shared, so no
 * timer runs and no state outlives the process (NFR-5).
 *
 * Two limitations are stated here rather than left to be discovered, and `README.md` publishes the
 * same two:
 *
 * 1. The counter is in-memory, so it is per instance. N instances allow N x `RATE_LIMIT_MAX`
 *    requests per window, and a restart clears every count. That is the trade the plan accepts for a
 *    single-instance tool (0.3.1 rejects a shared store; 0.7.2 excludes Redis and hosted limiters),
 *    and it is also why `src/app/api/generate/route.ts` must stay stateless: nothing here can be
 *    coordinated with a second process, so the handler may not depend on state of its own either.
 * 2. The key is only as trustworthy as what the deployment supplies. With no runtime-supplied
 *    connection address, every caller shares one bucket, and `x-forwarded-for` is honoured only
 *    under a guarantee that the deployment overwrites it - as a bare header it is client-settable,
 *    so honouring it by default would let one caller rotate identities straight past the limit.
 *    {@link resolveRateLimitKey} carries that decision.
 *
 * The module returns a decision and never throws. The `RATE_LIMITED` sentence and its 429 status
 * belong to `src/lib/errors.ts`, and the route handler raises them with the `resetAt` reported here;
 * importing that module from this one would bury the response's wording inside the counter.
 *
 * Server-only by tier (0.5.1): it holds process state and counts against the limits the validation
 * module declares, so no client component may import it. It reads no environment variable of its
 * own - the trusted-proxy guarantee below is a code-level constant.
 */

import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '@/lib/validation';

/**
 * The bucket every caller shares while the deployment supplies no identity for them.
 *
 * Reached only where no runtime address is available and no trusted proxy supplies one, so on a
 * plain Node deployment the whole instance is limited as a single caller. A runtime address is an
 * IP literal, so a key spelled this way cannot collide with one.
 */
export const SHARED_BUCKET_KEY = 'shared-bucket';

/**
 * Whether this deployment is known to overwrite `x-forwarded-for` before a request arrives.
 *
 * Off by default, and deliberately a code-level constant rather than an environment variable: the
 * runtime configuration is closed at `OPENAI_API_KEY`, `OPENAI_MODEL`, `PROMPT_PROVIDER`, `PORT` and
 * `NODE_ENV` (0.3.3 item 3), and a limit a deployment can quietly switch off by setting a variable
 * is a limit nobody can reason about. Turn it on only where a reverse proxy in front of this
 * application is known to replace the header rather than append to it. While it is off the header
 * is ignored outright, because a caller who can set it can send a different value per request and
 * never reach the limit at all.
 */
export const TRUSTED_PROXY_HEADERS = false;

/**
 * One key's counter inside one window.
 *
 * Held in a mutable object rather than replaced on every request so a counted request is one
 * mutation and one read, and so `windowStart` stays the instant of the window's first request for
 * as long as that window lasts.
 */
interface RateLimitWindow {
  /** Epoch milliseconds when this window opened - the `now` of its first request. */
  windowStart: number;
  /** Requests counted in this window, its first request included. */
  count: number;
}

/**
 * The live counters, one entry per key seen inside the current window.
 *
 * Module state on purpose: the limiter has to remember what a caller has spent, and the alternative
 * to remembering it here is a shared store this product does not have and does not need (0.3.1).
 * Bounded because expired entries are removed on access - the map holds at most one entry per key
 * that has made a request within the last `RATE_LIMIT_WINDOW_MS`, and exactly one when every caller
 * resolves to {@link SHARED_BUCKET_KEY}.
 */
const windows = new Map<string, RateLimitWindow>();

/**
 * The outcome of counting one request.
 *
 * `allowed` is the decision. `remaining` and `resetAt` are for the caller's use after that decision
 * - the handler raises `RATE_LIMITED` with `resetAt` so the message can state when the window
 * reopens, and records the same figures in the request log. Neither belongs in a response body:
 * nothing in the wire contract carries a remaining count or a reset time.
 */
export interface RateLimitDecision {
  /** Whether the request may proceed. False once the window's count is past `RATE_LIMIT_MAX`. */
  allowed: boolean;
  /** Requests left in the current window. Never negative, so a refused caller reads zero. */
  remaining: number;
  /** Epoch milliseconds at which the current window ends and the count clears. */
  resetAt: number;
}

/**
 * Whether a window has ended as of `now`.
 *
 * The boundary belongs to the new window: a request exactly `RATE_LIMIT_WINDOW_MS` after the
 * window's first request is the first request of the next one, so "10 requests per 10 minutes"
 * means a caller refused at the limit can return the moment it was told the window reopens.
 */
function isExpired(window: RateLimitWindow, now: number): boolean {
  return now >= window.windowStart + RATE_LIMIT_WINDOW_MS;
}

/**
 * Remove every window this timestamp has left behind.
 *
 * Run from {@link checkRateLimit} in the same pass as its lookup, so the map only ever holds windows
 * that are still counting and there is no timer, no scheduled sweep and nothing running between
 * requests. Deleting an entry during iteration is defined for a `Map`, and an entry removed here is
 * indistinguishable from a key never seen - both are the first request of a new window.
 *
 * @param now Epoch milliseconds to judge every window by.
 */
function pruneExpiredWindows(now: number): void {
  for (const [key, window] of windows) {
    if (isExpired(window, now)) {
      windows.delete(key);
    }
  }
}

/**
 * Count one request against a key and report whether it may proceed.
 *
 * A fixed window: the first request for a key opens a window at `now`, and requests keep counting
 * against it until the window ends, at which point the next request opens the following one. The
 * count is deliberately not reset before the window ends - that is what makes the limit a ceiling
 * per ten minutes rather than a smoothed rate - and the window is per key, so one key's requests
 * never consume another's budget.
 *
 * @param key The client identity from {@link resolveRateLimitKey}. The same key is the same budget;
 *   distinct keys count separately.
 * @param now Epoch milliseconds to judge the window by. Defaults to `Date.now()`; a caller may pass
 *   a fixed sequence of instants instead, which is how the suite crosses a window boundary without
 *   waiting for one.
 * @returns The {@link RateLimitDecision} for this request: whether it is allowed, the requests left
 *   in the current window, and when that window ends.
 */
export function checkRateLimit(key: string, now: number = Date.now()): RateLimitDecision {
  pruneExpiredWindows(now);

  const current = windows.get(key);
  if (current === undefined) {
    // Either this key has not been seen or its window was just pruned; both mean this request opens
    // a window, and the first request of a window is always allowed.
    windows.set(key, { windowStart: now, count: 1 });

    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }

  const count = current.count + 1;
  current.count = count;

  return {
    allowed: count <= RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - count),
    resetAt: current.windowStart + RATE_LIMIT_WINDOW_MS,
  };
}

/**
 * The connection address the runtime itself supplies, when it supplies one.
 *
 * Node's own `Request` carries no peer address, so on the standard Next.js Node deployment this
 * returns `undefined` and the caller falls back to {@link SHARED_BUCKET_KEY}. Some runtimes place
 * the connection's address on the request object - Next.js's `NextRequest` exposed it as `ip` - and
 * that one property is read when it holds a non-empty string. Its absence is the ordinary case, not
 * an error, and no header is consulted here: a value the caller could have written is not an
 * identity.
 *
 * @param request The incoming request.
 * @returns The runtime-supplied client address, or undefined when the runtime exposes none.
 */
function runtimeClientAddress(request: Request): string | undefined {
  const supplied: unknown = (request as { ip?: unknown }).ip;

  return typeof supplied === 'string' && supplied.length > 0 ? supplied : undefined;
}

/**
 * Decide which bucket an incoming request counts against.
 *
 * In priority order, and only the first that applies:
 *
 * 1. An address the runtime itself supplies ({@link runtimeClientAddress}). This is the identity
 *    worth having, because the caller cannot choose it.
 * 2. The first entry of `x-forwarded-for`, and only while `trustProxyHeaders` is true, that is,
 *    only where the deployment is known to overwrite the header. Ignoring it is the safe state: a
 *    caller who controls the header would otherwise present a fresh identity per request and never
 *    be limited.
 * 3. {@link SHARED_BUCKET_KEY} - every such caller shares one budget. This is the outcome on the
 *    documented deployment, so the limit holds against abuse and is not pretended to be per client.
 *
 * @param request The incoming request.
 * @param trustProxyHeaders Whether the deployment overwrites `x-forwarded-for`. Defaults to the
 *   shipped posture, {@link TRUSTED_PROXY_HEADERS}, which is off; passed explicitly where a caller
 *   needs the other posture, which is also how the trusted-proxy path is exercised rather than left
 *   unverified.
 * @returns The key to hand to {@link checkRateLimit}: a client address, or the shared bucket's.
 */
export function resolveRateLimitKey(
  request: Request,
  trustProxyHeaders: boolean = TRUSTED_PROXY_HEADERS,
): string {
  const address = runtimeClientAddress(request);
  if (address !== undefined) {
    return address;
  }

  if (trustProxyHeaders) {
    const client = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (client) {
      return client;
    }
  }

  return SHARED_BUCKET_KEY;
}

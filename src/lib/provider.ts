/**
 * The model provider: the one module that knows which model writes a draft, and the seam that lets
 * the application be developed, tested and demonstrated without a provider credential.
 *
 * A caller asks {@link getProvider} for a {@link Provider} and consumes
 * `generate(request, signal)`. Two implementations are selected by `PROMPT_PROVIDER`: `openai`
 * streams from the OpenAI Responses API, and `stub` returns a fixed draft built from the section
 * skeleton with no network call, no credential and no clock. The stub is what the unit,
 * integration and end-to-end suites run against, and it is refused in production so the test seam
 * cannot ship as the product.
 *
 * Three properties of this module are contract, not style:
 *
 * - **Server-only by tier.** This module reads the provider credential, so no client component may
 *   import it: anything a client component imports enters the browser bundle. The key is never
 *   logged, never placed in an event, never placed in an error message and never returned.
 * - **The environment boundary.** `OPENAI_API_KEY`, `OPENAI_MODEL`, `PROMPT_PROVIDER` and
 *   `NODE_ENV` are read here and nowhere else in the application, and every one of them is read per
 *   request rather than at module scope, so the server starts and answers without a key and a
 *   deployment that adds one needs no restart to pick it up. There is no `NEXT_PUBLIC_` variable.
 * - **No deadline of its own.** `generate` receives the signal the route handler built from the
 *   user's Stop and the handler's own generation deadline, combined there with `AbortSignal.any`.
 *   An abort is therefore never caught, never converted and never
 *   re-tried here: it propagates unchanged so the handler can tell a Stop from a timeout and write
 *   the terminal frame that answers it. Nothing in this module schedules anything.
 *
 * The untrusted-source containment lives one module away: `renderInput` produces the request's
 * `input` from fenced, provenance-labelled and JSON-encoded sources, and `SYSTEM_INSTRUCTION` is
 * the request's `instructions`. The two are passed to the provider as separate fields and are never
 * concatenated, so document text never reaches the instruction role.
 */

import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';

import { AppError } from '@/lib/errors';
import { SECTION_SKELETON } from '@/lib/prompt';
import type { BuildPromptRequest, ProviderEvent } from '@/types';

/**
 * The model a request runs against when `OPENAI_MODEL` names none.
 *
 * It is a string in this one module, so adopting another model is a configuration change rather
 * than a code change: `OPENAI_MODEL` overrides it, and nothing else in the application names a
 * model at all.
 */
export const DEFAULT_MODEL = 'gpt-6-luna';

/**
 * The output cap for one draft, in tokens, covering the model's reasoning as well as the text.
 *
 * It is sized for an eight-section draft over a 60,000-character source with reasoning included,
 * which is what makes the cap a real ceiling on what one allowed request can spend. The route
 * handler passes it in the request; this module falls back to it for a request that names no
 * usable number.
 */
export const MAX_OUTPUT_TOKENS = 16000;

/** The `PROMPT_PROVIDER` value that selects the streaming OpenAI implementation. */
const PROVIDER_OPENAI = 'openai';

/** The `PROMPT_PROVIDER` value that selects the deterministic offline implementation. */
const PROVIDER_STUB = 'stub';

/**
 * The reasoning effort sent with every request.
 *
 * Set explicitly rather than left at the model's default: `low` is the effort OpenAI documents for
 * this model's intended work, and stating it keeps reasoning tokens from crowding out the draft
 * inside {@link MAX_OUTPUT_TOKENS} and from delaying the first streamed text, which is what the
 * interface's latency budget is measured on.
 */
const REASONING_EFFORT = 'low';

/**
 * What the user is told when the provider refused or failed the call.
 *
 * Each sentence is written for the person on the screen and names the next action. None of them
 * carries provider text, a status line or a credential: the SDK's own message for a rejected key
 * embeds a fragment of the key, so no provider message is ever forwarded.
 */
const PROVIDER_MESSAGES = {
  /** 429: the provider is throttling this deployment. */
  busy: 'The model is busy with other requests right now. Wait a few seconds, then try again.',
  /** 401 and 403: the key is absent, wrong or not permitted for this model. */
  refused: 'The model refused this server’s credentials. Check OPENAI_API_KEY, then try again.',
  /** A 5xx or an unclassified provider error. */
  failed: 'The model service failed to answer, so no draft was written. Try again in a moment.',
  /** The provider could not be reached at all. */
  unreachable:
    'The model service could not be reached. Check this server’s network, then try again.',
  /** The stream ended without a terminal event: a killed connection, or an upstream cut. */
  ended: 'The model stopped before the draft was finished. Try again; your inputs are unchanged.',
} as const;

/**
 * The message for a `PROMPT_PROVIDER=stub` deployment.
 *
 * The plan says the stub is refused in production without naming a code, so the reading taken here
 * is recorded in the code itself: the refusal is a typed {@link AppError} with code
 * `PROVIDER_UNAVAILABLE` — 503, the code the failure table gives a provider this server cannot use
 * — rather than a thrown string, a module-scope crash or a silent fallback to the network provider.
 */
const STUB_IN_PRODUCTION_MESSAGE =
  'The stub provider is for development and test only, and this deployment runs in production. Set PROMPT_PROVIDER=openai and provide OPENAI_API_KEY.';

/**
 * The message for a `PROMPT_PROVIDER` value this application does not implement.
 *
 * The accepted values are named; the configured value is deliberately not echoed back into a
 * message that can reach a browser, because it is deployment configuration the user cannot act on.
 */
const UNKNOWN_PROVIDER_MESSAGE =
  'This deployment is configured with an unknown prompt provider. Set PROMPT_PROVIDER to openai or stub.';

/**
 * The one thing the rest of the application calls to get a draft written.
 *
 * `model` is the model this provider will use, which is the value the `meta` frame reports and the
 * request log records. `generate` yields the draft as it is written and ends when it is finished.
 */
export type Provider = {
  /** The model drafts are written with, resolved from `OPENAI_MODEL` or {@link DEFAULT_MODEL}. */
  model: string;
  /**
   * Write one draft, yielding its text in order.
   *
   * @param request The provider-facing request: the trusted `instructions` separated from the
   *   rendered `input` that carries the untrusted source, plus the model and the output cap.
   * @param signal The route handler's combined signal — the user's Stop and the handler's own
   *   generation deadline. It is passed straight to the provider call, so cancellation reaches the
   *   upstream request; this module neither catches nor converts it.
   * @returns An iterable of {@link ProviderEvent}s: `text` events in order, then a `truncated`
   *   event when the provider reported the response as incomplete at the output cap.
   * @throws {AppError} With code `PROVIDER_UNAVAILABLE` when no credential is configured, when the
   *   provider refused or failed the call, or when its stream ended without a terminal event. The
   *   route handler converts that once — to a 503 response before streaming begins, or to the
   *   terminal in-stream `error` frame afterwards.
   */
  generate(request: BuildPromptRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
};

/**
 * Select the provider for the request about to be handled.
 *
 * The selection is made per call and no provider, client or credential is held at module scope, so
 * two requests cannot share state and a test that changes the environment between calls is honoured
 * exactly as a deployment that restarts with a different one would be.
 *
 * `PROMPT_PROVIDER` is compared case-insensitively and an empty value counts as unset, because a
 * variable set to nothing is a deployment that meant to leave the default in place.
 *
 * @returns The provider to generate with: the deterministic offline one, or the one that streams
 *   from the OpenAI Responses API.
 * @throws {AppError} With code `PROVIDER_UNAVAILABLE` for `PROMPT_PROVIDER=stub` under
 *   `NODE_ENV=production` (see {@link STUB_IN_PRODUCTION_MESSAGE}), for a value this application
 *   does not implement, and for the default selection when no `OPENAI_API_KEY` is configured — so a
 *   deployment without a credential answers 503 with an actionable message instead of crashing at
 *   startup or failing in the middle of a stream.
 */
export function getProvider(): Provider {
  const selection = resolveSelection();
  const model = resolveModel();

  switch (selection) {
    case PROVIDER_STUB:
      if (process.env.NODE_ENV === 'production') {
        throw new AppError('PROVIDER_UNAVAILABLE', { message: STUB_IN_PRODUCTION_MESSAGE });
      }
      return createStubProvider(model);
    case PROVIDER_OPENAI:
      // Required before selection succeeds, so a request that cannot possibly be answered fails
      // here — while a status code can still carry the failure — rather than after the stream has
      // begun. `generate` requires it again for the case where the variable disappears between the
      // two, which is the same laziness the plan asks for: read at request time, never at startup.
      requireApiKey();
      return createOpenAiProvider(model);
    default:
      throw new AppError('PROVIDER_UNAVAILABLE', { message: UNKNOWN_PROVIDER_MESSAGE });
  }
}

/**
 * Read `PROMPT_PROVIDER` into the name this module switches on.
 *
 * @returns The configured selection, lower-cased, or `openai` when it is unset or empty.
 */
function resolveSelection(): string {
  const configured = process.env.PROMPT_PROVIDER?.trim().toLowerCase();

  return configured ? configured : PROVIDER_OPENAI;
}

/**
 * Read `OPENAI_MODEL` into the model this provider reports and uses.
 *
 * @returns The configured model, or {@link DEFAULT_MODEL} when it is unset or empty.
 */
function resolveModel(): string {
  const configured = process.env.OPENAI_MODEL?.trim();

  return configured ? configured : DEFAULT_MODEL;
}

/**
 * Read the provider credential, or refuse the request with a typed failure.
 *
 * The empty-string case is treated as absent: the SDK's constructor throws when handed an empty
 * key, and a request that cannot be authenticated is a readable 503 rather than an unhandled
 * failure. The message comes from the errors module's table for this code, which names the
 * configuration step; the key itself is never part of it.
 *
 * @returns The configured key, for the SDK call that consumes it.
 * @throws {AppError} With code `PROVIDER_UNAVAILABLE` when `OPENAI_API_KEY` is unset or empty.
 */
function requireApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new AppError('PROVIDER_UNAVAILABLE');
  }

  return apiKey;
}

/** The response events that end a provider stream, recorded as they arrive. */
type TerminalEvent = 'completed' | 'incomplete' | 'failed';

/**
 * The streaming implementation: OpenAI's Responses API.
 *
 * One request, one call, text yielded as the model writes it. The call streams, so the first text
 * reaches the handler as soon as the model produces it; the response is not buffered anywhere in
 * this module, because buffering is what would turn a progressive interface back into a blocking
 * one.
 *
 * @param model The model resolved at selection time, from `OPENAI_MODEL` or {@link DEFAULT_MODEL}.
 * @returns A provider whose events are `text` per `response.output_text.delta`, then `truncated`
 *   when the stream ended `response.incomplete` — the model was cut off at the output cap — and
 *   nothing when it ended `response.completed`.
 * @throws {AppError} With code `PROVIDER_UNAVAILABLE` when no key is configured at call time, or
 *   when the provider refused, failed or ended the stream without a terminal event. An abort —
 *   the user's Stop or the handler's deadline — is rethrown unchanged and never converted.
 */
function createOpenAiProvider(model: string): Provider {
  return {
    model,
    async *generate(request, signal): AsyncIterable<ProviderEvent> {
      /** Which terminal event the stream ended on; `null` means it ended on none. */
      let terminal: TerminalEvent | null = null;

      try {
        // Built inside the guard rather than outside it: a credential that is absent, refused or
        // unusable by the SDK is a provider this server cannot use, which is reported as
        // `PROVIDER_UNAVAILABLE` — an actionable 503 — and not as an unexplained internal failure.
        const client = createOpenAiClient();
        const stream = await client.responses.create(
          {
            model: modelFor(request, model),
            // The two roles travel in separate fields and are never concatenated: the trusted
            // instruction stays the instruction, and the untrusted rendered source stays data.
            instructions: request.instructions,
            input: request.input,
            stream: true,
            reasoning: { effort: REASONING_EFFORT },
            max_output_tokens: maxOutputTokensFor(request),
          },
          { signal },
        );

        for await (const event of stream) {
          switch (event.type) {
            case 'response.output_text.delta':
              if (event.delta.length > 0) {
                yield { type: 'text', text: event.delta };
              }
              break;
            case 'response.completed':
              terminal = 'completed';
              break;
            case 'response.incomplete':
              // The output cap was reached, so the draft is partial. This is the only source of a
              // `truncated` event: the loop ending proves nothing, since it ends normally on a
              // completion, on an incompletion and on an abort alike.
              terminal = 'incomplete';
              break;
            case 'response.failed':
            case 'error':
              terminal = 'failed';
              break;
            default:
              // Reasoning, tool, usage and lifecycle events carry no draft text.
              break;
          }
        }
      } catch (error) {
        throw toProviderFailure(error, signal);
      }

      // An abort ends the iteration, so it must be tested before the loop's exit is read as an
      // outcome. Nothing is yielded or thrown here for it: the handler owns the Stop it requested
      // and the deadline it set, and it writes the terminal frame that answers either one.
      if (signal.aborted) {
        return;
      }

      switch (terminal) {
        case 'completed':
          return;
        case 'incomplete':
          yield { type: 'truncated' };
          return;
        case 'failed':
          throw new AppError('PROVIDER_UNAVAILABLE', { message: PROVIDER_MESSAGES.failed });
        default:
          // Neither terminal event arrived and the signal was never aborted, so the stream was cut
          // off from the outside. Reporting the end of iteration as success here would present a
          // partial draft as a finished one.
          throw new AppError('PROVIDER_UNAVAILABLE', { message: PROVIDER_MESSAGES.ended });
      }
    },
  };
}

/**
 * The model for one call.
 *
 * The request carries the model it was built with — the route handler fills it from the provider's
 * own `model` — so a request that names one is honoured; a request that names none falls back to
 * the model this provider resolved, so the call can never be made with an empty model name.
 *
 * @param request The provider-facing request.
 * @param fallback The model this provider resolved at selection time.
 * @returns The model name to send.
 */
function modelFor(request: BuildPromptRequest, fallback: string): string {
  const requested = typeof request.model === 'string' ? request.model.trim() : '';

  return requested === '' ? fallback : requested;
}

/**
 * The output cap for one call.
 *
 * A value that cannot be a token count — absent, zero, negative or fractional — is replaced by
 * {@link MAX_OUTPUT_TOKENS} rather than forwarded, since the cap is the only ceiling on what one
 * request can spend and a malformed one would remove it.
 *
 * @param request The provider-facing request.
 * @returns The cap in tokens.
 */
function maxOutputTokensFor(request: BuildPromptRequest): number {
  const { maxOutputTokens } = request;

  return Number.isInteger(maxOutputTokens) && maxOutputTokens > 0
    ? maxOutputTokens
    : MAX_OUTPUT_TOKENS;
}

/**
 * Build the SDK client for one call.
 *
 * Constructed here rather than at module scope for two reasons: the constructor throws when handed
 * no key, which must be a readable 503 for the request that needed it rather than a failure at
 * import time; and nothing about the client is then held across requests.
 *
 * @returns A client authenticated with the configured key.
 * @throws {AppError} With code `PROVIDER_UNAVAILABLE` when no key is configured.
 */
function createOpenAiClient(): OpenAI {
  return new OpenAI({ apiKey: requireApiKey() });
}

/**
 * Turn a caught provider failure into the error the caller reports, leaving an abort alone.
 *
 * The abort case is the reason this function exists rather than a plain `catch`: an abort is the
 * user's Stop or the handler's deadline, both of which the handler already knows about, so it is
 * returned unchanged and never given a code, a message or a retryability of its own.
 *
 * @param error The caught value, exactly as the `catch` bound it.
 * @param signal The signal handed to the same call.
 * @returns The error to throw: an abort as it stands, an {@link AppError} already carrying a code,
 *   or a new `AppError` with code `PROVIDER_UNAVAILABLE` and a sentence written for the user.
 */
function toProviderFailure(error: unknown, signal: AbortSignal): Error {
  if (error instanceof AppError) {
    return error;
  }

  if (signal.aborted || error instanceof APIUserAbortError) {
    return error instanceof Error
      ? error
      : new AppError('PROVIDER_UNAVAILABLE', { message: PROVIDER_MESSAGES.ended });
  }

  return new AppError('PROVIDER_UNAVAILABLE', { message: describeProviderFailure(error) });
}

/**
 * Choose the sentence for a provider failure from what the SDK reported.
 *
 * Only the status is read. The SDK's own message is never used, because its 401 message embeds a
 * fragment of the presented key.
 *
 * @param error The caught value.
 * @returns One of the sentences in {@link PROVIDER_MESSAGES}, each naming the next action.
 */
function describeProviderFailure(error: unknown): string {
  if (error instanceof APIConnectionError) {
    return PROVIDER_MESSAGES.unreachable;
  }

  if (error instanceof APIError) {
    if (error.status === 429) {
      return PROVIDER_MESSAGES.busy;
    }
    if (error.status === 401 || error.status === 403) {
      return PROVIDER_MESSAGES.refused;
    }
  }

  return PROVIDER_MESSAGES.failed;
}

/**
 * The stub's draft, one element per section of {@link SECTION_SKELETON} in that order.
 *
 * Built once, at module load, from the same skeleton the system instruction is built from, so the
 * stub cannot drift from the structure a draft is meant to follow.
 */
const STUB_SECTIONS: readonly string[] = SECTION_SKELETON.map(
  (section) => `## ${section}\n\n${clarificationMarker(section)}\n\n`,
);

/**
 * The `[NEEDS CLARIFICATION: …]` marker the stub writes in place of a section's content.
 *
 * @param section The section name, named in the marker so a reader can see which part of the
 *   skeleton was left unfilled.
 * @returns The marker line.
 */
function clarificationMarker(section: string): string {
  const missing = `the stub provider writes a fixed draft, so nothing under "${section}" was read from your source`;

  return `[NEEDS CLARIFICATION: ${missing}.]`;
}

/**
 * The stub implementation: a deterministic draft, with no network call and no credential.
 *
 * The text is assembled from {@link SECTION_SKELETON} and yielded one section at a time, so the
 * stream's frame order, the client's progressive rendering and the terminal frame are exercised
 * exactly as they are against the real provider. The draft itself is fixed: a stub that varied with
 * its input would make every suite that asserts on it untrustworthy, and it is given no source to
 * describe, so each section states that nothing was read from the source instead of inventing
 * content — the same `[NEEDS CLARIFICATION: …]` convention the system instruction gives the model.
 *
 * This is what makes the unit, integration and end-to-end suites offline and credential-free, and
 * what a developer runs locally with `PROMPT_PROVIDER=stub`.
 *
 * @param model The model this provider reports. It is resolved the same way the streaming
 *   implementation resolves it, so the `meta` frame and the request log have one shape whichever
 *   provider is selected.
 * @returns A provider that yields the draft one section at a time and never fails.
 */
function createStubProvider(model: string): Provider {
  return {
    model,
    async *generate(_request, signal): AsyncIterable<ProviderEvent> {
      for (const section of STUB_SECTIONS) {
        // A Stop and the handler's deadline end this generator the same way they end the streaming
        // one, so the stop control behaves identically against both implementations.
        if (signal.aborted) {
          return;
        }
        yield { type: 'text', text: section };
      }
    },
  };
}

/**
 * The provider seam.
 *
 * The OpenAI SDK is mocked, so both implementations are observable offline: the suite runs with no
 * network access and no credential, exactly as the plan requires of every unit suite. What is
 * asserted here is the contract the route handler depends on — how provider selection reads the
 * environment, how stream events become provider events, how failures become the user's sentence,
 * and that an abort is never turned into a failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError, APIUserAbortError } from 'openai';

import { AppError } from '@/lib/errors';
import { SECTION_SKELETON } from '@/lib/prompt';
import { DEFAULT_MODEL, MAX_OUTPUT_TOKENS, getProvider } from '@/lib/provider';
import type { BuildPromptRequest, ProviderEvent } from '@/types';

/** The mocked SDK: one `responses.create` whose outcome each test sets, and the options it saw. */
const sdk = vi.hoisted(() => ({ create: vi.fn(), clientOptions: [] as unknown[] }));

vi.mock('openai', async () => {
  const actual = await vi.importActual<typeof import('openai')>('openai');

  class StubOpenAI {
    readonly responses = { create: sdk.create };

    constructor(options: unknown) {
      sdk.clientOptions.push(options);
    }
  }

  // The error classes stay real, so the provider's failure mapping is exercised against the types
  // it will actually catch.
  return { ...actual, default: StubOpenAI };
});

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'PROMPT_PROVIDER', 'NODE_ENV'] as const;

/** The environment as a mutable record: `NODE_ENV` is declared readonly on `ProcessEnv`. */
const env = process.env as Record<string, string | undefined>;

const TEST_KEY = 'not-a-real-credential';

const REQUEST: BuildPromptRequest = {
  instructions: 'Draft a build prompt from the source below.',
  input: '<<<SOURCE_BEGIN>>>\nuntrusted source\n<<<SOURCE_END>>>',
  model: DEFAULT_MODEL,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
};

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = env[key];
  }
  sdk.create.mockReset();
  sdk.clientOptions.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
});

/** An iterable of the raw SDK events, however many a test needs. */
async function* streamOf(...events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) {
    yield event;
  }
}

function selectOpenAi(model?: string): void {
  env.PROMPT_PROVIDER = 'openai';
  env.OPENAI_API_KEY = TEST_KEY;
  if (model !== undefined) {
    env.OPENAI_MODEL = model;
  }
}

function selectStub(): void {
  env.PROMPT_PROVIDER = 'stub';
  delete env.OPENAI_API_KEY;
}

async function collect(
  provider: ReturnType<typeof getProvider>,
  signal: AbortSignal,
  request: BuildPromptRequest = REQUEST,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];

  for await (const event of provider.generate(request, signal)) {
    events.push(event);
  }

  return events;
}

function textOf(events: ProviderEvent[]): string {
  return events
    .filter((event): event is { type: 'text'; text: string } => event.type === 'text')
    .map((event) => event.text)
    .join('');
}

function catchSync(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

async function catchAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('getProvider', () => {
  it('selects the stub with no credential and reports the default model', () => {
    selectStub();

    expect(getProvider().model).toBe(DEFAULT_MODEL);
  });

  it.each(['stub', 'openai'])('honours OPENAI_MODEL for the %s provider', (selection) => {
    env.OPENAI_MODEL = 'model-under-test-9';
    if (selection === 'openai') {
      selectOpenAi('model-under-test-9');
    } else {
      selectStub();
    }

    expect(getProvider().model).toBe('model-under-test-9');
  });

  it('treats a blank PROMPT_PROVIDER as unset', () => {
    selectOpenAi();
    env.PROMPT_PROVIDER = '   ';

    expect(getProvider().model).toBe(DEFAULT_MODEL);
  });

  it.each(['gemini', 'azure'])('refuses the unimplemented PROMPT_PROVIDER=%s', (selection) => {
    env.PROMPT_PROVIDER = selection;
    env.OPENAI_API_KEY = TEST_KEY;

    const error = catchSync(() => getProvider()) as AppError;

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.message).toContain('openai');
    expect(error.message).toContain('stub');
  });

  it('refuses the stub under NODE_ENV=production', () => {
    selectStub();
    env.NODE_ENV = 'production';

    const error = catchSync(() => getProvider()) as AppError;

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.message).toContain('development and test');
  });

  it('refuses the openai selection with no key, before constructing a client', () => {
    env.PROMPT_PROVIDER = 'openai';
    env.OPENAI_API_KEY = TEST_KEY;
    getProvider();

    delete env.OPENAI_API_KEY;
    const error = catchSync(() => getProvider()) as AppError;

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('OPENAI_API_KEY');
    expect(sdk.clientOptions).toHaveLength(0);
  });
});

describe('the openai provider', () => {
  it('turns text deltas into text events and reports truncation only for an incomplete response', async () => {
    selectOpenAi();
    sdk.create.mockResolvedValue(
      streamOf(
        { type: 'response.output_text.delta', delta: '## Overview' },
        { type: 'response.output_text.delta', delta: '\n\nBody' },
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' } },
        },
      ),
    );

    expect(await collect(getProvider(), new AbortController().signal)).toEqual([
      { type: 'text', text: '## Overview' },
      { type: 'text', text: '\n\nBody' },
      { type: 'truncated' },
    ]);
  });

  it('reports no truncation when the response completed', async () => {
    selectOpenAi();
    sdk.create.mockResolvedValue(
      streamOf(
        { type: 'response.output_text.delta', delta: 'draft' },
        { type: 'response.completed', response: {} },
      ),
    );

    expect(await collect(getProvider(), new AbortController().signal)).toEqual([
      { type: 'text', text: 'draft' },
    ]);
  });

  it('ignores events that carry no draft text', async () => {
    selectOpenAi();
    sdk.create.mockResolvedValue(
      streamOf(
        { type: 'response.created', response: {} },
        { type: 'response.reasoning_text.delta', delta: 'thinking' },
        { type: 'response.output_text.delta', delta: '' },
        { type: 'response.output_text.delta', delta: 'text' },
        { type: 'response.completed', response: {} },
      ),
    );

    expect(await collect(getProvider(), new AbortController().signal)).toEqual([
      { type: 'text', text: 'text' },
    ]);
  });

  it('calls the API with the documented arguments, the roles kept apart', async () => {
    selectOpenAi();
    sdk.create.mockResolvedValue(streamOf({ type: 'response.completed', response: {} }));
    const signal = new AbortController().signal;

    await collect(getProvider(), signal);

    expect(sdk.create).toHaveBeenCalledTimes(1);
    const [body, options] = sdk.create.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(body).toEqual({
      model: DEFAULT_MODEL,
      instructions: REQUEST.instructions,
      input: REQUEST.input,
      stream: true,
      reasoning: { effort: 'low' },
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });
    expect(body.instructions as string).not.toContain('untrusted source');
    expect(body.input as string).toContain('untrusted source');
    expect(options).toEqual({ signal });
    expect(sdk.clientOptions).toEqual([{ apiKey: TEST_KEY }]);
  });

  it.each([
    [
      'a blank model and no cap',
      { model: '   ', maxOutputTokens: 0 },
      DEFAULT_MODEL,
      MAX_OUTPUT_TOKENS,
    ],
    [
      'a named model and cap',
      { model: 'custom-model-4', maxOutputTokens: 512 },
      'custom-model-4',
      512,
    ],
  ])('uses %s', async (_case, overrides, model, cap) => {
    selectOpenAi();
    sdk.create.mockResolvedValue(streamOf({ type: 'response.completed', response: {} }));

    await collect(getProvider(), new AbortController().signal, { ...REQUEST, ...overrides });

    const [body] = sdk.create.mock.calls[0] as [Record<string, unknown>];
    expect(body.model).toBe(model);
    expect(body.max_output_tokens).toBe(cap);
  });

  it.each([
    ['ends without a terminal event', [{ type: 'response.output_text.delta', delta: 'half' }]],
    ['reports a failed response', [{ type: 'response.failed', response: {} }]],
    [
      'reports an error event',
      [{ type: 'error', code: 'server_error', message: 'up', param: null }],
    ],
  ])('refuses the draft when the stream %s', async (_case, events) => {
    selectOpenAi();
    sdk.create.mockResolvedValue(streamOf(...events));

    const error = (await catchAsync(async () =>
      collect(getProvider(), new AbortController().signal),
    )) as AppError;

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('Try again');
  });

  it.each([
    [
      'a rate limit',
      new APIError(429, undefined, 'Rate limit reached for gpt-6-luna', undefined),
      /busy/i,
    ],
    [
      'a rejected key',
      new APIError(
        401,
        undefined,
        'Incorrect API key provided: fragment-of-the-presented-key',
        undefined,
      ),
      /credentials/i,
    ],
    [
      'a denied key',
      new APIError(403, undefined, 'Project does not have access', undefined),
      /credentials/i,
    ],
    [
      'a provider fault',
      new APIError(500, undefined, 'internal server error', undefined),
      /failed to answer/i,
    ],
    [
      'an unreachable host',
      new APIConnectionError({ message: 'fetch failed to api.openai.com' }),
      /could not be reached/i,
    ],
  ])('maps %s to an actionable failure without provider text', async (_case, failure, expected) => {
    selectOpenAi();
    sdk.create.mockRejectedValue(failure);

    const error = (await catchAsync(async () =>
      collect(getProvider(), new AbortController().signal),
    )) as AppError;

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.message).toMatch(expected);
    expect(error.message).not.toContain('fragment-of-the-presented-key');
    expect(error.message).not.toContain('Incorrect API key');
    expect(error.message).not.toContain('api.openai.com');
  });

  it('requires the key again at call time, when it disappeared after selection', async () => {
    selectOpenAi();
    const provider = getProvider();

    delete env.OPENAI_API_KEY;
    const error = (await catchAsync(async () =>
      collect(provider, new AbortController().signal),
    )) as AppError;

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.message).toContain('OPENAI_API_KEY');
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('leaves an abort unchanged when the SDK rejects with one', async () => {
    selectOpenAi();
    const controller = new AbortController();
    const abortError = new APIUserAbortError({ message: 'Request was aborted.' });
    sdk.create.mockRejectedValue(abortError);
    controller.abort();

    await expect(collect(getProvider(), controller.signal)).rejects.toBe(abortError);
  });

  it('ends without a fabricated outcome when the signal aborted the iteration', async () => {
    selectOpenAi();
    const controller = new AbortController();
    sdk.create.mockResolvedValue(
      streamOf({ type: 'response.output_text.delta', delta: 'partial' }),
    );
    controller.abort();

    expect(await collect(getProvider(), controller.signal)).toEqual([
      { type: 'text', text: 'partial' },
    ]);
  });
});

describe('the stub provider', () => {
  it('writes the eight sections offline, with no credential and no client', async () => {
    selectStub();

    const events = await collect(getProvider(), new AbortController().signal);

    for (const section of SECTION_SKELETON) {
      expect(textOf(events)).toContain(`## ${section}`);
    }
    expect(textOf(events)).toContain('[NEEDS CLARIFICATION:');
    expect(events.every((event) => event.type === 'text')).toBe(true);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.clientOptions).toHaveLength(0);
  });

  it('writes the same draft for every request', async () => {
    selectStub();

    const first = await collect(getProvider(), new AbortController().signal);
    const second = await collect(getProvider(), new AbortController().signal, {
      ...REQUEST,
      input: 'different source',
      maxOutputTokens: 32,
    });

    expect(first).toEqual(second);
  });

  it('yields nothing once the signal has aborted', async () => {
    selectStub();
    const controller = new AbortController();
    controller.abort();

    expect(await collect(getProvider(), controller.signal)).toEqual([]);
  });
});

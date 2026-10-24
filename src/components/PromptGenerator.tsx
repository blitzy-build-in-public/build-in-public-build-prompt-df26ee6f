'use client';

import { useCallback, useId, useRef, useState, type JSX } from 'react';

import { DraftPanel } from '@/components/DraftPanel';
import { FilePicker } from '@/components/FilePicker';
import { StatusBanner } from '@/components/StatusBanner';
import { parseEventStream } from '@/lib/sse';
import type { ErrorCode, ErrorEvent, Limits } from '@/types';
import styles from './PromptGenerator.module.css';

/**
 * The state the generation is in, at any moment, on this screen.
 *
 * This union is authoritative: it is declared here and nowhere else. `StatusBanner.tsx` and
 * `DraftPanel.tsx` mirror it under their own names rather than importing it, because a type-only
 * edge back to this module would close an import cycle and leave them unable to type-check on
 * their own, and `src/types/index.ts` deliberately keeps this client-only union out of the shared
 * contract module. The compiler still holds all three in step, because this component passes its
 * own state to both of them: a divergence that matters fails `tsc --noEmit` at those call sites.
 */
export type PromptGenerationStatus =
  'idle' | 'validating' | 'extracting' | 'streaming' | 'done' | 'error';

/**
 * Props of {@link PromptGenerator}.
 *
 * The component is rendered by the server page `src/app/page.tsx`, which reads these caps from the
 * server-only validation module and passes them down as data. That is how the browser checks the
 * server's own numbers without the validation module - and zod with it - ever entering the browser
 * bundle.
 */
export interface PromptGeneratorProps {
  /**
   * The limits the server enforces, in the client-safe shape. `maxDescriptionChars` bounds the
   * pasted field; the other three travel on to the file picker unchanged.
   */
  limits: Limits;
}

/**
 * The user's own sentence, reproduced verbatim as the input region's instruction line.
 *
 * It opens the region whose two inputs sit directly beneath it, which is what its "below" refers
 * to; it is not page copy and is not repeated in the header. It is exported so that the page shell
 * and the tests name the same string rather than repeating it.
 */
export const INSTRUCTION_LINE =
  'Add a file or paste a description or requirements below, and I can get started generating a draft of your build prompt.';

/** The one endpoint this screen talks to: the POST that streams the draft back. */
const ENDPOINT = '/api/generate';

/** The request fields the route handler reads, and the only two it reads. */
const DESCRIPTION_FIELD = 'description';
const FILES_FIELD = 'files';

/**
 * The failure reported when the response was not a usable error envelope.
 *
 * A failure whose cause cannot be read from the response is still the user's to act on, so it is
 * reported as retryable and in the same shape every other failure takes. The wording is generic on
 * purpose: an unexpected exception's own message can name internals, and nothing internal belongs
 * on the screen.
 */
const UNREADABLE_RESPONSE_ERROR: ErrorEvent = {
  type: 'error',
  code: 'INTERNAL_ERROR',
  message: 'The request could not be completed. Try again in a moment.',
  retryable: true,
};

/**
 * The failure reported when the stream ended before its terminal frame, or the request itself could
 * not be completed over the network.
 *
 * `PROVIDER_ERROR` is the contract's code for "the provider failed after streaming began", and it
 * is the closest truthful one here: the request was already on the wire, so no status code could
 * carry anything else. Retryable, because the user's next action is to send the same inputs again
 * and those inputs are still on screen.
 */
const INTERRUPTED_STREAM_ERROR: ErrorEvent = {
  type: 'error',
  code: 'PROVIDER_ERROR',
  message: 'The connection ended before the draft finished. Try again to generate it again.',
  retryable: true,
};

/**
 * Reads a failed response's JSON error envelope, falling back to a generic retryable failure when
 * the body is missing, is not JSON, or does not carry the three contract fields.
 *
 * @param response A response whose status was not ok.
 * @returns The envelope to report: the server's own three fields, or
 *   {@link UNREADABLE_RESPONSE_ERROR}.
 */
async function readErrorEnvelope(response: Response): Promise<ErrorEvent> {
  try {
    const body: unknown = await response.json();

    if (
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      'message' in body &&
      'retryable' in body &&
      typeof body.code === 'string' &&
      typeof body.message === 'string' &&
      typeof body.retryable === 'boolean'
    ) {
      return {
        // The shared `ErrorEvent` adds only its discriminant to the envelope's three fields, so a
        // pre-stream envelope is adopted as-is with that discriminant supplied.
        type: 'error',
        // The codes come from this application's own server and are a closed set; nothing here
        // branches on the value, so an unknown one would still be shown rather than acted on.
        code: body.code as ErrorCode,
        message: body.message,
        retryable: body.retryable,
      };
    }
  } catch {
    // No body, or a body that is not JSON: the generic failure below is what the user sees.
  }

  return UNREADABLE_RESPONSE_ERROR;
}

/**
 * The screen's controller: it owns the form state and the whole request lifecycle, and its three
 * presentational children own the rendering of the inputs, the status and the draft.
 *
 * The draft streams over the same POST that submits the inputs, so partial text is visible while
 * the model writes. Everything that can fail before streaming begins arrives as a JSON envelope
 * with a status code; everything that fails afterwards arrives as a terminal `error` frame, because
 * the status line is already on the wire - and both are reported the same way, because both are the
 * same three fields. The inputs are never cleared on failure, so Retry re-sends exactly what the
 * user supplied.
 *
 * @param props - See {@link PromptGeneratorProps}.
 */
export function PromptGenerator({ limits }: PromptGeneratorProps): JSX.Element {
  // Ids for the region's heading, the field and its counter. They are derived from one `useId()`
  // so they stay unique when the component is rendered more than once, and so the association
  // between the label, the field and the counter survives server rendering.
  const baseId = useId();
  const instructionId = `${baseId}-instruction`;
  const descriptionId = `${baseId}-description`;
  const counterId = `${baseId}-counter`;

  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<PromptGenerationStatus>('idle');
  const [draft, setDraft] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<ErrorEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const busy = status === 'validating' || status === 'extracting' || status === 'streaming';
  const canSubmit = description.trim().length > 0 || files.length > 0;

  /**
   * Sends the supplied requirements and consumes the streamed draft.
   *
   * Nothing is sent twice at once: a call made while a request is in flight returns immediately, and
   * the same guard covers the empty submission the disabled Generate button already prevents. The
   * request-scoped state is cleared as the request starts, so each generation's draft, warnings and
   * failure belong to it alone.
   */
  const submit = useCallback(async (): Promise<void> => {
    if (status === 'validating' || status === 'extracting' || status === 'streaming') {
      return;
    }
    if (description.trim().length === 0 && files.length === 0) {
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setWarnings([]);
    setTruncated(false);
    setDraft('');
    setStatus('validating');

    let terminalReceived = false;

    try {
      const body = new FormData();
      body.append(DESCRIPTION_FIELD, description);
      // The field name is repeated per file, which is how a multipart body carries a list. No
      // content type is set: the browser has to write it itself, boundary and all.
      files.forEach((file) => body.append(FILES_FIELD, file, file.name));

      const response = await fetch(ENDPOINT, {
        method: 'POST',
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        setError(await readErrorEnvelope(response));
        setStatus('error');
        return;
      }

      setStatus('extracting');

      await parseEventStream(
        response,
        (event) => {
          switch (event.type) {
            case 'meta':
              // The first frame says what was accepted, refused or shortened, so the reader learns
              // it before the draft arrives rather than inside it.
              setWarnings(event.warnings);
              setStatus('streaming');
              break;

            case 'delta':
              // Appended in arrival order, one frame at a time: buffering the whole draft before
              // rendering would turn a streaming interface back into a blocking one.
              setDraft((previous) => previous + event.text);
              break;

            case 'done':
              terminalReceived = true;
              setTruncated(event.truncated);
              setStatus('done');
              break;

            case 'error':
              terminalReceived = true;
              setError(event);
              setStatus('error');
              break;

            default: {
              // Compile-time guard: a frame kind added to the contract later must fail the build
              // here rather than pass through unhandled.
              const unreachable: never = event;
              return unreachable;
            }
          }
        },
        controller.signal,
      );

      // The codec rejects when a stream ends without a terminal frame; a codec that instead
      // resolved on a truncated body must not be read as a finished draft, so the same failure is
      // reported here.
      if (!terminalReceived && !controller.signal.aborted) {
        setError(INTERRUPTED_STREAM_ERROR);
        setStatus('error');
      }
    } catch {
      // A Stop aborts the fetch as well as the read, and the abort is the user's own decision: the
      // state stop() set is left exactly as it is instead of being reported as a failure.
      if (!controller.signal.aborted) {
        setError(INTERRUPTED_STREAM_ERROR);
        setStatus('error');
      }
    } finally {
      // A request that has finished must not leave a controller behind for a later Stop to abort.
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [description, files, status]);

  /**
   * Aborts the generation in progress.
   *
   * The abort reaches both ends of the request: it cancels the `fetch` and the stream read in the
   * browser, and the server propagates the same abort to the model call, so what is stopped is the
   * work being billed rather than only the rendering of it. The draft, the warnings and the
   * cut-off flag stay as they are - what was already written is still the reader's to edit, copy
   * or download - and the banner reports the stop from the transition back to idle.
   */
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
  }, []);

  /**
   * Runs the failed generation again with the inputs already supplied.
   *
   * They were never cleared, on success or on failure, so a retry re-sends exactly what the user
   * typed and chose.
   */
  const retry = useCallback(() => {
    void submit();
  }, [submit]);

  /** Adds the files the picker accepted to the submission. */
  const addFiles = useCallback((added: File[]) => {
    setFiles((previous) => [...previous, ...added]);
  }, []);

  /** Drops the file at `index`, leaving the rest in the order they were added. */
  const removeFile = useCallback((index: number) => {
    setFiles((previous) => previous.filter((_, position) => position !== index));
  }, []);

  /** Keeps the edited draft in this component's state, which stays the authoritative copy. */
  const handleDraftChange = useCallback((next: string) => {
    setDraft(next);
  }, []);

  /**
   * Notification hook: `DraftPanel` writes the draft to the clipboard itself and calls this only
   * once the write succeeded, so there is nothing left for this component to do about it.
   */
  const handleCopy = useCallback(() => {
    // Deliberately empty - the copy has already happened, and its confirmation belongs to the
    // panel that made it.
  }, []);

  /**
   * Notification hook: `DraftPanel` builds the `.md` download itself and calls this once it has
   * triggered it, so there is no export work to repeat or track here.
   */
  const handleDownload = useCallback(() => {
    // Deliberately empty - the download has already been triggered by the panel.
  }, []);

  return (
    <>
      <section
        className={[styles.region, busy ? styles.busy : undefined].filter(Boolean).join(' ')}
        aria-labelledby={instructionId}
      >
        <h2 id={instructionId} className={styles.instruction}>
          {INSTRUCTION_LINE}
        </h2>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={descriptionId}>
            Requirements or description
          </label>
          <textarea
            id={descriptionId}
            className={styles.textarea}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            // A courtesy pre-check, the same kind the picker makes: it keeps an obvious over-limit
            // mistake off the wire, while the server's own check remains the authoritative gate.
            maxLength={limits.maxDescriptionChars}
            aria-describedby={counterId}
            rows={8}
            disabled={busy}
          />
          <p id={counterId} className={styles.counter}>
            {description.length} / {limits.maxDescriptionChars} characters
          </p>
        </div>

        <FilePicker
          files={files}
          onAdd={addFiles}
          onRemove={removeFile}
          disabled={busy}
          maxFiles={limits.maxFiles}
          maxFileBytes={limits.maxFileBytes}
          acceptedExtensions={limits.acceptedExtensions}
        />

        <div className={styles.controls}>
          <button
            type="button"
            className={[styles.button, busy || !canSubmit ? styles.buttonDisabled : undefined]
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              void submit();
            }}
            disabled={busy || !canSubmit}
          >
            Generate draft
          </button>
        </div>
      </section>

      <StatusBanner
        status={status}
        error={error}
        warnings={warnings}
        truncated={truncated}
        onRetry={retry}
        onStop={stop}
      />

      <DraftPanel
        value={draft}
        onChange={handleDraftChange}
        status={status}
        onCopy={handleCopy}
        onDownload={handleDownload}
      />
    </>
  );
}

export default PromptGenerator;

'use client';

import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import type { ErrorEvent } from '@/types';
import styles from './StatusBanner.module.css';

/**
 * The status the banner describes, mirroring `PromptGenerationStatus` exported by
 * `src/components/PromptGenerator.tsx`.
 *
 * Written out again rather than imported: that module imports this one, so importing its type would
 * close a cycle and leave this file untypecheckable on its own. `src/types/index.ts` carries the
 * contract shared by both tiers and deliberately leaves this client-only union out of it. Drift is
 * caught by the compiler instead of by convention — `PromptGenerator.tsx` passes its own state into
 * the `status` prop below, so a divergence that matters fails `tsc --noEmit` at that call site.
 */
export type StatusBannerStatus =
  'idle' | 'validating' | 'extracting' | 'streaming' | 'done' | 'error';

/**
 * Props for {@link StatusBanner}.
 *
 * `error` is the shared contract's `ErrorEvent`, which adds only its discriminant to the pre-stream
 * `GenerateErrorEnvelope`, so the parent passes either shape without converting it. Its `message` is
 * written by the server for the person looking at the screen and names the next action, so it is
 * rendered verbatim.
 */
export interface StatusBannerProps {
  /** The state the generation is in. */
  status: StatusBannerStatus;
  /** The failure to report, or null while none is current. */
  error: ErrorEvent | null;
  /** User-facing sentences from the `meta` frame: files dropped, documents truncated. */
  warnings: readonly string[];
  /** True when the terminal `done` frame reported the model was cut off at its output limit. */
  truncated: boolean;
  /** Runs the failed generation again with the inputs the user has already supplied. */
  onRetry: () => void;
  /** Aborts the generation in progress, keeping the draft written so far. */
  onStop: () => void;
}

/**
 * What the banner says in each state.
 *
 * Every sentence is complete prose naming the next action rather than a code. The `error` entry is a
 * neutral line only, because the failure block below carries the server's own message.
 */
const STATUS_SENTENCES: Record<StatusBannerStatus, string> = {
  idle: 'Ready: add a file or paste requirements, then choose Generate.',
  validating: 'Checking the submitted inputs.',
  extracting: 'Reading the attached documents.',
  streaming:
    'Writing the draft. The text appears as it is written, and you can stop at any time, keeping what was produced.',
  done: 'The draft is ready to edit, copy or download.',
  error: 'Generation did not finish. The message below says what happened and what to do next.',
};

/** Shown instead of the idle sentence once a generation has been stopped. */
const STOPPED_SENTENCE =
  'Generation was stopped. The draft below holds what was written before you stopped it, so you can edit, copy or download it, or generate again when you are ready.';

/**
 * Appended to the status sentence when the model was cut off at its output limit.
 *
 * The notice below carrying the full wording is visible text rather than a live region, so the
 * announcement — the only element a screen reader voices — is what reports that the draft is
 * partial. A draft presented as complete when it is not would be worse than a wordy sentence.
 */
const PARTIAL_DRAFT_CLAUSE = 'It was cut off before the end, so part of it may be missing.';

/**
 * The visible cut-off notice: the fact for a reader who arrives at it later, and the next action for
 * one who has just seen it appear.
 */
const CUT_OFF_NOTICE =
  'The draft was cut off at the model output limit; generate again for a complete draft, or supply a shorter source with the essentials.';

/**
 * Appended to the status sentence when the warning list is not empty, so the reader knows that the
 * notes below need attention. None of the sentences themselves is repeated here: the status region
 * is the announcement, and the list is the detail.
 */
function warningClause(count: number): string {
  return count === 1
    ? 'One note about your input is listed below.'
    : `${count} notes about your input are listed below.`;
}

/**
 * The screen's live region: what is happening now, what the server dropped or shortened, and — when
 * something fails — the actionable message together with the way out of it.
 *
 * The banner and its status sentence are always rendered, whatever the state, because a live region
 * mounted at the same moment its text appears is not reliably announced. The component owns no
 * request state: `src/components/PromptGenerator.tsx` owns the state machine and the request
 * lifecycle, and hands down the current status, the failure (if any), the warnings from the stream's
 * `meta` frame and the cut-off flag from its terminal `done` frame. Styling comes only from the class
 * names in `StatusBanner.module.css`.
 *
 * Stop is offered only while a draft is streaming, and it is this screen's only Stop control. The
 * actions are rendered conditionally in the markup rather than hidden with CSS, so a control that is
 * not available is not in the document at all.
 */
export function StatusBanner({
  status,
  error,
  warnings,
  truncated,
  onRetry,
  onStop,
}: StatusBannerProps): JSX.Element {
  const [stoppedNotice, setStoppedNotice] = useState(false);
  const previousStatusRef = useRef<StatusBannerStatus>(status);

  // Stopping returns the screen to the same `idle` status it starts in, so only the transition can
  // say that a generation was stopped: remember the previous status, latch the notice when streaming
  // ends in idle, and release it as soon as any other state begins. Both outcomes are expressed as
  // one update whose value is that transition, because the two-branch form writes state on every
  // status change and is rejected by the lint gate this repository grades a change against
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    const justStopped = previousStatus === 'streaming' && status === 'idle';
    const startedAgain = status !== 'idle' && status !== previousStatus;
    if (justStopped || startedAgain) setStoppedNotice(justStopped);
  }, [status]);

  const showStoppedNotice = stoppedNotice && status === 'idle';
  const sentenceParts = [showStoppedNotice ? STOPPED_SENTENCE : STATUS_SENTENCES[status]];
  if (truncated) sentenceParts.push(PARTIAL_DRAFT_CLAUSE);
  if (warnings.length > 0) sentenceParts.push(warningClause(warnings.length));
  const sentence = sentenceParts.join(' ');

  return (
    <div className={styles.banner}>
      <p className={styles.status} role="status" aria-live="polite">
        {sentence}
      </p>

      {warnings.length > 0 && (
        <ul className={styles.warnings}>
          {warnings.map((warning, index) => (
            <li className={styles.warningItem} key={index}>
              {warning}
            </li>
          ))}
        </ul>
      )}

      {truncated && <p className={styles.notice}>{CUT_OFF_NOTICE}</p>}

      {error !== null && (
        <div className={styles.error} role="alert">
          <p className={styles.errorMessage}>{error.message}</p>
          {error.retryable && (
            <div className={styles.actions}>
              <button
                type="button"
                className={[styles.button, styles.retryButton].filter(Boolean).join(' ')}
                onClick={onRetry}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {status === 'streaming' && (
        <div className={styles.actions}>
          <button
            type="button"
            className={[styles.button, styles.stopButton].filter(Boolean).join(' ')}
            onClick={onStop}
          >
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

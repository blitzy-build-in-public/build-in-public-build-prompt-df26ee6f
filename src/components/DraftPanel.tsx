'use client';

import { useEffect, useId, useRef, useState } from 'react';

import styles from './DraftPanel.module.css';

/**
 * Mirrors `PromptGenerationStatus` exported by `src/components/PromptGenerator.tsx`.
 *
 * It is declared here rather than imported: `PromptGenerator.tsx` imports this module, so a
 * type-only edge back to it would close a cycle and leave this file unable to type-check on its
 * own, and `src/types/index.ts` deliberately keeps the client status union out of the shared
 * contract module. Divergence cannot pass unnoticed, because `PromptGenerator.tsx` hands its own
 * state to the `status` prop below: a mismatch that matters fails `tsc --noEmit` at that call
 * site. Do not add a member the authoritative union does not have.
 */
export type DraftPanelStatus =
  'idle' | 'validating' | 'extracting' | 'streaming' | 'done' | 'error';

/**
 * Props of {@link DraftPanel}.
 *
 * The panel is presentational: it fetches nothing, aborts nothing and parses no stream, so
 * everything it shows and everything it reports arrives through these five members.
 */
export interface DraftPanelProps {
  /** The draft text. Rendered verbatim as text, never as markup. */
  value: string;
  /** Receives the field's whole new value on every edit, keeping the parent's state authoritative. */
  onChange: (value: string) => void;
  /** The screen's state machine, read here only for `aria-busy`, the streaming outline and focus. */
  status: DraftPanelStatus;
  /** Called once the draft is on the clipboard; not called when the copy is blocked or fails. */
  onCopy: () => void;
  /** Called once the `.md` download has been triggered. */
  onDownload: () => void;
}

/** How long the copy confirmation stays on screen before it clears itself. */
const CONFIRMATION_VISIBLE_MS = 2000;

/** Shown briefly after a successful copy. */
const COPY_CONFIRMED_MESSAGE = 'Copied to the clipboard.';

/** Shown when the clipboard is unavailable or refuses the write, naming what to do instead. */
const COPY_BLOCKED_MESSAGE =
  'Copying was blocked by the browser. Select the draft and copy it manually.';

/**
 * Builds the download name, `build-prompt-<yyyyMMdd-HHmmss>.md`, from local time with
 * zero-padded fields.
 *
 * `now` is a parameter so the stamp can be asserted without touching the clock.
 */
function buildDownloadFilename(now: Date = new Date()): string {
  const pad = (part: number): string => String(part).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  return `build-prompt-${stamp}.md`;
}

/**
 * Holds the generated draft and gets it out of the application: an editable text field with a live
 * character count, a Copy action and a `.md` download.
 *
 * The draft is displayed as text only. It is Markdown written by a model from untrusted documents,
 * so it never reaches an HTML parser, a Markdown renderer, a link preview or an image — that is
 * what keeps generated output from becoming an injection and output-handling surface. The field
 * stays editable at all times, including while the draft is still streaming in, because a draft is
 * something the reader revises.
 *
 * @param props - See {@link DraftPanelProps}.
 */
export function DraftPanel({ value, onChange, status, onCopy, onDownload }: DraftPanelProps) {
  const baseId = useId();
  const textareaId = `${baseId}-draft`;
  const countId = `${baseId}-count`;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const confirmationTimerRef = useRef<number | null>(null);
  const previousStatusRef = useRef<DraftPanelStatus>('idle');
  const [confirmation, setConfirmation] = useState<string | null>(null);

  // Cancel a pending confirmation timer on unmount, so nothing updates state after teardown.
  useEffect(() => {
    return () => {
      if (confirmationTimerRef.current !== null) {
        window.clearTimeout(confirmationTimerRef.current);
        confirmationTimerRef.current = null;
      }
    };
  }, []);

  // Move focus to the draft when a generation completes, so a keyboard user can revise the draft
  // immediately. Keyed on the transition rather than on the value, so it neither fires twice nor
  // takes focus back from someone who has already started editing.
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;

    if (status === 'done' && previousStatus !== 'done') {
      textareaRef.current?.focus();
    }
  }, [status]);

  const isDraftEmpty = value.length === 0;

  const showConfirmation = (message: string): void => {
    setConfirmation(message);

    if (confirmationTimerRef.current !== null) {
      window.clearTimeout(confirmationTimerRef.current);
    }

    confirmationTimerRef.current = window.setTimeout(() => {
      confirmationTimerRef.current = null;
      setConfirmation(null);
    }, CONFIRMATION_VISIBLE_MS);
  };

  const handleCopy = async (): Promise<void> => {
    if (isDraftEmpty) {
      return;
    }

    // Feature-detected rather than assumed: `navigator.clipboard` is absent outside a secure
    // context, and a write can still be refused by permission. Either way the reader is told what
    // to do instead, and the failure never reaches the caller as a throw.
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      showConfirmation(COPY_BLOCKED_MESSAGE);
      return;
    }

    try {
      await clipboard.writeText(value);
    } catch {
      showConfirmation(COPY_BLOCKED_MESSAGE);
      return;
    }

    showConfirmation(COPY_CONFIRMED_MESSAGE);
    onCopy();
  };

  const handleDownload = (): void => {
    if (isDraftEmpty) {
      return;
    }

    const blob = new Blob([value], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = buildDownloadFilename();
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }

    onDownload();
  };

  const panelClassName = [styles.panel, status === 'streaming' ? styles.busy : undefined]
    .filter(Boolean)
    .join(' ');
  const actionClassName = [styles.button, isDraftEmpty ? styles.buttonDisabled : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    /*
      The region carries no accessible name of its own on purpose: an `aria-label` or
      `aria-labelledby` here would give the label below a second owner, so a name-based query for
      the draft field would resolve to two elements. The field is named by its own <label>, and the
      page's landmarks come from `layout.tsx` and `page.tsx`.
    */
    <section className={panelClassName} aria-busy={status === 'streaming'}>
      <label className={styles.label} htmlFor={textareaId}>
        Your draft build prompt
      </label>

      {/*
        Text, never markup. The draft is model output written from untrusted documents, so an HTML
        or Markdown renderer, a link preview or an inline image here would turn generated content
        into an injection surface. Keep it a plain text field.
      */}
      <textarea
        id={textareaId}
        ref={textareaRef}
        className={styles.draft}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={countId}
        // Section headings, identifiers and `[NEEDS CLARIFICATION: ...]` markers are not
        // misspellings, so a squiggle under them is only noise.
        spellCheck={false}
      />

      <div className={styles.meta}>
        <p className={styles.charCount} id={countId}>
          {value.length} characters
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={actionClassName}
            onClick={() => {
              void handleCopy();
            }}
            disabled={isDraftEmpty}
          >
            Copy
          </button>
          <button
            type="button"
            className={actionClassName}
            onClick={handleDownload}
            disabled={isDraftEmpty}
          >
            Download
          </button>
        </div>
      </div>

      {/*
        Always rendered, so the live region exists before its text changes and the sentence is
        announced when it arrives. Its line is reserved by the stylesheet, so the field above never
        moves as the confirmation appears and clears.
      */}
      <p className={styles.confirmation} role="status" aria-live="polite">
        {confirmation}
      </p>
    </section>
  );
}

export default DraftPanel;

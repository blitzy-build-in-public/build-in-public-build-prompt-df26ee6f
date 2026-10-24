/**
 * Unit suite for the draft region, `src/components/DraftPanel.tsx` (AAP 0.5.1 Component 14): the
 * field the reader revises, its live character count, and the two ways the draft leaves the
 * application - the clipboard and a timestamped `.md` download - together with the output-handling
 * control that keeps generated Markdown from ever becoming markup (FR-6, NFR-2).
 *
 * Three harness decisions carry the suite:
 *
 * - A pinned clock. `Date`, `setTimeout` and `clearTimeout` are faked and set to one fixed instant,
 *   so the download stamp and the transient copy confirmation are asserted exactly and no case
 *   depends on the wall clock (AAP 0.11.2). The expected stamp is derived through the same local
 *   getters the panel uses, so the suite passes in every timezone.
 * - `fireEvent` rather than `user-event`. React Testing Library's async wrapper drains its microtask
 *   queue through a real `setTimeout` and only advances fake timers when Jest is present, so a
 *   `user-event` interaction under Vitest's fake timers never settles. `fireEvent` is synchronous
 *   and timer-agnostic, and each awaited state update is flushed inside `act`.
 * - Stubs only where jsdom is silent. jsdom implements neither the clipboard nor the object-URL
 *   statics, so those are installed by property descriptor and removed again, and the download
 *   anchor is captured from the click's receiver. Nothing about the panel's own logic is simulated,
 *   and the suite needs no network, no credential and no disk.
 */
import { useState } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { DraftPanel, type DraftPanelStatus } from '@/components/DraftPanel';

/** The panel's own label for its field. Queried by accessible name, which is part of what is asserted. */
const DRAFT_FIELD_LABEL = 'Your draft build prompt';

/** How long the copy confirmation stays on screen (`CONFIRMATION_VISIBLE_MS` in the panel). */
const CONFIRMATION_VISIBLE_MS = 2000;

/** Shown after a copy the browser accepted. */
const COPY_CONFIRMED_MESSAGE = 'Copied to the clipboard.';

/** Shown when the clipboard is missing or refuses the write. */
const COPY_BLOCKED_MESSAGE =
  'Copying was blocked by the browser. Select the draft and copy it manually.';

/** What the download path must create, and therefore release again. */
const MOCK_OBJECT_URL = 'blob:blitzy-draft-panel-test';

/** The text a case types into the field. */
const EDIT = 'Revised by hand.';

/** Every status the screen can be in, taken from the panel's own union so a new member fails here. */
const STATUSES = [
  'idle',
  'validating',
  'extracting',
  'streaming',
  'done',
  'error',
] as const satisfies readonly DraftPanelStatus[];

/**
 * A realistic draft - all eight sections the prompt template fixes, numbered requirements and a
 * clarification marker - so the character count, the copied text and the downloaded blob all carry
 * content that a length or an encoding mistake would show up in.
 */
const DRAFT = `# Build Prompt

## Overview
A single screen that turns requirements into a draft build prompt.

## Goals and Non-goals
Goals: stream a draft the reader can edit. Non-goals: store anything.

## Functional Requirements
1. Accept a requirements file or pasted text.
2. Stream the draft while the model writes it.

## Non-Functional Requirements
1. The first text is visible within seconds of submitting.

## Technical Constraints and Preferred Stack
TypeScript, strict.

## Deliverables
A draft the reader can edit, copy and download.

## Acceptance Criteria
1. [NEEDS CLARIFICATION: which document formats must be accepted?]

## Open Questions
1. [NEEDS CLARIFICATION: is authentication in scope?]
`;

/**
 * A draft that tries to become markup: an event-handler image, a script, a `javascript:` link, a
 * remote image and an iframe. Rendered as text it is inert; rendered as markup it would be an
 * injection and output-handling surface.
 */
const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '[link](javascript:alert(1))',
  '![alt](http://example.invalid/x.png)',
  '<iframe src="http://example.invalid"></iframe>',
].join('\n');

/**
 * One unambiguous instant. The clock is pinned to it, so `new Date()` inside the panel is this
 * instant whatever timezone the suite runs in.
 */
const FIXED_INSTANT = new Date('2026-03-04T05:06:07Z');

/**
 * The download name's stamp, `yyyyMMdd-HHmmss`, read through **local** getters - the same fields, in
 * the same order, the panel uses. Deriving it here rather than hard-coding a string is what makes
 * the assertion timezone-independent.
 */
function localStamp(now: Date): string {
  const pad = (part: number): string => String(part).padStart(2, '0');

  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** The panel's declared filename for the pinned instant. */
const EXPECTED_FILENAME = `build-prompt-${localStamp(FIXED_INSTANT)}.md`;

/** A callback the panels under test do not care about. */
const noop = (): void => undefined;

interface HarnessProps {
  initialValue?: string;
  status?: DraftPanelStatus;
  onCopy?: () => void;
  onDownload?: () => void;
}

/**
 * A controlled host for {@link DraftPanel}.
 *
 * The panel is controlled, so an edit only becomes observable when its parent feeds the new value
 * back: this is the smallest parent that does, and the current value is exposed through the
 * field's own value rather than through a test-only hook. Nothing else about the panel is
 * simulated - the clipboard write and the download are its real code paths.
 */
function Harness({
  initialValue = '',
  status = 'idle',
  onCopy = noop,
  onDownload = noop,
}: HarnessProps) {
  const [value, setValue] = useState(initialValue);

  return (
    <DraftPanel
      value={value}
      onChange={setValue}
      status={status}
      onCopy={onCopy}
      onDownload={onDownload}
    />
  );
}

/** The draft field, narrowed to the element the cases type into and read back. */
function getDraftField(): HTMLTextAreaElement {
  const field = screen.getByRole('textbox', { name: DRAFT_FIELD_LABEL });

  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error('The draft field is not a textarea.');
  }

  return field;
}

/** The panel's polite live region, which carries the copy confirmation. */
function getConfirmationRegion(): HTMLElement {
  return screen.getByRole('status');
}

/** One of the panel's named action buttons. */
function getButton(name: 'Copy' | 'Download'): HTMLButtonElement {
  const button = screen.getByRole('button', { name });

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`The ${name} control is not a button.`);
  }

  return button;
}

/** The clipboard write the panel calls. jsdom implements no clipboard at all. */
const writeText = vi.fn<(text: string) => Promise<void>>();

/** The object URL the download creates. jsdom implements neither object-URL static. */
const createObjectURL = vi.fn<(blob: Blob) => string>();

/** The object URL release the download performs. */
const revokeObjectURL = vi.fn<(url: string) => void>();

/** Every anchor the download control clicked, captured from the click handler's receiver. */
const clickedAnchors: HTMLAnchorElement[] = [];

/**
 * Defines `target[key]`, whether or not the property exists.
 *
 * `vi.spyOn` cannot stand in for an implementation jsdom never had, so the property is defined
 * before the case and removed after it.
 */
function stubProperty(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

/** Removes a stub, so no case inherits one from another. */
function unstubProperty(target: object, key: string): void {
  Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  createObjectURL.mockReset();
  createObjectURL.mockReturnValue(MOCK_OBJECT_URL);
  revokeObjectURL.mockReset();

  stubProperty(navigator, 'clipboard', { writeText });
  stubProperty(URL, 'createObjectURL', createObjectURL);
  stubProperty(URL, 'revokeObjectURL', revokeObjectURL);

  // jsdom neither navigates nor downloads on an anchor click, and the click's receiver is the
  // anchor whose attributes the download control set, so the spy is what reads them back.
  clickedAnchors.length = 0;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ): void {
    clickedAnchors.push(this);
  });

  // The clock, not the wall clock: the download stamp is read from it and the copy confirmation is
  // timed by it. Only the three functions this suite needs are faked, so React and the test runner
  // keep their own scheduling.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(FIXED_INSTANT);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  // `vi.unstubAllGlobals` knows only about `vi.stubGlobal`, and none of these was installed that
  // way, so the descriptors are removed explicitly.
  unstubProperty(navigator, 'clipboard');
  unstubProperty(URL, 'createObjectURL');
  unstubProperty(URL, 'revokeObjectURL');
  clickedAnchors.length = 0;
});

describe('the field the reader revises', () => {
  it.each(STATUSES)(
    'stays editable while the screen is %s, so the draft can always be revised',
    (status) => {
      render(<Harness initialValue={DRAFT} status={status} />);

      const field = getDraftField();
      expect(field).toBeEnabled();
      expect(field).not.toHaveAttribute('readonly');

      fireEvent.change(field, { target: { value: EDIT } });

      expect(field).toHaveValue(EDIT);
    },
  );

  it('reports an edit to its parent as the whole new value', () => {
    const onChange = vi.fn<(value: string) => void>();
    const edited = `${DRAFT}One more paragraph.`;

    render(
      <DraftPanel
        value={DRAFT}
        onChange={onChange}
        status="streaming"
        onCopy={noop}
        onDownload={noop}
      />,
    );

    fireEvent.change(getDraftField(), { target: { value: edited } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(edited);
  });
});

/** The drafts the character count is asserted for, with the name each case is reported under. */
const COUNT_CASES: ReadonlyArray<readonly [string, string]> = [
  ['an empty draft', ''],
  ['a draft with every section', DRAFT],
];

describe('the live character count', () => {
  it.each(COUNT_CASES)('shows the current length for %s and follows an edit', (_label, initial) => {
    render(<Harness initialValue={initial} status="idle" />);

    const field = getDraftField();
    expect(screen.getByText(`${initial.length} characters`)).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(`${initial.length} characters`);

    fireEvent.change(field, { target: { value: EDIT } });

    expect(screen.getByText(`${EDIT.length} characters`)).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(`${EDIT.length} characters`);
  });
});

describe('copying the draft', () => {
  it('puts exactly the current text on the clipboard, confirms it, then clears the confirmation', async () => {
    const onCopy = vi.fn<() => void>();
    render(<Harness initialValue={DRAFT} onCopy={onCopy} />);

    const field = getDraftField();
    fireEvent.change(field, { target: { value: EDIT } });
    expect(field).toHaveValue(EDIT);

    await act(async () => {
      fireEvent.click(getButton('Copy'));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(field.value);
    expect(onCopy).toHaveBeenCalledTimes(1);

    const region = getConfirmationRegion();
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent(COPY_CONFIRMED_MESSAGE);

    // The confirmation is transient: present one millisecond before its moment, gone at it.
    await act(async () => {
      vi.advanceTimersByTime(CONFIRMATION_VISIBLE_MS - 1);
    });
    expect(getConfirmationRegion()).toHaveTextContent(COPY_CONFIRMED_MESSAGE);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(getConfirmationRegion()).toBeEmptyDOMElement();
  });

  it('reports a refused clipboard instead of throwing', async () => {
    const onCopy = vi.fn<() => void>();
    writeText.mockRejectedValueOnce(new Error('The clipboard permission was denied.'));

    render(<Harness initialValue={DRAFT} onCopy={onCopy} />);

    // The panel awaits the refused write inside its own guard, so this interaction settles here and
    // no rejected promise escapes the case - an escaped one fails the file under Vitest.
    await act(async () => {
      fireEvent.click(getButton('Copy'));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(getConfirmationRegion()).toHaveTextContent(COPY_BLOCKED_MESSAGE);
    expect(onCopy).not.toHaveBeenCalled();
  });

  it('tells the reader to copy by hand when the browser exposes no clipboard at all', async () => {
    const onCopy = vi.fn<() => void>();
    unstubProperty(navigator, 'clipboard');

    render(<Harness initialValue={DRAFT} onCopy={onCopy} />);

    await act(async () => {
      fireEvent.click(getButton('Copy'));
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(getConfirmationRegion()).toHaveTextContent(COPY_BLOCKED_MESSAGE);
    expect(onCopy).not.toHaveBeenCalled();
  });
});

describe('downloading the draft', () => {
  it('downloads the draft as a Markdown file named for the local time on the pinned clock', async () => {
    const onDownload = vi.fn<() => void>();
    render(<Harness initialValue={DRAFT} onDownload={onDownload} />);

    fireEvent.click(getButton('Download'));

    expect(createObjectURL).toHaveBeenCalledTimes(1);

    const blob = createObjectURL.mock.calls[0]?.[0];
    if (!(blob instanceof Blob)) {
      throw new Error('The download did not build a Blob.');
    }
    expect(blob.type).toMatch(/^text\/markdown/);
    expect(await blob.text()).toBe(DRAFT);

    const anchor = clickedAnchors.at(0);
    if (!(anchor instanceof HTMLAnchorElement)) {
      throw new Error('The download did not click an anchor.');
    }
    expect(anchor.getAttribute('href')).toBe(MOCK_OBJECT_URL);
    expect(anchor.getAttribute('download')).toBe(EXPECTED_FILENAME);
    expect(anchor.getAttribute('download')).toMatch(/^build-prompt-\d{8}-\d{6}\.md$/);

    expect(revokeObjectURL).toHaveBeenCalledWith(MOCK_OBJECT_URL);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('a')).toBeNull();
  });
});

describe('the two ways out of the application', () => {
  it('disables both while the draft is empty and enables them once it holds text', () => {
    render(<Harness initialValue="" status="idle" />);

    expect(getButton('Copy')).toBeDisabled();
    expect(getButton('Download')).toBeDisabled();

    // A click dispatched at a disabled control must still write nothing and download nothing.
    fireEvent.click(getButton('Copy'));
    fireEvent.click(getButton('Download'));

    expect(writeText).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clickedAnchors).toHaveLength(0);

    fireEvent.change(getDraftField(), { target: { value: EDIT } });

    expect(getButton('Copy')).toBeEnabled();
    expect(getButton('Download')).toBeEnabled();
  });
});

describe('generated Markdown as untrusted output', () => {
  it('shows hostile Markdown as text and never turns it into DOM', () => {
    // AAP 0.5.1 Component 14 with NFR-2: the draft is model output written from untrusted
    // documents, so it is displayed as text and never parsed - no HTML, no Markdown renderer, no
    // inline image and no link preview. The panel is the place that decides this.
    const { container } = render(<Harness initialValue={HOSTILE} status="done" />);

    const field = getDraftField();
    expect(field).toHaveValue(HOSTILE);
    expect(field).toBeEnabled();

    expect(container.querySelector('img, script, a, iframe')).toBeNull();
    expect(container.querySelectorAll('[href],[src]')).toHaveLength(0);
  });
});

describe('what the panel announces and where the focus goes', () => {
  it('marks itself busy while the draft streams and not before or after', () => {
    const view = render(<Harness initialValue={DRAFT} status="idle" />);
    expect(view.container.querySelector('section')).toHaveAttribute('aria-busy', 'false');

    view.rerender(<Harness initialValue={DRAFT} status="streaming" />);
    expect(view.container.querySelector('section')).toHaveAttribute('aria-busy', 'true');

    view.rerender(<Harness initialValue={DRAFT} status="done" />);
    expect(view.container.querySelector('section')).toHaveAttribute('aria-busy', 'false');
  });

  it('moves focus to the draft when a generation completes, and only on that transition', () => {
    const view = render(<Harness initialValue={DRAFT} status="idle" />);
    const field = getDraftField();
    expect(document.activeElement).not.toBe(field);

    view.rerender(<Harness initialValue={DRAFT} status="done" />);
    expect(document.activeElement).toBe(field);

    // A reader who has already moved on keeps their place: the panel takes focus on the transition
    // into 'done', not on every render that finds it there.
    const copy = getButton('Copy');
    copy.focus();
    view.rerender(<Harness initialValue={DRAFT} status="done" />);
    expect(document.activeElement).toBe(copy);
  });

  it('leaves the focus alone while the draft streams, so an edit is not interrupted', () => {
    const view = render(<Harness initialValue={DRAFT} status="idle" />);

    const download = getButton('Download');
    download.focus();

    view.rerender(<Harness initialValue={DRAFT} status="streaming" />);

    expect(document.activeElement).toBe(download);
    expect(document.activeElement).not.toBe(getDraftField());
  });
});

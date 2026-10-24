import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

/**
 * The product's only end-to-end test: one pasted requirements paragraph, taken from the page through
 * the streaming endpoint and back out of the application through Copy and Download.
 *
 * It proves the pieces work together rather than in isolation - the page shell renders the reader's
 * own instruction sentence exactly once, the pasted-requirements field enables Generate, the client
 * controller streams a draft from `POST /api/generate` over that one request, and the draft panel
 * carries the draft out with a live character count, a clipboard copy and a `.md` download. The unit
 * and integration suites cover the modules one by one; this spec covers the wiring between them.
 *
 * Everything here leans on `playwright.config.ts` at the repository root: it supplies the `baseURL`
 * that makes the navigation below relative, the single Chromium project, and the `webServer` that
 * starts the application with `PROMPT_PROVIDER=stub`. That stub is what makes this run
 * deterministic, offline and credential-free, so this file reads no provider setting, starts no
 * server and declares no configuration of its own.
 */

/*
  Declared at the top level because Playwright rejects `test.use` inside `beforeEach`/`beforeAll`.
  Chromium grants `navigator.clipboard.readText()` only with `clipboard-read`, and a file-level call
  scopes the grant to this file's context so no other suite inherits it. The Clipboard API needs a
  secure context, which `http://localhost:<PORT>` is.
*/
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/**
 * The reader's own sentence, reproduced from the component that renders it.
 *
 * It is the input region's instruction line and must appear exactly once: the page shell carries the
 * product title alone and does not repeat it.
 */
const INSTRUCTION_SENTENCE =
  'Add a file or paste a description or requirements below, and I can get started generating a draft of your build prompt.';

/** The accessible names this flow drives, as the components label and title them. */
const REQUIREMENTS_LABEL = 'Requirements or description';
const DRAFT_LABEL = 'Your draft build prompt';
const GENERATE_NAME = 'Generate draft';
const COPY_NAME = 'Copy';
const DOWNLOAD_NAME = 'Download';

/** The transient confirmation the draft panel shows once the copy has landed. */
const COPY_CONFIRMATION = 'Copied to the clipboard.';

/**
 * The wording of the completion announcement.
 *
 * It doubles as the discriminator for the status region: three polite live regions exist in the
 * document - this banner's status line, the draft panel's copy confirmation and the file picker's
 * refusal list - so the assertion below filters by the finished wording rather than taking the sole
 * or the first `[aria-live="polite"]` element it can find.
 */
const DONE_ANNOUNCEMENT = /the draft is ready to edit, copy or download\./i;

/**
 * The eight sections of a draft build prompt.
 *
 * They are a constant of the prompt template, so every draft presents all of them whichever provider
 * wrote it. The surrounding prose is deliberately not asserted: it belongs to the stub provider and
 * freezing it here would turn this spec into a change detector for that module's wording.
 */
const SECTION_NAMES = [
  'Overview',
  'Goals and Non-goals',
  'Functional Requirements',
  'Non-Functional Requirements',
  'Technical Constraints and Preferred Stack',
  'Deliverables',
  'Acceptance Criteria',
  'Open Questions',
] as const;

/** What the reader pastes: a short submission of the shape the product exists to accept. */
const PASTED_REQUIREMENTS =
  'An internal tool the buying team uses to turn three supplier price lists into one comparison ' +
  'table. It should run in the browser, need no sign-in, and never store the lists it reads.';

/** Appended to the streamed draft, so both exits below are shown to carry the reader's own edit. */
const DRAFT_REVISION_SUFFIX = '\n\n[Reviewer note: confirm the currency of each price list.]';

/** The download name the draft panel builds: `build-prompt-<yyyyMMdd-HHmmss>.md`. */
const DOWNLOAD_NAME_PATTERN = /^build-prompt-\d{8}-\d{6}\.md$/;

test('a pasted requirements paragraph generates an editable draft that can be copied and downloaded', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByText(INSTRUCTION_SENTENCE, { exact: true })).toHaveCount(1);

  // Both requirements and draft are textboxes on one page, so every query is disambiguated by
  // accessible name; a CSS-module class name is hashed at build time and is never a selector.
  const requirementsField = page.getByRole('textbox', { name: REQUIREMENTS_LABEL });
  const draftField = page.getByRole('textbox', { name: DRAFT_LABEL });
  const generateButton = page.getByRole('button', { name: GENERATE_NAME });

  await expect(generateButton).toBeDisabled();
  await requirementsField.fill(PASTED_REQUIREMENTS);
  await expect(generateButton).toBeEnabled();

  await generateButton.click();

  // The draft arrives while the model writes it, so this waits for the first streamed section rather
  // than for a finished response. `toHaveValue` retries on its own, so nothing here - and nothing
  // anywhere else in this spec - depends on elapsed time.
  await expect(draftField).toHaveValue(/Overview/i);

  const draftText = await draftField.inputValue();
  for (const sectionName of SECTION_NAMES) {
    expect(draftText).toContain(sectionName);
  }

  // The count beside the field has to be the length of the draft in it. The element is reached
  // through the field's own `aria-describedby`, which is the panel's own statement of which node
  // describes this field.
  const countId = (await draftField.getAttribute('aria-describedby')) ?? '';
  expect(countId).not.toBe('');
  const characterCount = page.locator(`[id="${countId}"]`);
  await expect(characterCount).toBeVisible();
  const countText = (await characterCount.textContent()) ?? '';
  expect(Number.parseInt(countText.replace(/\D/g, ''), 10)).toBe(draftText.length);

  // Completion is announced in the polite live region, and focus then moves to the draft so a
  // keyboard user can revise it without reaching for the mouse.
  const statusRegion = page.locator('[aria-live="polite"]').filter({ hasText: DONE_ANNOUNCEMENT });
  await expect(statusRegion).toHaveCount(1);
  await expect(statusRegion).toHaveAttribute('aria-live', 'polite');
  await expect(draftField).toBeFocused();

  // Revising the draft is what an editor does with one, and it is also what shows the field is
  // editable rather than a read-only preview. The revision is the value both exits below must carry,
  // so a field whose edits never reached the panel's state would fail them.
  const revisedDraft = `${draftText}${DRAFT_REVISION_SUFFIX}`;
  await draftField.fill(revisedDraft);

  await page.getByRole('button', { name: COPY_NAME }).click();
  // The confirmation clears itself after two seconds, so it is asserted before anything slower.
  await expect(page.getByText(COPY_CONFIRMATION, { exact: true })).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(revisedDraft);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: DOWNLOAD_NAME }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(DOWNLOAD_NAME_PATTERN);

  // Reading the downloaded file is the point of this step: a name-only assertion would pass against
  // an empty blob. `path()` waits for the download to finish and returns a temporary copy of it,
  // which is right for this local browser - against a remotely connected one it throws, and
  // `createReadStream()` or `saveAs()` would be the portable choice.
  const downloadPath = await download.path();
  expect(await readFile(downloadPath, 'utf8')).toBe(revisedDraft);
});

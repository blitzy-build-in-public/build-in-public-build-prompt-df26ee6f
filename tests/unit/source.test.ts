/**
 * Suite for `src/lib/source.ts` — the source assembly step of the build prompt generator.
 *
 * What it pins: `buildSourceBundle` spends the source budget description-first, keeps the documents
 * in upload order, flags and reports every document the budget cut, returns a document that arrives
 * after the budget is exhausted instead of dropping it, and never throws — so the text the model is
 * given, the counts the `meta` frame reports and the sentences the user reads all come out of one
 * deterministic calculation (FR-3).
 *
 * The warning sentences are asserted verbatim, because they are the contract rather than decoration:
 * they are the text the status banner shows, so a change in wording is a change to what the user
 * reads and should have to be made here as well. The rejection group is exhaustive over the closed
 * `RejectionReason` union, so a reason added to the shared contract fails this suite until a
 * sentence exists for it.
 *
 * Nothing here touches the network, a credential, a file or the wall clock: every input is a string
 * built in memory and assembly is pure. The last group checks the module's two real consumers — the
 * prompt template that renders the bundle and the request log that records its count.
 */
import { describe, expect, it, vi } from 'vitest';

import { logRequest } from '@/lib/log';
import { renderInput } from '@/lib/prompt';
import { buildSourceBundle } from '@/lib/source';
import { MAX_DESCRIPTION_CHARS, MAX_SOURCE_CHARS } from '@/lib/validation';
import type { ExtractedDocument, RejectionReason } from '@/types';

/**
 * One document as extraction hands it over, with the text fixing `chars` so a fixture cannot
 * disagree with itself. `extra` carries the cases a caller's own flags cover.
 */
function document(
  name: string,
  text: string,
  extra: Partial<ExtractedDocument> = {},
): ExtractedDocument {
  return {
    name,
    kind: 'text',
    bytes: text.length,
    chars: text.length,
    text,
    truncated: false,
    ...extra,
  };
}

/** The closed set of reasons a file can be dropped, quoted from the shared contract. */
const REJECTION_REASONS: readonly RejectionReason[] = [
  'unsupported-type',
  'too-large',
  'too-many-files',
  'extraction-failed',
  'empty',
];

/**
 * Every reason a file can be dropped, with the file name and the sentence the user is shown for it.
 *
 * The sentences are written out here rather than derived from the module: they are what the banner
 * renders, so a change to one of them is a change to the product's own words.
 */
const REJECTION_CASES: ReadonlyArray<{
  reason: RejectionReason;
  name: string;
  sentence: string;
}> = [
  {
    reason: 'unsupported-type',
    name: 'notes.rtf',
    sentence:
      '"notes.rtf" is not a supported file type, so it was not read. Save it as .txt, .md, ' +
      '.markdown, .pdf or .docx and add it again.',
  },
  {
    reason: 'too-large',
    name: 'big.pdf',
    sentence:
      '"big.pdf" is larger than the 8 MB limit for one file, so it was not read. Split it into ' +
      'smaller files, or paste the part you need as text, then add it again.',
  },
  {
    reason: 'too-many-files',
    name: 'extra.md',
    sentence:
      '"extra.md" was not read: one request may carry at most 5 files. Remove another file, then ' +
      'add it again.',
  },
  {
    reason: 'extraction-failed',
    name: 'broken.docx',
    sentence:
      '"broken.docx" could not be read, so its text did not reach the draft. Open it in an editor ' +
      'and save a copy as .txt or .md, or paste its requirements as text.',
  },
  {
    reason: 'empty',
    name: 'scan.pdf',
    sentence:
      '"scan.pdf" holds no text that could be read, so it contributed nothing to the draft. If it ' +
      'is a scan or an image, paste its requirements as text instead.',
  },
];

describe('buildSourceBundle, budget order', () => {
  it('keeps a description and two documents that fit, and reports the exact assembled total', () => {
    const description = 'Steer the draft toward a checkout flow.';
    const first = document('brief.md', 'A'.repeat(100));
    const second = document('annexe.pdf', 'B'.repeat(200));

    const bundle = buildSourceBundle(description, [first, second]);

    expect(bundle.description).toBe(description);
    expect(bundle.documents.map((entry) => entry.text)).toEqual(['A'.repeat(100), 'B'.repeat(200)]);
    expect(bundle.documents.map((entry) => entry.chars)).toEqual([100, 200]);
    expect(bundle.documents.map((entry) => entry.truncated)).toEqual([false, false]);
    expect(bundle.sourceChars).toBe(description.length + 300);
    expect(bundle.warnings).toEqual([]);
  });

  it('counts the description first, so a description at its cap displaces no document', () => {
    const description = 'x'.repeat(MAX_DESCRIPTION_CHARS);
    const room = MAX_SOURCE_CHARS - MAX_DESCRIPTION_CHARS;
    const text = 'y'.repeat(room);

    const bundle = buildSourceBundle(description, [document('large.md', text)]);

    expect(bundle.documents[0]?.text).toBe(text);
    expect(bundle.documents[0]?.truncated).toBe(false);
    expect(bundle.warnings).toEqual([]);
    expect(bundle.sourceChars).toBe(MAX_SOURCE_CHARS);
  });

  it('truncates a document at exactly the characters that remain and says so', () => {
    const description = 'Steer the draft.';

    const bundle = buildSourceBundle(description, [document('annexe.md', 'a'.repeat(120_000))]);
    const remaining = MAX_SOURCE_CHARS - description.length;

    expect(bundle.documents[0]?.text).toHaveLength(remaining);
    expect(bundle.documents[0]?.chars).toBe(remaining);
    expect(bundle.documents[0]?.truncated).toBe(true);
    expect(bundle.warnings).toEqual([
      '"annexe.md" was truncated: 59,984 of its 120,000 characters were kept within the ' +
        '60,000-character source budget. Split it into smaller files, or shorten it, then add it ' +
        'again.',
    ]);
    expect(bundle.sourceChars).toBe(MAX_SOURCE_CHARS);
  });

  it('returns a document that arrives after the budget is exhausted without dropping it', () => {
    const bundle = buildSourceBundle('x'.repeat(MAX_DESCRIPTION_CHARS), [
      document('fits.md', 'a'.repeat(MAX_SOURCE_CHARS - MAX_DESCRIPTION_CHARS)),
      document('late.md', 'ignored'),
    ]);

    expect(bundle.documents).toHaveLength(2);
    expect(bundle.documents[1]?.text).toBe('');
    expect(bundle.documents[1]?.chars).toBe(0);
    expect(bundle.documents[1]?.truncated).toBe(true);
    expect(bundle.warnings).toEqual([
      '"late.md" was truncated: 0 of its 7 characters were kept within the 60,000-character ' +
        'source budget. Split it into smaller files, or shorten it, then add it again.',
    ]);
    expect(bundle.sourceChars).toBe(MAX_SOURCE_CHARS);
  });

  it('keeps every document in upload order, whatever the budget does to it', () => {
    const bundle = buildSourceBundle('', [
      document('first.txt', 'one'),
      document('second.md', 'b'.repeat(MAX_SOURCE_CHARS)),
      document('third.pdf', 'three'),
    ]);

    expect(bundle.documents.map((entry) => entry.name)).toEqual([
      'first.txt',
      'second.md',
      'third.pdf',
    ]);
    expect(bundle.documents.map((entry) => entry.truncated)).toEqual([false, true, true]);
    expect(bundle.warnings).toHaveLength(2);
  });

  it('reports each kept count as the length of the text the model receives', () => {
    const bundle = buildSourceBundle('requirements', [
      document('brief.md', 'The requirements.'),
      document('long.md', 'c'.repeat(MAX_SOURCE_CHARS)),
    ]);

    for (const entry of bundle.documents) {
      expect(entry.chars).toBe(entry.text.length);
    }
  });

  it('carries a document that arrived already truncated through as truncated', () => {
    const bundle = buildSourceBundle('', [document('cut.md', 'short', { truncated: true })]);

    expect(bundle.documents[0]?.truncated).toBe(true);
    expect(bundle.warnings).toEqual([]);
  });

  it('returns an empty bundle rather than throwing when there is nothing to assemble', () => {
    expect(buildSourceBundle('', [])).toEqual({
      description: '',
      documents: [],
      sourceChars: 0,
      warnings: [],
    });
  });
});

describe('buildSourceBundle, the budget as a ceiling', () => {
  it('never exceeds the source budget, whatever length the description is', () => {
    const bundle = buildSourceBundle('d'.repeat(MAX_SOURCE_CHARS + 10), [
      document('any.md', 'text'),
    ]);

    expect(bundle.description).toHaveLength(MAX_SOURCE_CHARS);
    expect(bundle.documents[0]?.chars).toBe(0);
    expect(bundle.warnings).toEqual([
      'The pasted description was truncated: its first 60,000 characters were kept within the ' +
        '60,000-character source budget. Shorten it, or put the rest of the detail in a file.',
      '"any.md" was truncated: 0 of its 4 characters were kept within the 60,000-character ' +
        'source budget. Split it into smaller files, or shorten it, then add it again.',
    ]);
    expect(bundle.sourceChars).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
  });

  it('leaves an over-long description whole when it still fits, so its own words are not cut', () => {
    const description = 'd'.repeat(MAX_SOURCE_CHARS);

    const bundle = buildSourceBundle(description, []);

    expect(bundle.description).toBe(description);
    expect(bundle.warnings).toEqual([]);
    expect(bundle.sourceChars).toBe(MAX_SOURCE_CHARS);
  });

  it('never leaves a lone surrogate where the cut falls inside an astral character', () => {
    const text = 'a'.repeat(MAX_SOURCE_CHARS - 1) + '🧭'.repeat(3);

    const bundle = buildSourceBundle('', [document('emoji.md', text)]);
    const kept = bundle.documents[0]?.text ?? '';

    expect(kept).toHaveLength(MAX_SOURCE_CHARS - 1);
    expect(bundle.documents[0]?.chars).toBe(MAX_SOURCE_CHARS - 1);
    expect(kept.charCodeAt(kept.length - 1)).toBe('a'.charCodeAt(0));
    // The kept text survives the JSON encoding the prompt template applies to it, which is what a
    // lone surrogate would break.
    expect(JSON.parse(JSON.stringify(kept))).toBe(kept);
  });
});

describe('buildSourceBundle, the sentences the user reads', () => {
  it('has a case for every reason a file can be dropped', () => {
    expect(REJECTION_CASES.map((entry) => entry.reason).sort()).toEqual(
      [...REJECTION_REASONS].sort(),
    );
  });

  it.each(REJECTION_CASES)(
    'answers a $reason rejection with its own sentence, naming the file',
    ({ reason, name, sentence }) => {
      const bundle = buildSourceBundle('', [], [{ name, reason }]);

      expect(bundle.warnings).toEqual([sentence]);
    },
  );

  it('writes every warning as a complete sentence', () => {
    const bundle = buildSourceBundle(
      '',
      [document('big.md', 'z'.repeat(MAX_SOURCE_CHARS + 1))],
      REJECTION_CASES.map(({ name, reason }) => ({ name, reason })),
    );

    expect(bundle.warnings).toHaveLength(REJECTION_CASES.length + 1);
    for (const warning of bundle.warnings) {
      expect(warning).toMatch(/[.!?]$/);
      expect(warning.length).toBeGreaterThan(40);
    }
    expect(bundle.warnings[0]).toContain('"big.md" was truncated');
  });

  it('appends the rejection sentences after the truncation sentences', () => {
    const bundle = buildSourceBundle(
      '',
      [document('big.md', 'z'.repeat(MAX_SOURCE_CHARS + 1))],
      [
        { name: 'notes.rtf', reason: 'unsupported-type' },
        { name: 'scan.pdf', reason: 'empty' },
      ],
    );

    expect(bundle.warnings.map((warning) => warning.split(' ')[0])).toEqual([
      '"big.md"',
      '"notes.rtf"',
      '"scan.pdf"',
    ]);
  });

  it('defaults the rejections to none, so the two-argument call assembles the same bundle', () => {
    const bundle = buildSourceBundle('requirements', [document('brief.md', 'requirements')]);

    expect(bundle.warnings).toEqual([]);
    expect(bundle.sourceChars).toBe(24);
  });
});

describe('buildSourceBundle, and its consumers', () => {
  it('renders the kept source into the model message, with the truncation in both places', () => {
    const description = 'Steer the draft toward checkout.';
    const bundle = buildSourceBundle(description, [
      document('brief.md', 'The requirements.'),
      document('big.md', 'z'.repeat(MAX_SOURCE_CHARS)),
    ]);
    const input = renderInput(bundle);

    expect(input).toContain(description);
    expect(input).toContain('The requirements.');
    expect(input).toContain('brief.md');
    expect(input).toContain('big.md');
    expect(bundle.documents[1]?.truncated).toBe(true);
    expect(bundle.sourceChars).toBe(MAX_SOURCE_CHARS);
  });

  it('records the assembled total the bundle reports, through the metadata-only log', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const bundle = buildSourceBundle('Steer the draft.', [
      document('brief.md', 'The requirements.'),
    ]);

    logRequest({
      route: 'POST /api/generate',
      status: 200,
      durationMs: 1,
      sourceChars: bundle.sourceChars,
      documentCount: bundle.documents.length,
      rejectedCount: 0,
      truncatedCount: bundle.documents.filter((entry) => entry.truncated).length,
      model: 'stub',
    });

    const line = JSON.parse(String(info.mock.calls[0]?.[0])) as { sourceChars: number };

    expect(line.sourceChars).toBe(bundle.sourceChars);
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });
});

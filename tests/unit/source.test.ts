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
 * built in memory and assembly is pure. The suite is scoped to this module alone: its imports are
 * `src/lib/source.ts` and the two contract modules that one names — `src/lib/validation.ts` for the
 * caps the warning sentences quote, and `@/types` for the shapes it takes and returns.
 */
import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { buildSourceBundle } from '@/lib/source';
import { MAX_DESCRIPTION_CHARS, MAX_SOURCE_CHARS } from '@/lib/validation';
import type { ExtractedDocument, RejectedDocument, RejectionReason } from '@/types';

/**
 * One document as extraction hands it over, with the text fixing `chars` so a fixture cannot
 * disagree with itself. `extra` carries the cases a caller's own flags cover.
 *
 * `bytes` is the UTF-8 byte length of the uploaded file, which is what extraction measures; it is a
 * different quantity from `chars`, a count of UTF-16 code units, and the two diverge as soon as the
 * text holds a non-ASCII character.
 */
function document(
  name: string,
  text: string,
  extra: Partial<ExtractedDocument> = {},
): ExtractedDocument {
  return {
    name,
    kind: 'text',
    bytes: Buffer.byteLength(text, 'utf8'),
    chars: text.length,
    text,
    truncated: false,
    ...extra,
  };
}

/**
 * Whether a string holds an unpaired UTF-16 surrogate code unit.
 *
 * `\p{Surrogate}` matches a code point in the surrogate range, and that range holds exactly a half
 * that lost its partner: a complete astral character is one code point outside it and never matches.
 * The `u` flag is what makes the pattern read code points rather than code units, so this is asked of
 * the whole returned string rather than of one index in it.
 */
function hasLoneSurrogate(text: string): boolean {
  return /\p{Surrogate}/u.test(text);
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

  it('counts a description at its cap first, and truncates the document behind it', () => {
    // The description cap (10,000) sits below the source budget (60,000), which is why the
    // description is counted first and kept whole: a description the route accepted can never be
    // displaced by a document, and a document that does not fit behind it is cut to what remains.
    const description = 'x'.repeat(MAX_DESCRIPTION_CHARS);
    const text = 'y'.repeat(MAX_SOURCE_CHARS);

    const bundle = buildSourceBundle(description, [document('long.md', text)]);
    const kept = bundle.documents[0]?.text ?? '';

    expect(bundle.description).toBe(description);
    expect(bundle.documents[0]?.truncated).toBe(true);
    expect(kept).toHaveLength(MAX_SOURCE_CHARS - MAX_DESCRIPTION_CHARS);
    expect(kept).toBe(text.slice(0, MAX_SOURCE_CHARS - MAX_DESCRIPTION_CHARS));
    expect(bundle.warnings).toHaveLength(1);
    expect(bundle.sourceChars).toBe(MAX_SOURCE_CHARS);
    expect(bundle.sourceChars).toBe(description.length + kept.length);
  });

  it('carries a document through with its own name, kind and byte length', () => {
    // The em dash is one code unit and three bytes, so this document's `bytes` and `chars` differ:
    // the equality below is what shows the byte length survives assembly rather than being
    // recomputed from the text.
    const brief = document('brief.md', 'Requirements — with an em dash.');

    const bundle = buildSourceBundle('', [brief]);

    expect(brief.bytes).toBeGreaterThan(brief.chars);
    expect(bundle.documents[0]).toEqual(brief);
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
    // Two documents that each fit alone and not together, then a third that arrives after the budget
    // is spent: the second is cut to what the first left, the third keeps nothing, and all three come
    // back in the order they were uploaded, each flagged for what happened to it.
    const shared = 40_000;
    const bundle = buildSourceBundle('', [
      document('first.txt', 'a'.repeat(shared)),
      document('second.md', 'b'.repeat(shared)),
      document('third.pdf', 'three'),
    ]);
    const kept = bundle.documents.map((entry) => entry.chars);

    expect(bundle.documents.map((entry) => entry.name)).toEqual([
      'first.txt',
      'second.md',
      'third.pdf',
    ]);
    expect(kept).toEqual([shared, MAX_SOURCE_CHARS - shared, 0]);
    expect(kept[0]).toBeGreaterThan(kept[1] ?? 0);
    expect(kept[1]).toBeGreaterThan(kept[2] ?? 0);
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
    // The budget lands one code unit into the compass emoji: 59,999 ASCII characters, then the high
    // half of a pair. Cutting there would hand the model half a character, so the cut has to step
    // back one code unit, and the kept text is one short of the budget because of it.
    const text = 'a'.repeat(MAX_SOURCE_CHARS - 1) + '🧭'.repeat(3);

    const bundle = buildSourceBundle('', [document('emoji.md', text)]);
    const kept = bundle.documents[0]?.text ?? '';

    expect(hasLoneSurrogate(kept)).toBe(false);
    expect(kept).toHaveLength(MAX_SOURCE_CHARS - 1);
    expect(kept).toBe(text.slice(0, MAX_SOURCE_CHARS - 1));
    expect(kept.charCodeAt(kept.length - 1)).toBe('a'.charCodeAt(0));
    expect(bundle.documents[0]?.chars).toBe(kept.length);
    expect(bundle.documents[0]?.truncated).toBe(true);
  });

  it('spends the whole budget where the cut already falls on a character boundary', () => {
    // An emoji-only document and no description: the budget is even, so it lands after a complete
    // pair and the surrogate rule has nothing to give back.
    const text = '🧭'.repeat(MAX_SOURCE_CHARS / 2 + 1);

    const bundle = buildSourceBundle('', [document('emoji.md', text)]);
    const kept = bundle.documents[0]?.text ?? '';

    expect(hasLoneSurrogate(kept)).toBe(false);
    expect(kept).toHaveLength(MAX_SOURCE_CHARS);
    expect(kept).toBe(text.slice(0, MAX_SOURCE_CHARS));
    expect(bundle.documents[0]?.chars).toBe(MAX_SOURCE_CHARS);
    expect(bundle.sourceChars).toBe(MAX_SOURCE_CHARS);
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

  it('appends the rejection sentences after the truncation sentences, in the order given', () => {
    const rejected: RejectedDocument[] = [
      { name: 'notes.rtf', reason: 'unsupported-type' },
      { name: 'scan.pdf', reason: 'empty' },
    ];
    const overBudget = (): ExtractedDocument =>
      document('big.md', 'z'.repeat(MAX_SOURCE_CHARS + 1));

    const once = buildSourceBundle('', [overBudget()], rejected);
    const twice = buildSourceBundle('', [overBudget()], rejected);

    expect(once.warnings.map((warning) => warning.split(' ')[0])).toEqual([
      '"big.md"',
      '"notes.rtf"',
      '"scan.pdf"',
    ]);
    // Truncation notices first, then the rejections in the order validation produced them - and the
    // same submission assembles the same sentences every time, which is what makes the order a
    // contract rather than an artefact of the run.
    expect(twice.warnings).toEqual(once.warnings);
  });

  it('defaults the rejections to none, so the two-argument call assembles the same bundle', () => {
    const bundle = buildSourceBundle('requirements', [document('brief.md', 'requirements')]);

    expect(bundle.warnings).toEqual([]);
    expect(bundle.sourceChars).toBe(24);
  });
});

/**
 * Unit suite for the submission gate, `src/lib/validation.ts`: the caps the rest of the tree imports,
 * the extension allow-list and the leading-byte confirmation behind it, and every rejection reason
 * this module produces.
 *
 * Everything here is pure. Uploads are handed over as `Uint8Array` content, so the suite needs no
 * DOM, no network and no credential, and each test states the behaviour it asserts rather than the
 * function it calls.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AppError, toErrorEnvelope } from '@/lib/errors';
import {
  ACCEPTED_EXTENSIONS,
  GENERATION_TIMEOUT_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_REQUEST_BYTES,
  MAX_SOURCE_CHARS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  classifyFile,
  descriptionSchema,
  validateSubmission,
} from '@/lib/validation';
import type { SubmittedFile } from '@/lib/validation';
import type { FileKind } from '@/types';

const encoder = new TextEncoder();

const encode = (text: string): Uint8Array => encoder.encode(text);
const decode = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes);
const submitted = (name: string, bytes: Uint8Array): SubmittedFile => ({ name, bytes });
const textFile = (name: string): SubmittedFile =>
  submitted(name, encode('Add a file or paste a description.'));

/** A minimal but genuine PDF header: `%PDF-` followed by a version and an end-of-file marker. */
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46,
]);

/** A minimal ZIP local file header, which is what a `.docx` container opens with. */
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...encode('word/document.xml')]);

/**
 * Run a call that is expected to throw and hand back what it threw, so the throw itself can be
 * inspected rather than only counted.
 */
function catchThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the call to throw, and it returned instead.');
}

/** One allow-listed extension, with content that genuinely is that format. */
const SAMPLES: Array<{ name: string; bytes: Uint8Array; kind: FileKind }> = [
  {
    name: 'brief.txt',
    bytes: encode('Requirements: add a file or paste a description.'),
    kind: 'text',
  },
  { name: 'brief.md', bytes: encode('# Requirements\n'), kind: 'text' },
  { name: 'brief.markdown', bytes: encode('# Requirements\n'), kind: 'text' },
  { name: 'brief.pdf', bytes: PDF_BYTES, kind: 'pdf' },
  { name: 'brief.docx', bytes: DOCX_BYTES, kind: 'docx' },
];

describe('limits', () => {
  it('declares every limit the rest of the tree imports at its specified value', () => {
    expect({
      MAX_FILES,
      MAX_FILE_BYTES,
      MAX_REQUEST_BYTES,
      MAX_DESCRIPTION_CHARS,
      MAX_SOURCE_CHARS,
      RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_MS,
      GENERATION_TIMEOUT_MS,
    }).toEqual({
      MAX_FILES: 5,
      MAX_FILE_BYTES: 8_388_608,
      MAX_REQUEST_BYTES: 16_777_216,
      MAX_DESCRIPTION_CHARS: 10_000,
      MAX_SOURCE_CHARS: 60_000,
      RATE_LIMIT_MAX: 10,
      RATE_LIMIT_WINDOW_MS: 600_000,
      GENERATION_TIMEOUT_MS: 90_000,
    });
  });

  it('declares the extension allow-list in the order the plan states', () => {
    expect(ACCEPTED_EXTENSIONS).toEqual(['.txt', '.md', '.markdown', '.pdf', '.docx']);
  });

  it('sizes the request cap above the file cap and the source cap above the description cap', () => {
    // The caps are independent bounds: a request may legitimately carry more than one maximum-size
    // file, and the pasted description is counted first inside the source budget so that a
    // description within its own cap can never displace a document.
    expect(MAX_REQUEST_BYTES).toBeGreaterThan(MAX_FILE_BYTES);
    expect(MAX_DESCRIPTION_CHARS).toBeLessThan(MAX_SOURCE_CHARS);
  });
});

describe('classifyFile', () => {
  it.each(SAMPLES)(
    'classifies $name from its extension, confirmed by its bytes',
    ({ name, bytes, kind }) => {
      expect(classifyFile(submitted(name, bytes))).toBe(kind);
    },
  );

  it('has a positive sample for every allow-listed extension', () => {
    const covered = SAMPLES.map((sample) => sample.name.slice(sample.name.lastIndexOf('.')));

    expect(new Set(covered)).toEqual(new Set(ACCEPTED_EXTENSIONS));
  });

  it.each(['.txt', '.md', '.markdown'])(
    'classifies a %s file as text whatever case its extension is written in',
    (extension) => {
      expect(classifyFile(submitted(`BRIEF${extension.toUpperCase()}`, encode('plain text')))).toBe(
        'text',
      );
    },
  );

  it('refuses a .pdf whose bytes are not a PDF', () => {
    expect(classifyFile(submitted('brief.pdf', encode('%PDF')))).toBeNull();
    expect(classifyFile(submitted('brief.pdf', encode('Requirements: add a file.')))).toBeNull();
  });

  it('refuses a .docx whose bytes are not a ZIP container', () => {
    expect(classifyFile(submitted('brief.docx', new Uint8Array([0x50, 0x4b])))).toBeNull();
    expect(classifyFile(submitted('brief.docx', encode('Requirements: add a file.')))).toBeNull();
  });

  it('refuses a text file whose bytes are not valid UTF-8', () => {
    expect(
      classifyFile(submitted('brief.txt', new Uint8Array([0xff, 0xfe, 0x00, 0x01]))),
    ).toBeNull();
  });

  it('classifies an empty text file as text, leaving emptiness to extraction', () => {
    // The kind is a fact about the extension and the bytes. That the document carries no requirements
    // is a fact about its content, which `src/lib/extract.ts` reports as `empty`.
    expect(classifyFile(submitted('brief.md', new Uint8Array([])))).toBe('text');
  });

  it('refuses an extension that is not on the allow-list', () => {
    expect(classifyFile(submitted('requirements.exe', encode('MZ')))).toBeNull();
    expect(classifyFile(submitted('notes.rtf', encode('{\\rtf1}')))).toBeNull();
    expect(classifyFile(submitted('requirements', encode('no extension')))).toBeNull();
  });

  it('takes the extension from the last path segment, never from a directory', () => {
    expect(classifyFile(submitted('exports/brief.pdf', encode('plain text')))).toBeNull();
    expect(classifyFile(submitted('exports\\brief.docx', encode('plain text')))).toBeNull();
    expect(classifyFile(submitted('exports/brief.md', encode('plain text')))).toBe('text');
  });

  it('ignores a client-declared MIME type, deciding from the bytes alone', () => {
    // No MIME type is a parameter of classifyFile, which is the structural proof; these two objects
    // show a deliberately misleading one changing nothing.
    const textClaimingPdf = {
      name: 'brief.txt',
      bytes: encode('plain text'),
      type: 'application/pdf',
    };
    const pdfClaimingText = { name: 'brief.pdf', bytes: PDF_BYTES, type: 'text/plain' };

    expect(classifyFile(textClaimingPdf)).toBe('text');
    expect(classifyFile(pdfClaimingText)).toBe('pdf');
  });

  it('classifies the repository fixtures as the formats they are', () => {
    expect(classifyFile(submitted('minimal.pdf', readFileSync('tests/fixtures/minimal.pdf')))).toBe(
      'pdf',
    );
    expect(
      classifyFile(
        submitted('sample-requirements.md', readFileSync('tests/fixtures/sample-requirements.md')),
      ),
    ).toBe('text');
  });
});

describe('descriptionSchema', () => {
  it('accepts an absent description and one exactly at the cap', () => {
    expect(descriptionSchema.safeParse('').success).toBe(true);
    expect(descriptionSchema.safeParse('x'.repeat(MAX_DESCRIPTION_CHARS)).success).toBe(true);
    expect(descriptionSchema.safeParse('é'.repeat(MAX_DESCRIPTION_CHARS)).success).toBe(true);
  });

  it('measures length in UTF-16 code units, as the source budget and the browser counter do', () => {
    // An astral character is two code units and one code point. The cap is a code-unit count, so a
    // description of 5,001 emoji is 10,002 units and over it, even though it is only 5,001 code
    // points; counting code points would let the same text pass here and be charged 10,002 by the
    // source budget.
    const atCap = '🧭'.repeat(MAX_DESCRIPTION_CHARS / 2);
    const overCap = '🧭'.repeat(MAX_DESCRIPTION_CHARS / 2 + 1);

    expect(atCap.length).toBe(MAX_DESCRIPTION_CHARS);
    expect(overCap.length).toBe(MAX_DESCRIPTION_CHARS + 2);

    expect(descriptionSchema.safeParse(atCap).success).toBe(true);
    expect(descriptionSchema.safeParse(overCap).success).toBe(false);
  });

  it('rejects a description one character over the cap, naming both counts', () => {
    const result = descriptionSchema.safeParse('x'.repeat(MAX_DESCRIPTION_CHARS + 1));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('10,001');
    expect(result.error?.issues[0]?.message).toContain('10,000');
  });
});

describe('validateSubmission, request-level breaches', () => {
  it('refuses a description over the cap with a 400 that names both counts and offers no retry', () => {
    const thrown = catchThrown(() => validateSubmission('x'.repeat(MAX_DESCRIPTION_CHARS + 1), []));
    const envelope = toErrorEnvelope(thrown);

    expect(thrown).toBeInstanceOf(AppError);
    expect(envelope.status).toBe(400);
    expect(envelope.body.code).toBe('INVALID_INPUT');
    expect(envelope.body.retryable).toBe(false);
    expect(envelope.body.message).toContain('10,001');
    expect(envelope.body.message).toContain('10,000');
  });

  it('accepts a description exactly at the cap', () => {
    expect(validateSubmission('x'.repeat(MAX_DESCRIPTION_CHARS), [])).toEqual({
      accepted: [],
      rejected: [],
    });
  });

  it('refuses an astral description over the cap, counted as the source budget counts it', () => {
    const thrown = catchThrown(() =>
      validateSubmission('🧭'.repeat(MAX_DESCRIPTION_CHARS / 2 + 1), []),
    );
    const envelope = toErrorEnvelope(thrown);

    expect(envelope.status).toBe(400);
    expect(envelope.body.message).toContain('10,002');
  });

  it('refuses a description that is not a string with the code’s own sentence', () => {
    const thrown = catchThrown(() => validateSubmission(7 as unknown as string, []));
    const envelope = toErrorEnvelope(thrown);

    expect(envelope.body.code).toBe('INVALID_INPUT');
    expect(envelope.body.message).toMatch(/nothing usable arrived/i);
    // The schema's sentence quotes character counts, so it must not be used for a value that has no
    // length: the person reading this is told what to send, not what the parser expected.
    expect(envelope.body.message).not.toMatch(/expected string/i);
  });

  it('accepts an empty submission, leaving "nothing usable" to the handler after extraction', () => {
    // Only extraction can say whether a document contributed any text, so this gate accepts an empty
    // submission and the handler raises INVALID_INPUT once the assembled source is empty.
    expect(() => validateSubmission('', [])).not.toThrow();
    expect(validateSubmission('', [])).toEqual({ accepted: [], rejected: [] });
  });
});

describe('validateSubmission, file-level breaches', () => {
  it('accepts the first five files and reports the sixth as too-many-files', () => {
    const files = [
      textFile('one.md'),
      textFile('two.md'),
      textFile('three.md'),
      textFile('four.md'),
      textFile('five.md'),
      submitted('six.md', encode('plain text')),
    ];

    const { accepted, rejected } = validateSubmission('', files);

    expect(accepted.map((file) => file.name)).toEqual([
      'one.md',
      'two.md',
      'three.md',
      'four.md',
      'five.md',
    ]);
    expect(rejected).toEqual([{ name: 'six.md', reason: 'too-many-files' }]);
  });

  it('reports the count before the size, so the sixth file is too many even when oversized', () => {
    const files = Array.from({ length: MAX_FILES }, (_unused, index) => textFile(`${index}.md`));
    files.push(submitted('sixth.pdf', new Uint8Array(MAX_FILE_BYTES + 1)));

    const { accepted, rejected } = validateSubmission('', files);

    expect(accepted).toHaveLength(MAX_FILES);
    expect(rejected).toEqual([{ name: 'sixth.pdf', reason: 'too-many-files' }]);
  });

  it('accepts a file exactly at the size cap and refuses one byte more', () => {
    const atCap = new Uint8Array(MAX_FILE_BYTES).fill(0x61);
    const overCap = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x61);

    const { accepted, rejected } = validateSubmission('', [
      submitted('at-cap.txt', atCap),
      submitted('over-cap.txt', overCap),
    ]);

    expect(accepted.map((file) => file.name)).toEqual(['at-cap.txt']);
    expect(accepted[0]?.bytes).toBe(MAX_FILE_BYTES);
    expect(rejected).toEqual([{ name: 'over-cap.txt', reason: 'too-large' }]);
  });

  it('reports an unsupported type and keeps the rest of the submission', () => {
    const files = [
      textFile('one.md'),
      submitted('two.exe', encode('MZ')),
      submitted('three.pdf', encode('not a pdf at all')),
      textFile('four.md'),
    ];

    const { accepted, rejected } = validateSubmission('', files);

    expect(accepted.map((file) => file.name)).toEqual(['one.md', 'four.md']);
    expect(rejected).toEqual([
      { name: 'two.exe', reason: 'unsupported-type' },
      { name: 'three.pdf', reason: 'unsupported-type' },
    ]);
  });

  it('reports rejections in the order the files arrived, however bad they are', () => {
    const files = [
      submitted('one.exe', encode('MZ')),
      textFile('two.md'),
      submitted('three.pdf', new Uint8Array(MAX_FILE_BYTES + 1)),
      textFile('four.md'),
    ];

    const { accepted, rejected } = validateSubmission('', files);

    expect(rejected).toEqual([
      { name: 'one.exe', reason: 'unsupported-type' },
      { name: 'three.pdf', reason: 'too-large' },
    ]);
    expect(accepted.map((file) => file.name)).toEqual(['two.md', 'four.md']);
  });

  it('never throws for a submission of nothing but bad files', () => {
    const files = [submitted('one.exe', encode('MZ')), submitted('two.rtf', encode('{\\rtf1}'))];

    expect(() => validateSubmission('', files)).not.toThrow();

    const { accepted, rejected } = validateSubmission('', files);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { name: 'one.exe', reason: 'unsupported-type' },
      { name: 'two.rtf', reason: 'unsupported-type' },
    ]);
  });

  it('produces rejections that carry a name and a reason and nothing else', () => {
    const { rejected } = validateSubmission('', [submitted('one.exe', encode('MZ'))]);

    expect(Object.keys(rejected[0] ?? {})).toEqual(['name', 'reason']);
  });
});

describe('validateSubmission, accepted files', () => {
  it('records the size in bytes and the content as its own buffer', () => {
    const content = encode('Requirements: add a file or paste a description.');

    const { accepted } = validateSubmission('', [submitted('brief.md', content)]);
    const [file] = accepted;

    expect(file).toMatchObject({ name: 'brief.md', kind: 'text', bytes: content.byteLength });
    expect(decode(file?.body ?? new ArrayBuffer(0))).toBe(
      'Requirements: add a file or paste a description.',
    );
  });

  it('copies a view of a larger buffer without padding it with its neighbours', () => {
    const pooled = new Uint8Array(64).fill(0x23);
    pooled.set(encode('brief'), 8);
    const view = pooled.subarray(8, 13);

    const { accepted } = validateSubmission('', [submitted('brief.md', view)]);
    const [file] = accepted;

    expect(file?.bytes).toBe(5);
    expect(decode(file?.body ?? new ArrayBuffer(0))).toBe('brief');
  });

  it('accepts a description and files together, as one submission', () => {
    const { accepted, rejected } = validateSubmission('Paste this and add a file.', [
      submitted('brief.pdf', PDF_BYTES),
      submitted('brief.docx', DOCX_BYTES),
    ]);

    expect(accepted.map((file) => [file.name, file.kind])).toEqual([
      ['brief.pdf', 'pdf'],
      ['brief.docx', 'docx'],
    ]);
    expect(rejected).toEqual([]);
  });
});

/**
 * Suite for `src/lib/extract.ts` — the document text extraction step of the build prompt generator.
 *
 * What it pins: `extractDocument` answers with an `ExtractedDocument` for an upload it can read and
 * with a `RejectedDocument` naming the reason for one it cannot, and it never throws — so one
 * unreadable file becomes a warning on the response instead of a failed request (FR-2). Every
 * failure case below is therefore asserted with `resolves`, never with `rejects`: throwing is
 * exactly what the module promises not to do.
 *
 * The PDF group is the only place in the repository that runs the real unpdf reader. It extracts the
 * committed `minimal.pdf` fixture and asserts the sentence sitting in that fixture's content stream,
 * which is what keeps the fixture honest — a stubbed reader would happily "extract" text from a PDF
 * that no longer parses. unpdf is never mocked here, and no PDF assertion needs `@napi-rs/canvas`,
 * which is deliberately not installed. The one consequence is accepted rather than worked around:
 * the arm of `extract.ts` that joins a non-string PDF.js result stays uncovered, because reaching it
 * would mean stubbing the reader this suite exists to keep real.
 *
 * `mammoth` is the one reader this suite stubs: a `.docx` container cannot be committed as a small
 * text fixture, and its failure modes — a reader that throws, one that answers with no text at all —
 * are precisely the cases the isolation group must reach.
 *
 * Nothing here touches the network, a credential or the wall clock: every input is a committed
 * fixture or bytes built in memory, and extraction is local.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractRawText } from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractDocument } from '@/lib/extract';
import type {
  AcceptedFile,
  ExtractedDocument,
  FileKind,
  RejectedDocument,
  RejectionReason,
} from '@/types';

/**
 * The stub for the Word reader. Vitest hoists `vi.mock` calls above this module's imports, so
 * `src/lib/extract` receives the stub the first time it is imported, and no other reader is touched.
 */
vi.mock('mammoth', () => ({ extractRawText: vi.fn() }));

/** A byte-order mark: the one prefix the UTF-8 decoder consumes on its own. */
const BOM_BYTES = new Uint8Array([0xef, 0xbb, 0xbf]);

/** The four leading bytes of a `.docx` container, which is a ZIP archive. */
const DOCX_MAGIC_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

/** The line written into `minimal.pdf`'s content stream, quoted from the fixture's own bytes. */
const PDF_SENTINEL = 'Fixture extraction sentinel: lazy dog 0123456789.';

/** The fixture's other text line, so a reader that silently drops a content stream is caught. */
const PDF_HEADING = 'Minimal PDF fixture for extraction tests.';

/** The closed set of reasons a dropped file may carry, quoted from the shared contract. */
const REJECTION_REASONS: readonly RejectionReason[] = [
  'unsupported-type',
  'too-large',
  'too-many-files',
  'extraction-failed',
  'empty',
];

/** What the Word reader declares it answers with, so a deliberately malformed answer is typed too. */
type WordReaderResult = Awaited<ReturnType<typeof extractRawText>>;

const fixtureCache = new Map<string, Uint8Array>();

/**
 * Read a committed test fixture as bytes.
 *
 * `process.cwd()` is the repository root under Vitest; the `import.meta.url` fallback covers a run
 * launched from somewhere else, such as an editor's test task, so the suite does not depend on how
 * it was started. The bytes are copied out of the `Buffer` `readFile` returns, because Node pools the
 * allocations of files this small and a view would then carry a neighbour's bytes in its buffer.
 */
async function fixture(name: string): Promise<Uint8Array> {
  const cached = fixtureCache.get(name);

  if (cached !== undefined) {
    return cached;
  }

  const raw = await readFile(path.resolve(process.cwd(), 'tests/fixtures', name)).catch(() =>
    readFile(new URL(`../fixtures/${name}`, import.meta.url)),
  );
  const bytes = new Uint8Array(raw);

  fixtureCache.set(name, bytes);

  return bytes;
}

/**
 * Build the `AcceptedFile` validation hands to the extractor, with a private copy of the bytes.
 *
 * PDF.js transfers the buffer it is given to its worker, and that transfer detaches it, so a buffer
 * shared between two calls would make the second one fail — the copy is what lets a test extract the
 * same upload twice and expect the same text.
 */
function accepted(name: string, kind: FileKind, bytes: Uint8Array): AcceptedFile {
  return {
    name,
    kind,
    bytes: bytes.byteLength,
    body: new Uint8Array(bytes).buffer,
  };
}

/** Text bytes for an in-memory input, since the fixtures carry only the two committed formats. */
function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** `reason` is the only member an extracted document does not have, so its presence is the discriminant. */
function isRejected(result: ExtractedDocument | RejectedDocument): result is RejectedDocument {
  return 'reason' in result;
}

/**
 * Extract one upload and hand back its text, failing the test with the reader's own verdict when the
 * module rejected it instead.
 */
async function extractTextOf(input: AcceptedFile): Promise<ExtractedDocument> {
  const result = await extractDocument(input);

  if (isRejected(result)) {
    throw new Error(
      `Expected text from "${input.name}" but extraction reported "${result.reason}".`,
    );
  }

  return result;
}

beforeEach(() => {
  // A fresh stub per test: the module reads it before any assertion, and an answer left behind by
  // the previous test would make a rejection look like a success.
  vi.mocked(extractRawText).mockReset();
});

afterEach(() => {
  // No test spies on anything, so this is the suite's standing contract for a spy a later edit adds:
  // it cannot leak into the next test file. The reader's own reset is the beforeEach above.
  vi.restoreAllMocks();
});

describe('extractDocument', () => {
  describe('text formats', () => {
    it('extracts the markdown fixture verbatim, with the character count of the text it returns', async () => {
      const bytes = await fixture('sample-requirements.md');
      const document = await extractTextOf(accepted('sample-requirements.md', 'text', bytes));

      expect(document.kind).toBe('text');
      expect(document.bytes).toBe(bytes.byteLength);
      expect(document.text).toBe(new TextDecoder().decode(bytes));
      expect(document.text).toContain('# Support Triage Assistant');
      expect(document.text).toContain('## Acceptance criteria');
      expect(document.chars).toBe(document.text.length);
      expect(document.truncated).toBe(false);
      // The Word reader belongs to the .docx branch alone.
      expect(extractRawText).not.toHaveBeenCalled();
    });

    it('extracts a plain-text file built in memory, keeping its line breaks intact', async () => {
      const source = 'The service must sort incoming messages.\nA second line follows.\n';
      const document = await extractTextOf(accepted('notes.txt', 'text', bytesOf(source)));

      expect(document.kind).toBe('text');
      expect(document.text).toBe(source);
      expect(document.bytes).toBe(bytesOf(source).byteLength);
      expect(document.chars).toBe(source.length);
      expect(document.truncated).toBe(false);
    });

    it('drops a leading byte-order mark rather than passing it into the document text', async () => {
      const bytes = new Uint8Array([...BOM_BYTES, ...bytesOf('Requirements follow.')]);
      const document = await extractTextOf(accepted('bom.txt', 'text', bytes));

      expect(document.text).toBe('Requirements follow.');
      expect(document.chars).toBe('Requirements follow.'.length);
    });

    it.each([
      ['a file of spaces', bytesOf('   ')],
      ['tabs and line breaks only', bytesOf('\t\r\n \n')],
      ['a byte-order mark with nothing after it', BOM_BYTES],
    ])('reports %s as empty rather than as an extracted document', async (_label, bytes) => {
      await expect(extractDocument(accepted('blank.txt', 'text', bytes))).resolves.toMatchObject({
        name: 'blank.txt',
        reason: 'empty',
      });
    });

    it('reports text bytes that are not valid UTF-8 as unreadable rather than decoding them lossily', async () => {
      const bytes = new Uint8Array([0x48, 0x69, 0xc3, 0x28, 0x21]);

      await expect(extractDocument(accepted('broken.txt', 'text', bytes))).resolves.toMatchObject({
        name: 'broken.txt',
        reason: 'extraction-failed',
      });
    });
  });

  describe('PDF documents through the real unpdf reader', () => {
    it('extracts the text of the PDF fixture, sentinel sentence included', async () => {
      const bytes = await fixture('minimal.pdf');
      const document = await extractTextOf(accepted('minimal.pdf', 'pdf', bytes));

      expect(document.kind).toBe('pdf');
      expect(document.bytes).toBe(bytes.byteLength);
      expect(document.text.trim()).not.toBe('');
      expect(document.text).toContain(PDF_HEADING);
      expect(document.text).toContain(PDF_SENTINEL);
      expect(document.chars).toBe(document.text.length);
      expect(document.truncated).toBe(false);
    });

    it('runs against the real unpdf reader, so a stubbed one cannot pass this group', () => {
      // Mocking unpdf is what the plan forbids: the fixture would stop proving that these bytes
      // parse. Asserting the reader is live keeps that guarantee executable rather than remembered.
      expect(vi.isMockFunction(getDocumentProxy)).toBe(false);
      expect(vi.isMockFunction(extractText)).toBe(false);
    });

    it('extracts the same upload twice with identical text, because the reader gets a private buffer', async () => {
      const upload = accepted('minimal.pdf', 'pdf', await fixture('minimal.pdf'));

      const first = await extractTextOf(upload);
      const second = await extractTextOf(upload);

      expect(second.text).toBe(first.text);
      expect(second.chars).toBe(first.chars);
    });
  });

  describe('Word documents through the mocked reader', () => {
    /** Answers a reader could give that carry no usable text, each a shape of the same branch. */
    const UNUSABLE_READER_RESULTS: Array<[string, unknown]> = [
      ['a result carrying no value at all', { messages: [] }],
      ['a value that is not text', { value: 7, messages: [] }],
    ];

    it('extracts .docx text by handing the reader the uploaded bytes', async () => {
      vi.mocked(extractRawText).mockResolvedValue({
        value: 'The tool shall sort messages.',
        messages: [],
      });

      const document = await extractTextOf(accepted('brief.docx', 'docx', DOCX_MAGIC_BYTES));

      expect(document.kind).toBe('docx');
      expect(document.text).toBe('The tool shall sort messages.');
      expect(document.bytes).toBe(DOCX_MAGIC_BYTES.byteLength);
      expect(document.chars).toBe('The tool shall sort messages.'.length);
      expect(document.truncated).toBe(false);
      expect(extractRawText).toHaveBeenCalledTimes(1);
      expect(extractRawText).toHaveBeenCalledWith(
        expect.objectContaining({ arrayBuffer: expect.anything() }),
      );
    });

    it('isolates a reader that throws, reporting the document instead of failing the request', async () => {
      vi.mocked(extractRawText).mockRejectedValue(new Error('not a zip container'));

      await expect(
        extractDocument(accepted('annexe.docx', 'docx', DOCX_MAGIC_BYTES)),
      ).resolves.toMatchObject({ name: 'annexe.docx', reason: 'extraction-failed' });
    });

    it.each(UNUSABLE_READER_RESULTS)('reads %s as an unreadable .docx', async (_label, result) => {
      vi.mocked(extractRawText).mockResolvedValue(result as WordReaderResult);

      await expect(
        extractDocument(accepted('annexe.docx', 'docx', DOCX_MAGIC_BYTES)),
      ).resolves.toMatchObject({ name: 'annexe.docx', reason: 'extraction-failed' });
    });

    it('reports a .docx whose text is only whitespace as empty', async () => {
      vi.mocked(extractRawText).mockResolvedValue({ value: ' \n\t ', messages: [] });

      await expect(
        extractDocument(accepted('annexe.docx', 'docx', DOCX_MAGIC_BYTES)),
      ).resolves.toMatchObject({ name: 'annexe.docx', reason: 'empty' });
    });
  });

  describe('failure isolation', () => {
    it.each([
      ['a truncated %PDF- header', bytesOf('%PDF-1.4\n1 0 obj\n')],
      ['a lone percent sign', bytesOf('%')],
      ['an empty file named .pdf', new Uint8Array(0)],
      ['bytes that were never a PDF', new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x13, 0x37])],
    ])('reports %s as extraction-failed rather than failing the request', async (_label, bytes) => {
      await expect(extractDocument(accepted('broken.pdf', 'pdf', bytes))).resolves.toMatchObject({
        name: 'broken.pdf',
        reason: 'extraction-failed',
      });
    });

    it('reports a file whose kind is outside the contract as unreadable rather than guessing a reader', async () => {
      // `FileKind` is closed for a typed caller, so this value can only arrive from untyped code.
      // The module promises to report such a file rather than dispatch on a kind it does not know.
      const rogue = {
        ...accepted('brief.rtf', 'text', bytesOf('Requirements follow.')),
        kind: 'rtf',
      } as unknown as AcceptedFile;

      await expect(extractDocument(rogue)).resolves.toMatchObject({
        name: 'brief.rtf',
        reason: 'extraction-failed',
      });
    });

    it('never rejects, whatever bytes arrive claiming to be any kind', async () => {
      const inputs: AcceptedFile[] = [
        accepted('empty.txt', 'text', new Uint8Array(0)),
        accepted('empty.pdf', 'pdf', new Uint8Array(0)),
        accepted('empty.docx', 'docx', new Uint8Array(0)),
        accepted('one-byte.txt', 'text', new Uint8Array([0x41])),
        accepted('one-byte.pdf', 'pdf', new Uint8Array([0x41])),
        accepted('one-byte.docx', 'docx', new Uint8Array([0x41])),
        accepted('percent.txt', 'text', bytesOf('%')),
        accepted('percent.pdf', 'pdf', bytesOf('%')),
        accepted('noise.txt', 'text', new Uint8Array([0x00, 0x80, 0xff])),
        accepted('noise.pdf', 'pdf', bytesOf('%PDF')),
        accepted('noise.docx', 'docx', DOCX_MAGIC_BYTES),
        accepted('truncated.pdf', 'pdf', bytesOf('%PDF-1.4\n')),
      ];

      for (const input of inputs) {
        const result = await extractDocument(input);

        // Every answer stays attributable to its own upload, and a rejection only ever names a
        // reason from the closed set: nothing else may travel back with a dropped file.
        expect(result.name).toBe(input.name);

        if (isRejected(result)) {
          expect(REJECTION_REASONS).toContain(result.reason);
        } else {
          expect(result.text.trim()).not.toBe('');
          expect(result.chars).toBe(result.text.length);
        }
      }
    });
  });

  describe('the source budget', () => {
    it('keeps a document far larger than the source budget whole, because truncation belongs to the bundle', async () => {
      const source = 'The service shall accept one message from the webhook. '.repeat(2000);
      expect(source.length).toBeGreaterThan(60000);

      const document = await extractTextOf(accepted('long-brief.txt', 'text', bytesOf(source)));

      expect(document.text).toBe(source);
      expect(document.chars).toBe(source.length);
      expect(document.truncated).toBe(false);
    });
  });
});

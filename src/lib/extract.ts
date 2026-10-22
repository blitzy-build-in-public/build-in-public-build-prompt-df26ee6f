import { Buffer } from 'node:buffer';

// mammoth is a CommonJS package whose single export is the reader object, so it is bound as a
// namespace and each reader is reached by name.
import * as mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

import type { AcceptedFile, ExtractedDocument, RejectedDocument } from '@/types';

/**
 * The merged result `extractText` returns for `mergePages: true`: the whole document as one string.
 * The array form belongs to the un-merged call, so the union is narrowed rather than assumed.
 */
type MergedPdfText = { totalPages: number; text: string | string[] };

/**
 * Extract the plain text of one accepted upload.
 *
 * @param accepted A file whose kind validation already decided from the extension allow-list and
 *   confirmed from its leading bytes. That kind is the only thing this module dispatches on: a
 *   client-supplied MIME type says nothing about what the bytes are.
 * @returns The extracted text with its character count, or a rejection naming the reason. A file the
 *   reader cannot open resolves to `extraction-failed` instead of throwing, so one unreadable upload
 *   cannot fail the request; text that extracts empty resolves to `empty`, which is how an image-only
 *   PDF is reported rather than contributing nothing silently.
 */
export async function extractDocument(
  accepted: AcceptedFile,
): Promise<ExtractedDocument | RejectedDocument> {
  try {
    const text = await readDocumentText(accepted);

    if (text.trim() === '') {
      return { name: accepted.name, reason: 'empty' };
    }

    return {
      name: accepted.name,
      kind: accepted.kind,
      bytes: accepted.bytes,
      chars: text.length,
      text,
      // The source budget is applied when the bundle is assembled, so nothing is cut here.
      truncated: false,
    };
  } catch {
    return { name: accepted.name, reason: 'extraction-failed' };
  }
}

/**
 * Read one file by the kind validation gave it.
 *
 * The caller's single `try` covers every format: exactly one branch runs per call, so one boundary
 * isolates all three readers and the rejection is built once rather than once per reader.
 */
async function readDocumentText(accepted: AcceptedFile): Promise<string> {
  switch (accepted.kind) {
    case 'pdf':
      return extractPdfText(accepted.body);
    case 'docx':
      return extractDocxText(accepted.body);
    case 'text':
      return decodePlainText(accepted.body);
    default: {
      // FileKind is closed, so this is unreachable for a typed caller; a value outside it is reported
      // as an unreadable file rather than guessed at.
      const unsupported: never = accepted.kind;
      throw new TypeError(`Unsupported document kind: ${String(unsupported)}`);
    }
  }
}

/** PDF text, through unpdf's serverless PDF.js build. */
async function extractPdfText(body: ArrayBuffer): Promise<string> {
  // PDF.js transfers the buffer it is handed to its worker, which detaches it. The reader therefore
  // gets a private copy: a second read of the same upload, or one whose buffer is a view over a
  // larger pooled allocation, otherwise fails inside the transfer as an uncaught DataCloneError that
  // takes the process down instead of failing the file.
  const pdf = await getDocumentProxy(new Uint8Array(body.slice(0)));
  const merged: MergedPdfText = await extractText(pdf, { mergePages: true });

  return typeof merged.text === 'string' ? merged.text : merged.text.join('\n');
}

/**
 * Word `.docx` text, through mammoth's raw-text reader.
 *
 * The reader is handed both keys deliberately: the copy shipped for Node reads `buffer` (its unzip
 * step understands path, buffer and file only), while the call it declares for bytes already in hand
 * names them `arrayBuffer`. Sending both leaves the declared call intact and still reads the file.
 */
async function extractDocxText(body: ArrayBuffer): Promise<string> {
  const input = { arrayBuffer: body, buffer: Buffer.from(body) };
  const result: { value?: unknown } | undefined = await mammoth.extractRawText(input);
  const value = result?.value;

  if (typeof value !== 'string') {
    // A reader that hands back no text failed to read the container; it is not an empty document.
    throw new TypeError('The .docx reader returned no text.');
  }

  return value;
}

/**
 * Text formats, decoded as UTF-8.
 *
 * `fatal` is set so undecodable bytes are reported as an unreadable file rather than turned into
 * replacement characters and passed to the model as if they were the document. The decoder also
 * drops a leading byte-order mark.
 */
function decodePlainText(body: ArrayBuffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

/**
 * Source assembly: the one place that decides what the model actually receives, within a fixed
 * character budget, deterministically for a given submission.
 *
 * The budget is `MAX_SOURCE_CHARS`, and the order it is spent in is fixed. The pasted description is
 * counted first and kept whole, because the user's own steering text outranks a document that may be
 * mostly boilerplate, and its own cap (`MAX_DESCRIPTION_CHARS`) sits below the budget, so a
 * description the route accepted can never displace an attachment. Documents then take what remains,
 * in upload order - first attached, first read - and nothing is ever reordered.
 *
 * A document that does not fit whole is kept as far as it goes, flagged `truncated` and warned
 * about; a document that arrives after the budget is exhausted keeps nothing, is still returned and
 * is still warned about. Nothing is dropped from the list and nothing is dropped silently: the `meta`
 * frame reports what the model actually saw, so the user can tell "your file was read" apart from
 * "your file was read in part".
 *
 * The warnings are this module's second product, and they are a contract rather than decoration. Each
 * one is a complete sentence naming the file, the rule that applied and the next action, and each is
 * produced here because here is where the facts behind it are known: the truncation sentences come
 * from the budget arithmetic below, and the file-level rejection sentences come from the exhaustive
 * table below, so one request answers with everything the user needs to know in one place.
 *
 * Nothing here throws. Assembly always returns a bundle, and the caller - the route handler - decides
 * that an empty bundle means there was nothing usable to generate from.
 *
 * Server-only by tier: it handles document text, so no client component may import it. Its only
 * imports are the shared contract module's types and the limit constants, which are imported rather
 * than restated: a warning sentence that quoted its own copy of a limit would keep quoting it after
 * the limit moved. That applies to every limit these sentences mention, not only the budget.
 */

import { ACCEPTED_EXTENSIONS, MAX_FILE_BYTES, MAX_FILES, MAX_SOURCE_CHARS } from '@/lib/validation';
import type { ExtractedDocument, RejectedDocument, RejectionReason, SourceBundle } from '@/types';

/** Bytes in a mebibyte, the unit the single-file cap is declared in. */
const BYTES_PER_MB = 1_048_576;

/**
 * The single-file cap in the unit its warning sentence states it in.
 *
 * Derived from `MAX_FILE_BYTES` rather than written as "8", so the sentence the user reads moves with
 * the limit it quotes; the cap is a whole number of mebibytes today, which is why the division has no
 * remainder to render.
 */
const MAX_FILE_MB = MAX_FILE_BYTES / BYTES_PER_MB;

/** The high half of a UTF-16 surrogate pair: U+D800-U+DBFF. */
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/** The low half of a UTF-16 surrogate pair: U+DC00-U+DFFF. */
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/**
 * Render a count for a person to read, in the form the validation module's own sentences use.
 *
 * The locale is forced rather than inherited: a count rendered in whatever locale the host happens to
 * have would make the same warning a different string on a different machine, and these sentences are
 * asserted by the unit suite and shown to the user.
 *
 * @param value A character or byte count.
 * @returns The count with thousands separated, for example `60,000`.
 */
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Render a file name as a quoted literal for a sentence.
 *
 * The name is whatever the browser sent, so it can hold a quote, a newline or an escape character
 * that would otherwise break the sentence the user reads. JSON-encoding it keeps the name recognisable
 * and the sentence intact, exactly as the prompt template encodes source content.
 *
 * @param name The file's name as sent.
 * @returns The name as a quoted, escaped literal, for example `"brief.pdf"`.
 */
function quote(name: string): string {
  return JSON.stringify(name);
}

/**
 * Join a list into prose: one item as itself, and more as "a, b or c".
 *
 * @param items The items, in their declared order.
 * @returns The joined list, or an empty string when there is nothing to join.
 */
function formatList(items: readonly string[]): string {
  const head = items.slice(0, -1).join(', ');
  const last = items.at(-1) ?? '';

  return head === '' ? last : `${head} or ${last}`;
}

/** Whether a code unit is the high half of a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

/** Whether a code unit is the low half of a surrogate pair. */
function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

/**
 * Cut text to a character budget without splitting a surrogate pair.
 *
 * Counts are UTF-16 code units, as they are in the validation module and in the browser's counter, so
 * a cut can land between the two code units of one astral character. Cutting there would leave the
 * assembled source holding a lone surrogate, which the prompt template's `JSON.stringify` escapes as
 * an unpaired `\uXXXX`: the model would read a broken character, and the `chars` reported in the
 * `meta` frame would describe text that is not what the model received. Stepping back one code unit
 * instead loses at most one character, and keeps every count in this module a count of text that
 * survives encoding.
 *
 * @param text The text to cut.
 * @param budget The maximum number of code units to keep.
 * @returns `text` itself when it fits, otherwise its first `budget` code units - or one fewer, when
 *   the cut would have fallen between the halves of a surrogate pair.
 */
function truncateToBudget(text: string, budget: number): string {
  const limit = Math.max(0, Math.min(budget, text.length));

  if (limit === text.length) {
    return text;
  }

  const splitsSurrogatePair =
    limit > 0 &&
    isHighSurrogate(text.charCodeAt(limit - 1)) &&
    isLowSurrogate(text.charCodeAt(limit));

  return text.slice(0, splitsSurrogatePair ? limit - 1 : limit);
}

/**
 * The sentence for a document the source budget cut short.
 *
 * It states both counts, because "the file was too long" leaves the user guessing whether they lost a
 * paragraph or an appendix, and it names the file, because a submission may carry several.
 *
 * @param name The document's name.
 * @param keptChars The characters that fit the budget.
 * @param producedChars The characters extraction produced for that document.
 * @returns The warning sentence.
 */
function describeTruncation(name: string, keptChars: number, producedChars: number): string {
  return (
    `${quote(name)} was truncated: ${formatCount(keptChars)} of its ` +
    `${formatCount(producedChars)} characters were kept within the ` +
    `${formatCount(MAX_SOURCE_CHARS)}-character source budget. Split it into smaller files, or ` +
    'shorten it, then add it again.'
  );
}

/**
 * The sentence for a description longer than the whole budget.
 *
 * Unreachable through the route, which refuses a description past `MAX_DESCRIPTION_CHARS` long before
 * assembly; it exists so that assembly cannot cut text without saying so, whatever it is handed.
 *
 * @param keptChars The characters that fit the budget.
 * @returns The warning sentence.
 */
function describeDescriptionTruncation(keptChars: number): string {
  return (
    `The pasted description was truncated: its first ${formatCount(keptChars)} characters were ` +
    `kept within the ${formatCount(MAX_SOURCE_CHARS)}-character source budget. ` +
    'Shorten it, or put the rest of the detail in a file.'
  );
}

/**
 * The sentence shown for each file-level rejection, written once and exhaustively.
 *
 * Typing this as `Record<RejectionReason, ...>` is deliberate rather than incidental: a reason added
 * to `RejectionReason` in the shared contract fails type-checking here until a sentence has been
 * written for it, so no rejected file can reach a user without one. Each sentence names the file,
 * states the rule it broke and ends by naming the next action, and each is a function of the file's
 * name and nothing else - a `RejectedDocument` carries no content to read.
 */
const REJECTION_SENTENCES: Record<RejectionReason, (name: string) => string> = {
  'unsupported-type': (name) =>
    `${quote(name)} is not a supported file type, so it was not read. ` +
    `Save it as ${formatList(ACCEPTED_EXTENSIONS)} and add it again.`,
  'too-large': (name) =>
    `${quote(name)} is larger than the ${formatCount(MAX_FILE_MB)} MB limit for one file, so it ` +
    'was not read. Split it into smaller files, or paste the part you need as text, then add it again.',
  'too-many-files': (name) =>
    `${quote(name)} was not read: one request may carry at most ${formatCount(MAX_FILES)} files. ` +
    'Remove another file, then add it again.',
  'extraction-failed': (name) =>
    `${quote(name)} could not be read, so its text did not reach the draft. Open it in an editor ` +
    'and save a copy as .txt or .md, or paste its requirements as text.',
  empty: (name) =>
    `${quote(name)} holds no text that could be read, so it contributed nothing to the draft. ` +
    'If it is a scan or an image, paste its requirements as text instead.',
};

/**
 * Turn one rejection into the sentence the user reads.
 *
 * @param document The file validation refused and the file-level rule it broke.
 * @returns The warning sentence for that reason.
 */
function describeRejection(document: RejectedDocument): string {
  return REJECTION_SENTENCES[document.reason](document.name);
}

/**
 * Assemble everything the model is given - the pasted description and the extracted documents, within
 * the source budget - together with every sentence the user must see about what was read.
 *
 * The order the budget is spent in is fixed, and it is the whole of the policy:
 *
 * 1. the description, kept whole, because it is the user's own steering text and its cap is below the
 *    budget;
 * 2. the documents, in upload order, each keeping whatever remains;
 * 3. a document that reaches an exhausted budget keeps nothing, is still returned and is still warned
 *    about - so the same submission always produces the same bundle, and no file disappears without a
 *    word.
 *
 * `warnings` carries two kinds of sentence, in this order: what this module's budget arithmetic
 * truncated, and then every file-level rejection `validateSubmission` produced. The rejections arrive
 * as a parameter rather than being looked up here because the warning text belongs to this module: the
 * plan states the call `buildSourceBundle(description, documents)` and separately requires the
 * bundle's warnings to carry every rejection, and only a third input lets both hold at once. The
 * route handler passes the rejections it already holds, so the sentences have one author.
 *
 * Returns a bundle and never throws: an empty bundle is a fact the caller acts on, not a failure of
 * assembly.
 *
 * @param description The pasted requirements, exactly as submitted. Counted first against
 *   `MAX_SOURCE_CHARS` and kept whole; only a description longer than the entire budget is cut, which
 *   the route cannot produce because the description cap is below the budget.
 * @param documents The extracted documents, in the order they were uploaded, each read with the text
 *   extraction produced. They are never reordered.
 * @param rejected The files validation refused, in the order it refused them. Optional, so the
 *   two-argument call still type-checks; each one adds a sentence of its own to `warnings`.
 * @returns The `description` as kept; `documents` as read - same order, same length, each carrying
 *   its own `name`, `kind` and `bytes`, the `text` that fits, `chars` describing that kept text and
 *   `truncated` saying it is shorter than what extraction produced; `sourceChars` as the assembled
 *   total the request log records; and `warnings` as the sentences the user reads.
 */
export function buildSourceBundle(
  description: string,
  documents: ExtractedDocument[],
  rejected: RejectedDocument[] = [],
): SourceBundle {
  const warnings: string[] = [];

  const keptDescription = truncateToBudget(description, MAX_SOURCE_CHARS);

  if (keptDescription.length < description.length) {
    warnings.push(describeDescriptionTruncation(keptDescription.length));
  }

  let remaining = MAX_SOURCE_CHARS - keptDescription.length;
  const assembled: ExtractedDocument[] = [];

  for (const document of documents) {
    const text = truncateToBudget(document.text, remaining);
    const kept = text.length;

    if (kept < document.text.length) {
      warnings.push(describeTruncation(document.name, kept, document.text.length));
    }

    assembled.push({
      ...document,
      chars: kept,
      text,
      // A document that arrived already flagged was cut before this module saw it, and cutting it
      // further here cannot make that flag false.
      truncated: document.truncated || kept < document.text.length,
    });

    remaining -= kept;
  }

  // Rejections after truncations: the sentences about what the model did read describe this bundle,
  // and the sentences about the files that never got that far are appended to them.
  for (const document of rejected) {
    warnings.push(describeRejection(document));
  }

  const sourceChars =
    keptDescription.length + assembled.reduce((total, document) => total + document.chars, 0);

  return { description: keptDescription, documents: assembled, sourceChars, warnings };
}

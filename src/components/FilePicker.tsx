'use client';

import { useCallback, useId, useState, type ChangeEvent, type DragEvent, type JSX } from 'react';

import styles from './FilePicker.module.css';

/**
 * Props for {@link FilePicker}.
 *
 * The component holds no file state of its own: the chosen files live in the parent's state and come
 * back through `files`, and the two decisions the parent needs — a selection to add, a row to drop —
 * travel through `onAdd` and `onRemove`. The three cap props carry the limits the server enforces, so
 * the picker refuses what the server would refuse without any of those values being repeated here:
 * the parent's numbers are the authoritative ones.
 */
export interface FilePickerProps {
  /** The files already chosen, in the order they were added. */
  files: readonly File[];
  /** Called with the files from one selection that passed every check. Refusals stay in the picker. */
  onAdd: (files: File[]) => void;
  /** Called with the index into `files` of the file to remove; the parent splices. */
  onRemove: (index: number) => void;
  /** True while a generation is streaming: the input, the drop zone and every Remove control go inert. */
  disabled: boolean;
  /** Largest number of files the server accepts in one submission. */
  maxFiles: number;
  /** Largest single file the server accepts, in bytes. */
  maxFileBytes: number;
  /** File extensions the server accepts, e.g. `.txt`; matched case-insensitively against the name. */
  acceptedExtensions: readonly string[];
}

/** One kibibyte. File sizes are counted the way the file system reports them, not in powers of ten. */
const BYTES_PER_UNIT = 1024;

/**
 * Renders a byte count for a person to read: exact bytes below 1 KB, then KB, MB and GB with one
 * decimal place. A gigabyte only ever appears in a refusal sentence, since nothing that large passes
 * the server's own size cap.
 *
 * @param bytes The size as the browser reports it.
 * @returns A short label such as `512 B`, `12.4 KB` or `8.0 MB`.
 */
function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_UNIT) {
    return `${bytes} B`;
  }

  const kilobytes = bytes / BYTES_PER_UNIT;
  if (kilobytes < BYTES_PER_UNIT) {
    return `${kilobytes.toFixed(1)} KB`;
  }

  const megabytes = kilobytes / BYTES_PER_UNIT;
  if (megabytes < BYTES_PER_UNIT) {
    return `${megabytes.toFixed(1)} MB`;
  }

  return `${(megabytes / BYTES_PER_UNIT).toFixed(1)} GB`;
}

/**
 * Reads the trailing extension from a file name, lowercased, so the allow-list comparison does not
 * depend on how the name was typed.
 *
 * @param name The file's name as the browser reports it.
 * @returns The extension including its dot, or an empty string for a name that has none.
 */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Joins alternatives into a readable list: `a, b or c`. The trailing `or` rather than a comma is
 * what makes the sentence it lands in read as English rather than as an enumeration dump.
 *
 * @param items The alternatives, in the order they should appear.
 * @returns The joined list, or an empty string when there is nothing to join.
 */
function formatList(items: readonly string[]): string {
  const last = items[items.length - 1];
  if (last === undefined) {
    return '';
  }
  return items.length === 1 ? last : `${items.slice(0, -1).join(', ')} or ${last}`;
}

/**
 * Collects the requirements documents to send with a submission.
 *
 * A native, labelled `<input type="file">` is the way in, so choosing files is reachable by keyboard
 * alone; the drop target below it is an addition to that control, never the only route to it. Files
 * that break a cap the server also enforces — count, size or extension — are refused inline with a
 * sentence saying why, and only the files that pass every check are handed to `onAdd`. The server
 * re-checks all of them, so these checks keep an avoidable mistake off the wire rather than replacing
 * that gate.
 *
 * @param props See {@link FilePickerProps}.
 * @returns The labelled input, the drop target, the refusals of the last selection and the chosen files.
 */
export function FilePicker({
  files,
  onAdd,
  onRemove,
  disabled,
  maxFiles,
  maxFileBytes,
  acceptedExtensions,
}: FilePickerProps): JSX.Element {
  const inputId = useId();
  const [dropActive, setDropActive] = useState(false);
  const [refusals, setRefusals] = useState<readonly string[]>([]);
  // Read through a local so the callback below depends on a value the linter can check statically.
  const fileCount = files.length;

  /**
   * Checks one selection against the three caps and reports the outcome: the files that pass go up
   * through `onAdd`, and a sentence for each file that did not is shown here.
   */
  const receiveFiles = useCallback(
    (selected: readonly File[]) => {
      if (selected.length === 0) {
        return;
      }

      const accepted: File[] = [];
      const rejected: string[] = [];
      // Only files that pass take a slot, so a refused file never denies room to a later, valid one.
      const openSlots = Math.max(0, maxFiles - fileCount);
      let reportedFullSet = false;

      for (const file of selected) {
        if (accepted.length >= openSlots) {
          // One sentence covers the whole excess: it names no file, so repeating it per file would
          // say nothing more than it already does.
          if (!reportedFullSet) {
            rejected.push(
              `You can attach up to ${maxFiles} ${
                maxFiles === 1 ? 'file' : 'files'
              }. Remove one to add another.`,
            );
            reportedFullSet = true;
          }
          continue;
        }

        if (file.size > maxFileBytes) {
          rejected.push(
            `${file.name} is ${formatBytes(file.size)}, which is over the ${formatBytes(
              maxFileBytes,
            )} limit. Choose a smaller file.`,
          );
          continue;
        }

        if (
          !acceptedExtensions.some(
            (extension) => extension.toLowerCase() === fileExtension(file.name),
          )
        ) {
          rejected.push(
            `${file.name} is not a ${formatList(
              acceptedExtensions,
            )} file. Choose one of the supported formats.`,
          );
          continue;
        }

        accepted.push(file);
      }

      // The list describes the selection just made, so it replaces the previous one rather than
      // growing, and identical sentences collapse into one: two entries can only read the same when
      // they carry the same name, size and reason.
      setRefusals([...new Set(rejected)]);

      if (accepted.length > 0) {
        onAdd(accepted);
      }
    },
    [acceptedExtensions, fileCount, maxFileBytes, maxFiles, onAdd],
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target;
      receiveFiles(Array.from(input.files ?? []));
      // A file input fires `change` only when its value changes, so clearing it is what lets the same
      // file be chosen a second time after a refusal.
      input.value = '';
    },
    [receiveFiles],
  );

  /**
   * Marks the drop target as the one under the pointer. The browser's default for a dragged file is
   * to open it and leave the page, so that default is cancelled even while the picker is inert.
   */
  const activateDropZone = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (!disabled) {
        setDropActive(true);
      }
    },
    [disabled],
  );

  const deactivateDropZone = useCallback(() => {
    setDropActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDropActive(false);
      if (disabled) {
        return;
      }
      receiveFiles(Array.from(event.dataTransfer.files));
    },
    [disabled, receiveFiles],
  );

  return (
    <div
      className={[styles.field, disabled ? styles.disabled : undefined].filter(Boolean).join(' ')}
    >
      <label className={styles.label} htmlFor={inputId}>
        Choose requirements files to add
      </label>
      <input
        id={inputId}
        className={styles.input}
        type="file"
        multiple
        accept={acceptedExtensions.join(',')}
        onChange={handleInputChange}
        disabled={disabled}
      />
      <div
        className={[styles.dropZone, dropActive && !disabled ? styles.dropZoneActive : undefined]
          .filter(Boolean)
          .join(' ')}
        onDragEnter={activateDropZone}
        onDragOver={activateDropZone}
        onDragLeave={deactivateDropZone}
        onDrop={handleDrop}
      >
        or drop files here
      </div>
      {/* Kept in the document from the first render and left empty: a live region that is already
          present when its first sentence arrives is announced, where one inserted with the sentence
          may not be. */}
      <div aria-live="polite">
        {refusals.length > 0 ? (
          <ul className={styles.refusals}>
            {refusals.map((refusal) => (
              <li key={refusal} className={styles.refusalItem}>
                {refusal}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {files.length > 0 ? (
        <ul className={styles.fileList}>
          {files.map((file, index) => (
            <li key={`${index}-${file.name}-${file.size}`} className={styles.fileRow}>
              <span className={styles.fileName}>{file.name}</span>
              <span className={styles.fileSize}>{formatBytes(file.size)}</span>
              <button
                type="button"
                className={styles.removeButton}
                onClick={() => onRemove(index)}
                disabled={disabled}
                aria-label={`Remove ${file.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

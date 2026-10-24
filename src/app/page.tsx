import { PromptGenerator } from '@/components/PromptGenerator';
import {
  ACCEPTED_EXTENSIONS,
  MAX_DESCRIPTION_CHARS,
  MAX_FILE_BYTES,
  MAX_FILES,
} from '@/lib/validation';
import type { Limits } from '@/types';

import styles from './page.module.css';

/**
 * The caps the interactive components pre-check against, read from the server-only validation
 * module and handed down as data.
 *
 * This object is the whole reason `src/lib/validation.ts` is imported here and nowhere else on the
 * client's behalf. That module declares the limits and imports zod, so it is server-only by tier,
 * while the browser still needs the same four numbers to keep an avoidable rejection off the wire.
 * Every value below names the constant the server itself enforces - none is written out a second
 * time - so the tiers cannot come to disagree about a cap.
 *
 * `Limits.acceptedExtensions` is a mutable `string[]` because it assigns straight to the file
 * picker's prop, while the server's own allow-list is deliberately read-only; that spread is the
 * boundary between the two, not a copy for its own sake.
 */
const LIMITS: Limits = {
  maxFiles: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxDescriptionChars: MAX_DESCRIPTION_CHARS,
  acceptedExtensions: [...ACCEPTED_EXTENSIONS],
};

/**
 * The application's only page: the header, the working area and the footer, in that order.
 *
 * It is a server component, so the first paint needs no client-side data fetch and this page
 * contributes no client JavaScript of its own. Its whole job is the three landmarks and the caps:
 * the pasted-requirements field, the file picker, the Generate and Stop controls, the warnings
 * region and the draft region all live inside {@link PromptGenerator}'s tree and are not rendered
 * or duplicated here.
 *
 * The request's own instruction sentence ("Add a file or paste a description or requirements
 * below, ...") is rendered exactly once, by that input region, directly above the two inputs its
 * "below" refers to; the header carries the product title alone.
 *
 * @returns The single screen as server-rendered markup.
 */
export default function HomePage(): React.JSX.Element {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Build Prompt Generator</h1>
      </header>

      <main className={styles.main}>
        <PromptGenerator limits={LIMITS} />
      </main>

      <footer className={styles.footer}>
        <p>
          Nothing you enter here is stored. Your requirements and your draft stay in this browser
          tab.
        </p>
      </footer>
    </div>
  );
}

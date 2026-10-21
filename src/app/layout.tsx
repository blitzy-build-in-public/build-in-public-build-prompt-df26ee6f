import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * Document metadata for the application's single page.
 *
 * The description states what the product does in one sentence. The request's own
 * instruction sentence is not repeated here: it belongs to the input region, where it
 * tells the reader what to do next, and rendering it twice would say the same thing in
 * two places on one screen.
 */
export const metadata: Metadata = {
  title: 'Build Prompt Generator',
  description:
    'Add requirements as a file or as pasted text and get a draft build prompt to edit, copy or download. Nothing you enter is stored.',
};

/**
 * The root layout: the document shell every route in the application renders into.
 *
 * It is a server component, so it contributes no client JavaScript. It sets the document
 * language, which is what lets assistive technology announce the page in English, and it
 * is the single place the global stylesheet is imported - `src/app/globals.css` declares
 * the design tokens that the page and component stylesheets consume. The document also
 * stays free of wrapper elements so the header, main and footer landmarks the page
 * provides remain where they are.
 *
 * Deliberate omissions, recorded so they are not later "fixed" by mistake:
 * - No `viewport` export: the App Router emits the default `width=device-width,
 *   initial-scale=1` viewport meta itself, and responsive behaviour comes from the
 *   stylesheets rather than from a second declaration.
 * - No web font, third-party script or stylesheet, analytics, `theme-color`, manifest or
 *   `public/` asset: the page makes no request to another origin, and none of those
 *   features is in scope.
 * - No content security policy or header logic: the security headers are set once, for
 *   every route, in `next.config.ts`.
 * - No providers, context or client-side data fetching: only the `PromptGenerator`
 *   subtree is a client component.
 * - No `<head>` manipulation: metadata is expressed through the `metadata` export only.
 */
export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

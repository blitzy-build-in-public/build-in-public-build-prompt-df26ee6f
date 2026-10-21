/**
 * Vitest global setup, loaded once per test file by `vitest.config.ts` through `setupFiles`.
 *
 * It carries two responsibilities and nothing else: registering the jest-dom matchers on Vitest's
 * own `expect` (`toBeInTheDocument`, `toHaveAccessibleName`, `toHaveValue`, …) for the DOM suites,
 * and unmounting every rendered tree after each test so one test's markup can never be matched by
 * the next test's role queries.
 *
 * The shared Vitest configuration does not enable `globals`, so this file and every suite in the
 * tree import `describe`, `it`, `expect`, `vi`, `beforeEach` and `afterEach` from `vitest`
 * explicitly. Stubs, fake timers and fixtures stay inside the suite that needs them, so no suite
 * can leak a stubbed global or a clock into another.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  // Appended last so Prettier owns formatting: it switches off every stylistic rule
  // the two Next.js arrays enable that would otherwise fight `prettier --check`.
  prettier,
  // An object whose only key is `ignores` is a global ignore wherever it sits in the
  // array; keeping it last leaves one place that decides what the lint run never sees.
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
      'package-lock.json',
    ],
  },
];

export default config;

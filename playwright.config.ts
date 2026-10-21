import { defineConfig, devices } from '@playwright/test';

// One port drives both the base URL and the server started below, so the two cannot disagree.
const port = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  // CI retries are what make the trace below observable: it is recorded on the first retry.
  retries: process.env.CI ? 2 : 0,
  // A single worker bounds the suite's Chromium footprint, which matters on a host running
  // several checkouts at once; the suite is one spec file, so nothing is lost to it.
  workers: 1,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // The dev server rather than `next build && next start`: `npm run test:e2e` must work on a
    // fresh checkout straight after `npm ci`, with no prior build and no build artefact.
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // The stub provider is what makes this suite deterministic, offline and credential-free: it
    // reads no OPENAI_API_KEY and makes no outbound request, so the run never depends on either.
    env: {
      ...process.env,
      PROMPT_PROVIDER: 'stub',
      PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

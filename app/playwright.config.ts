import { defineConfig } from '@playwright/test';

/**
 * The fork end-to-end tests (SPEC-PHASE5-APP §14.2). They drive the Edge that is installed on the machine
 * (`channel: "msedge"`), so no Playwright browser is downloaded. One worker, one test at a time: all scenarios share
 * the two anvil forks and the in-process keeper that the worker-scoped fixture starts. Run them with
 * `npm run e2e` (needs `BSC_RPC`, an archive endpoint, in the environment; it is never read by the app or bundled).
 */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: '.cache/e2e-results',
  // a click or a navigation that cannot finish fails in 30 s instead of waiting for the end of the test
  use: { channel: 'msedge', headless: true, trace: 'off', viewport: { width: 1280, height: 900 }, actionTimeout: 30_000, navigationTimeout: 30_000 },
});

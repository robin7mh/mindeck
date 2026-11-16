import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests (`npm run test:e2e` builds everything first):
 * - electron: the real, built Electron app (its data in files under MINDECK_HOME — no database)
 * - web: the built web UI in Chromium against the real standalone core
 * Each test gets its own throwaway MINDECK_HOME, so real data is never touched.
 * PW_CHROMIUM may point at a preinstalled Chromium (sandboxes without
 * `npx playwright install`).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'electron', testMatch: 'app*.spec.ts' },
    {
      name: 'web',
      testMatch: 'web.spec.ts',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
        launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}
      }
    }
  ]
})

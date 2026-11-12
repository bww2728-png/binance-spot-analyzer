import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 7_500 },
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
    ...devices['Desktop Chrome'],
    launchOptions: { args: ['--no-sandbox'] }
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --host 0.0.0.0 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 30_000
  }
});

import { defineConfig, devices } from '@playwright/test';

// A dedicated port and throwaway database keep test users out of a dev
// server's data/inboxmax.db, even when a dev server is running. The server is
// built with the generated demo mailbox, so tests can connect any address
// without a real IMAP account.
const PORT = 3101;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node reset-db.mjs && cd ../server && cargo run --features fake-mail',
    env: {
      PORT: String(PORT),
      DATABASE_URL: 'sqlite:target/e2e/inboxmax.db',
      INBOXMAX_FAKE_MAIL: '1',
    },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});

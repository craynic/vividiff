import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    browserName: 'chromium',
    channel: 'msedge',
    locale: 'en-US',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node scripts/test-server.mjs',
      url: 'http://127.0.0.1:1431/health',
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command:
        'npx vite build --mode e2e --outDir .local/e2e-dist && npx vite preview --outDir .local/e2e-dist --host 127.0.0.1 --port 1420',
      url: 'http://127.0.0.1:1420',
      env: { VITE_TEST_RPC: 'http://127.0.0.1:1431/rpc' },
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4176', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 },
  webServer: { command: 'npm run build && npm run preview', url: 'http://127.0.0.1:4176', reuseExistingServer: false },
  reporter: 'list',
});

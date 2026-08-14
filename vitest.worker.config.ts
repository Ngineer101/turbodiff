import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vite-plus/test/config';

const migrations = await readD1Migrations(path.resolve('migrations'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          PUBLIC_BASE_URL: 'https://turbodiff.test',
          GITHUB_APP_SLUG: 'turbodiff-test',
          GITHUB_WEBHOOK_SECRET: 'worker-test-webhook-secret',
          GITHUB_OAUTH_CLIENT_ID: 'worker-test-client',
          GITHUB_OAUTH_CLIENT_SECRET: 'worker-test-client-secret',
          SESSION_SECRET: 'worker-test-session-secret-at-least-32-characters',
          REVIEW_DAILY_LIMIT: '50',
          TRIVIAL_MODEL: '',
        },
      },
    }),
  ],
  test: {
    include: ['src/**/*.worker.test.ts'],
  },
});

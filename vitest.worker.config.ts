import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vite-plus/test/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          PUBLIC_BASE_URL: 'https://turbodiff.test',
          GITHUB_APP_SLUG: 'turbodiff-test',
          GITHUB_WEBHOOK_SECRET: 'worker-test-webhook-secret',
          GITHUB_OAUTH_CLIENT_ID: 'worker-test-client',
          GITHUB_OAUTH_CLIENT_SECRET: 'worker-test-client-secret',
          SESSION_SECRET: 'worker-test-session-secret-at-least-32-characters',
          REVIEW_DAILY_LIMIT: '50',
          TRIVIAL_MODEL: '',
          // Fixture VAPID keypair for push.worker.test.ts — not used outside
          // tests, generated solely for exercising real ECDSA signing.
          VAPID_PUBLIC_KEY:
            'BMCruXdyzqJCyuy7Z_QdsXE0XlScsO-rLWuFERa0uz_UdPFprnIUKEie1UBVkzq3Z4KdHXkVWnMrMuM0aLkl9kk',
          VAPID_PRIVATE_KEY: '5YN1_AOlv_44hdDbaQ1em3RqplvbreQbr60kRina098',
          VAPID_SUBJECT: 'mailto:ops@turbodiff.test',
        },
      },
    }),
  ],
  test: {
    include: ['src/**/*.worker.test.ts'],
    // Worker files share one local PostgreSQL database. Serializing files
    // keeps each suite's explicit fixture cleanup isolated and deterministic.
    fileParallelism: false,
  },
});

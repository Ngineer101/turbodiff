import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus/test/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'cloudflare:workers',
        replacement: fileURLToPath(new URL('../support/cloudflare-workers.ts', import.meta.url)),
      },
      {
        find: '@cloudflare/sandbox',
        replacement: fileURLToPath(new URL('../support/cloudflare-sandbox.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['tests/integration/**/*.integration.test.ts'],
    fileParallelism: false,
  },
});

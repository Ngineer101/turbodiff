import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus/test/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'cloudflare:workers',
        replacement: fileURLToPath(
          new URL('../../src/api/server/__tests__/support/cloudflare-workers.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ['src/api/server/__tests__/integration/**/*.integration.test.ts'],
    fileParallelism: false,
  },
});

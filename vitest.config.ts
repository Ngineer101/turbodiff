import { defineConfig } from 'vite-plus/test/config';

// Vitest prefers this file over vite.config.ts, which is exactly the point:
// the root Vite config registers @cloudflare/vite-plugin, whose environment
// validation rejects the `resolve.external` Vitest injects — `vp test`
// cannot boot through it (pre-existing incompatibility). The unit tests are
// pure functions needing no Workers runtime, so they run through this
// plugin-free config instead, covering both the Worker and client sources.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
	},
});

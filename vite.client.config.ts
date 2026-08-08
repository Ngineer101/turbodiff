import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

// Builds the signed-in SPA (src/client) into public/app, which the Worker
// serves as static assets — the same pattern the old esbuild cockpit bundle
// used. Entry + stylesheet get fixed names so the Worker's HTML shell
// (src/routes/ui.ts) can reference them statically; code-split chunks
// (@pierre/diffs syntax themes etc.) keep content hashes.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	// The outDir lives inside public/ (the Worker's static-asset dir), so
	// never mirror publicDir into it — Vite+ copies it by default.
	publicDir: false,
	resolve: {
		alias: { '@': path.resolve(import.meta.dirname, 'src/client') },
	},
	build: {
		outDir: 'public/app',
		emptyOutDir: true,
		cssCodeSplit: false,
		rollupOptions: {
			input: path.resolve(import.meta.dirname, 'src/client/main.tsx'),
			output: {
				entryFileNames: 'app.js',
				chunkFileNames: 'chunks/[name]-[hash].js',
				assetFileNames: (info) =>
					info.names.some((n) => n.endsWith('.css')) ? 'app.css' : 'assets/[name]-[hash][extname]',
			},
		},
	},
});

import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

// Builds the signed-in SPA (src/client) into public/app, which the Worker
// serves as static assets — the same pattern the old esbuild cockpit bundle
// used. Every asset is content-hashed and the Worker reads Vite's manifest
// through its static-assets binding when it renders the SPA shell. That lets
// browsers cache the complete client forever without risking mixed deploys.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The Worker serves every generated client file below /app/. Vite embeds
  // this base into its dynamic-import preload helper; without it, route
  // transitions probe /chunks/* and pay a failing request before import.
  base: '/app/',
  // The outDir lives inside public/ (the Worker's static-asset dir), so
  // never mirror publicDir into it — Vite+ copies it by default.
  publicDir: false,
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src/client') },
  },
  build: {
    outDir: 'public/app',
    emptyOutDir: true,
    manifest: 'manifest.json',
    rollupOptions: {
      input: path.resolve(import.meta.dirname, 'src/client/main.tsx'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

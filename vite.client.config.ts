import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite-plus';

const PERFORMANCE_BUDGETS = {
  entry: 275_000,
  css: 60_000,
  featureRoute: 40_000,
  cockpitDiff: 525_000,
  codeRoute: 30_000,
  codeEditor: 90_000,
} as const;

function performanceBudgets(): Plugin {
  return {
    name: 'turbodiff-performance-budgets',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assertBudget = (name: string, size: number, limit: number) => {
        if (size <= limit) return;
        this.error(`${name} is ${size} bytes; performance budget is ${limit} bytes`);
      };
      for (const output of Object.values(bundle)) {
        if (output.type === 'asset') {
          if (output.fileName.endsWith('.css')) {
            assertBudget('client CSS', output.source.length, PERFORMANCE_BUDGETS.css);
          }
          continue;
        }
        if (output.isEntry) {
          assertBudget('client entry', output.code.length, PERFORMANCE_BUDGETS.entry);
        }
        const module = output.facadeModuleId ?? '';
        if (module.endsWith('/pages/feature.tsx')) {
          assertBudget('feature route', output.code.length, PERFORMANCE_BUDGETS.featureRoute);
        } else if (module.endsWith('/components/cockpit-patch-diff.tsx')) {
          assertBudget(
            'cockpit diff renderer',
            output.code.length,
            PERFORMANCE_BUDGETS.cockpitDiff,
          );
        } else if (module.endsWith('/pages/code.tsx')) {
          assertBudget('code route', output.code.length, PERFORMANCE_BUDGETS.codeRoute);
        } else if (module.endsWith('/components/code-editor.tsx')) {
          assertBudget('code editor', output.code.length, PERFORMANCE_BUDGETS.codeEditor);
        }
      }
    },
  };
}

// Builds the signed-in SPA (src/client) into public/app, which the Worker
// serves as static assets — the same pattern the old esbuild cockpit bundle
// used. Every asset is content-hashed and the Worker reads Vite's manifest
// through its static-assets binding when it renders the SPA shell. That lets
// browsers cache the complete client forever without risking mixed deploys.
export default defineConfig({
  plugins: [react(), tailwindcss(), performanceBudgets()],
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

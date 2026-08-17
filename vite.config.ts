import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig, lazyPlugins } from 'vite-plus';

export default defineConfig({
  // lazyPlugins keeps check/lint/fmt from booting the Cloudflare plugin
  // (which needs Docker/bindings); dev/build load it as before.
  plugins: lazyPlugins(() => [flue(), cloudflare({ config: flueWorkerConfig() })]),
  // Repo style: tabs + single quotes (configured so a future `vp fmt` run
  // doesn't reindent the codebase as a side effect).
  fmt: {
    useTabs: false,
    singleQuote: true,
    printWidth: 100,
    // Agent tooling dirs + the vendored oxlint plugin are not app source —
    // keep fmt/lint from touching them.
    ignorePatterns: [
      '.agent/**',
      '.agents/**',
      '.claude/**',
      '.codex/**',
      '.continue/**',
      '.cursor/**',
      '.gemini/**',
      '.opencode/**',
      '.pi/**',
      '.roo/**',
      '.windsurf/**',
      'tools/oxlint/anti-slop/**',
    ],
  },
  lint: {
    ignorePatterns: [
      '.agent/**',
      '.agents/**',
      '.claude/**',
      '.codex/**',
      '.continue/**',
      '.cursor/**',
      '.gemini/**',
      '.opencode/**',
      '.pi/**',
      '.roo/**',
      '.windsurf/**',
      'tools/oxlint/anti-slop/**',
    ],
    jsPlugins: [
      { name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' },
      { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
    ],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'anti-slop/no-chained-type-assertions': 'error',
      'anti-slop/no-conditional-empty-object-spread': 'error',
      'anti-slop/no-known-value-widening': 'error',
      'anti-slop/no-module-mocking': 'error',
      'anti-slop/no-object-parameters': 'error',
      'anti-slop/no-reflect-apply': 'error',
      'anti-slop/no-reflect-get': 'error',
      'anti-slop/no-runtime-typeof': 'error',
      'anti-slop/no-shape-in-symbol-names': 'error',
      'anti-slop/no-unknown-parameters': 'error',
      'anti-slop/no-unknown-returns': 'error',
      'anti-slop/no-unknown-type-aliases': 'error',
      'anti-slop/no-unsafe-dictionary-type': 'error',
      'anti-slop/no-widen-then-assert': 'error',
      'anti-slop/require-safety-comment-for-type-assertion': 'error',
    },
    options: { typeAware: true, typeCheck: true },
  },
  check: {
    // The pre-Vite+ codebase has never been oxfmt-formatted; a blanket
    // reformat is deliberately NOT part of the migration (land it as its
    // own commit if wanted). Until then `vp check` = lint + types.
    fmt: true,
  },
  staged: {
    '*': 'vp check --fix',
  },
  run: {
    tasks: {
      'build:app': { command: 'vp build --config vite.client.config.ts', cache: true },
      dev: { command: 'vp dev', dependsOn: ['build:app'] },
      build: { command: 'vp build', dependsOn: ['build:app'] },
      deploy: { command: 'wrangler deploy', dependsOn: ['build'] },
      'check:types': {
        command:
          'wrangler types && tsc --noEmit && tsc -p tsconfig.client.json --noEmit && tsc -p tsconfig.worker-tests.json --noEmit',
      },
    },
  },
  // Tests live in vitest.config.ts (plugin-free) — see the note there.
});

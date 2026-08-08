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
		useTabs: true,
		singleQuote: true,
		printWidth: 100,
	},
	lint: {
		jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
		rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
		options: { typeAware: true, typeCheck: true },
	},
	check: {
		// The pre-Vite+ codebase has never been oxfmt-formatted; a blanket
		// reformat is deliberately NOT part of the migration (land it as its
		// own commit if wanted). Until then `vp check` = lint + types.
		fmt: false,
	},
	run: {
		tasks: {
			'build:app': { command: 'vp build --config vite.client.config.ts', cache: true },
			dev: { command: 'vp dev', dependsOn: ['build:app'] },
			build: { command: 'vp build', dependsOn: ['build:app'] },
			deploy: { command: 'wrangler deploy', dependsOn: ['build'] },
			'check:types': { command: 'tsc --noEmit && tsc -p tsconfig.client.json --noEmit' },
		},
	},
	// Tests live in vitest.config.ts (plugin-free) — see the note there.
});

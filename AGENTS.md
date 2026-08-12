# AGENTS.md

This is a [Flue](https://flueframework.com) project: agents are TypeScript functions.
The app is Turbodiff, a multi-tenant GitHub App for AI PR review, hosted on Cloudflare
Workers at <https://turbodiff.dev> (repo: <https://github.com/Ngineer101/turbodiff>).

## Layout

- `src/agents/` — agent modules. A module whose first line is the `'use agent'` directive exports agents: every exported capitalized function is one, and the function name is its durable identity. `PrReviewer` is the one generic reviewer: every configured agent (built-in persona or user-created row in the `agents` table) runs through it, config delivered per dispatch as a `review.request` signal and read at render time via `useDelivery()`. Instance ids are `<agent-slug>--<owner>--<repo>--<pr>`.
- `src/lib/personas.ts` — built-in personas (review/security/a11y/o11y) seeded lazily per installation; `review` is the default agent and defaults on per repo, others default off (see `resolveAgentEnabled` in db.ts).
- `src/tools/github.ts` — the agent's GitHub tools (`fetch_pr`, `fetch_file`, `post_review`); all calls use per-installation App tokens. `post_review` also marks the review row completed in D1.
- `src/routes/webhooks.ts` — GitHub App webhook receiver: mirrors installations/repos into D1 and drives the factory's review/fix loop — auto-dispatches the repo-enabled agents when a factory-generated PR opens or gets pushed to (daily cap per installation), and enqueues a fix run when one of turbodiff's own blocking reviews lands. Human-opened PRs are never reviewed (the standalone auto-review product was retired; reviews gate factory output only).
- `src/routes/landing.tsx` — signed-out home page, server-rendered with hono/jsx (`jsxImportSource: hono/jsx` in tsconfig; no client-side React). The CSS and Three.js client script are plain strings injected via `dangerouslySetInnerHTML`; the script string must not contain backticks or `${` sequences.
- `src/routes/ui.ts` — OAuth sign-in and the HTML shell for the signed-in SPA; logged-out `/` serves the landing page. `DEV_FAKE_INSTALLATIONS` in .dev.vars fakes sign-in locally (never set in prod).
- `src/routes/api.ts` — session-cookie-authed JSON API under `/api/*` that the SPA consumes (kanban board + todos/tasks, usage metrics, factory cockpit, agents, the installation-level integrations registry, per-repo settings). Response shapes live in `src/shared/api-types.ts`, type-checked in both the worker and client programs.
- `src/client/` — the signed-in SPA: TanStack Router (code-based routes in `main.tsx`), TanStack Query (loaders + polling while agents run), Tailwind v4 tokens in `styles.css`, shared primitives in `components/ui/`, one file per page in `pages/`. Built by `vite.client.config.ts` into `public/app` (fixed entry names `app.js`/`app.css`, referenced by the shell in ui.ts); the `@pierre/diffs` cockpit is a lazy route. `npm run build:app` builds it; `dev`/`build`/`deploy` run it first.
- `src/lib/` — D1 access (`db.ts`), GitHub App auth (`github-app.ts`), session cookies (`session.ts`).
- `src/app.ts` — the route map; every route is mounted here explicitly, plus `dispatchReviewAgent` (programmatic `dispatch()`, records the review row). `/internal/*` (agent conversation reads — debugging: GET `/internal/pr-reviewer/<instance-id>`) requires `Authorization: Bearer $REVIEW_SECRET`; the signed-in UI owns `/agents`.
- `src/cloudflare.ts` — Worker-level exports and non-HTTP handlers.
- `migrations/` — D1 schema (`installations`, `repositories`, `reviews` with lifecycle status). Apply with `npx wrangler d1 migrations apply turbodiff [--local | --remote]`.
- `public/` — static assets (logo), auto-served by the Cloudflare Vite plugin.
- `wrangler.jsonc` — Worker config; every agent needs a Durable Object migration entry.

## Commands

The toolchain is [Vite+](https://viteplus.dev) (`vp`), which owns the package manager
(pnpm 11 via `devEngines`), the Node version (`.node-version`), and the task runner
(tasks live in `vite.config.ts` `run.tasks` — task names may not collide with
package.json script names, which is why dev/build/deploy exist only as tasks).

- `vp install` — install dependencies (pnpm underneath; `pnpm-workspace.yaml` carries
  the `@flue/runtime` patch and native-build allowlist — the patch is load-bearing).
- `vp run dev` — start the dev server (builds the client SPA first).
- `vp run build` / `vp run deploy` — build, or build and deploy the Worker.
- `vp run check:types` — typecheck both tsconfig programs (cached).
- `vp check` — lint + typecheck (format-check is off until the repo is oxfmt-formatted).
- `vp test` — Vitest smoke tests via the plugin-free `vitest.config.ts` (the root Vite
  config's Cloudflare plugin is incompatible with Vitest's environment options — do not
  move the `test` block into it).
- `vp lint` / `vp fmt` — Oxlint / Oxfmt (fmt configured for the repo's tabs + single
  quotes in `vite.config.ts`).
- `vp exec <bin>` — escape hatch for anything a `vp` subcommand doesn't cover
  (e.g. `vp exec wrangler ...`).
- `npx flue run src/agents/hello.ts --message "Hi"` — run an agent locally, no server.
- `npx flue docs search <query>` — search the Flue docs from the terminal (then `flue docs read <path>`).

## Conventions

- Reviews are tracked in D1: dispatched rows insert as `running`; `post_review` flips them to `completed`. A row still `running` after ~20 min renders as `stalled` on `/reviews`.
- The reviewer model is set in `src/agents/pr-reviewer.ts` (`cloudflare/anthropic/claude-sonnet-5`, `thinkingLevel: 'off'` — see the comment there before changing it).
- No provider API keys live in the Worker: model calls go through the `env.AI` binding into the named AI Gateway (`AI_GATEWAY_ID` in wrangler.jsonc). The one exception is opt-in: a user's own runner credential (`runner_credentials`, `src/lib/fixer.ts` `resolveRunnerAuth`) or a factory Worker-level secret authenticates the sandboxed coding-agent CLI (Claude Code / Codex) for fix/plan/generate/verify runs — sealed in D1 with `src/lib/crypto.ts`, decrypted only inside the sandbox exec path, and scrubbed from every surfaced output. Review agents are unaffected — they still only ever go through the shared AI Gateway.

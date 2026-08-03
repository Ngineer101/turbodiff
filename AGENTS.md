# AGENTS.md

This is a [Flue](https://flueframework.com) project: agents are TypeScript functions.
The app is Turbodiff, a multi-tenant GitHub App for AI PR review, hosted on Cloudflare
Workers at <https://turbodiff.dev> (repo: <https://github.com/Ngineer101/turbodiff>).

## Layout

- `src/agents/` — agent modules. A module whose first line is the `'use agent'` directive exports agents: every exported capitalized function is one, and the function name is its durable identity.
- `src/tools/github.ts` — the agent's GitHub tools (`fetch_pr`, `fetch_file`, `post_review`); all calls use per-installation App tokens. `post_review` also marks the review row completed in D1.
- `src/routes/webhooks.ts` — GitHub App webhook receiver: mirrors installations/repos into D1, auto-dispatches reviews on PR open/ready (daily cap per installation), and dispatches on-demand reviews when a collaborator comments `@<app-slug> review` on a PR (works even with auto-review toggled off; acknowledges with a 👀 reaction — needs the App subscribed to Issue comment events with Issues read & write).
- `src/routes/landing.tsx` — signed-out home page, server-rendered with hono/jsx (`jsxImportSource: hono/jsx` in tsconfig; no client-side React). The CSS and Three.js client script are plain strings injected via `dangerouslySetInnerHTML`; the script string must not contain backticks or `${` sequences.
- `src/routes/settings.ts` — signed-in UI (hono/html templates): `/` metrics dashboard (cost/tokens/duration tiles, monthly cost, 5 most recent reviews and repos), `/reviews` paginated history, `/settings` per-repo auto-review toggles. Reviews render running / done / stalled and auto-refresh while running. `DEV_FAKE_INSTALLATIONS` in .dev.vars fakes sign-in locally (never set in prod).
- `src/lib/` — D1 access (`db.ts`), GitHub App auth (`github-app.ts`), session cookies (`session.ts`).
- `src/app.ts` — the route map; every route is mounted here explicitly. `/agents/*` and `/review` require `Authorization: Bearer $REVIEW_SECRET`.
- `src/cloudflare.ts` — Worker-level exports and non-HTTP handlers.
- `migrations/` — D1 schema (`installations`, `repositories`, `reviews` with lifecycle status). Apply with `npx wrangler d1 migrations apply turbodiff [--local | --remote]`.
- `public/` — static assets (logo), auto-served by the Cloudflare Vite plugin.
- `wrangler.jsonc` — Worker config; every agent needs a Durable Object migration entry.

## Commands

- `npx flue run src/agents/hello.ts --message "Hi"` — run an agent locally, no server.
- `npm run dev` — start the dev server.
- `npm run deploy` — build and deploy the Worker.
- `npm run check:types` — typecheck.
- `npx flue docs search <query>` — search the Flue docs from the terminal (then `flue docs read <path>`).
- `npx flue add` — list blueprints for adding channels, sandboxes, and databases.

`package.json` pins npm ≥ 12 via `devEngines`; if npm refuses to run scripts, call the
binaries directly (`./node_modules/.bin/vite dev`, `./node_modules/.bin/tsc --noEmit`,
`./node_modules/.bin/wrangler deploy`). `npm install` needs `--legacy-peer-deps`.

## Conventions

- Reviews are tracked in D1: dispatched rows insert as `running`; `post_review` flips them to `completed`. A row still `running` after ~20 min renders as `stalled` on `/reviews`.
- The reviewer model is set in `src/agents/pr-reviewer.ts` (`cloudflare/anthropic/claude-sonnet-5`, `thinkingLevel: 'off'` — see the comment there before changing it).
- No provider API keys live in the Worker: model calls go through the `env.AI` binding into the named AI Gateway (`AI_GATEWAY_ID` in wrangler.jsonc).

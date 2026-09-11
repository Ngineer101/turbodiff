# AGENTS.md

Turbodiff is a multi-tenant software factory whose agents are pure TypeScript definitions.
The app is hosted on Cloudflare Workers (repo: <https://github.com/Ngineer101/turbodiff>)

## Layout

- `src/agents/` — pure agent definitions: Zod input/output contracts, prompts, and repository-access requirements. All definitions run through `runAgent()`; they never own persistence, publication, queues, or provider APIs.
- `src/artifacts/` — typed semantic outputs passed between agents and factory stages.
- `src/ai/` — sandbox runners, runtime support, and durable Workflows. `runtime/` owns runner authentication, sandbox access, redaction, skill mounting, repository-workspace mechanics, and the model-neutral OpenCode adapter; stage orchestration stays explicit in `runners/` and `workflows/`. Legacy modules whose first line is `'use agent'` are Flue durable identities and require Durable Object migrations.
- `src/domain/` — pure policies and value logic: personas, scheduling, attribution, prompt security, skill rendering, and AI Gateway model/capability policy.
- `src/data/` — Drizzle/PostgreSQL persistence through Cloudflare Hyperdrive. `schema.ts` is the schema source of truth, `database.ts` owns short-lived Hyperdrive clients, and `db.ts` is the stable facade; queries and row types are split across repositories, factory, agents, connections, reviews, usage, credentials, board, and automations.
- `src/api/` — the signed-in Effect JSON API. `contract/` is the runtime-schema source of truth for endpoints, payloads, responses, and problem errors. `server/<domain>/handlers.ts` is transport wiring and `service.ts` owns endpoint-specific authorization and use cases. API-only serialization stays beside that domain. Shared application or provider behavior must not be placed here.
- `src/application/` — cross-entrypoint use cases and authorization grouped by domain. API services, Workflows, queues, cron handlers, webhooks, and internal protocols may depend on this layer; it never imports `src/api/` or accepts Hono contexts. Reusable Worker capabilities such as immutable JSON caching live here. Factory producers use `application/factory/queue.ts`, lifecycle orchestration lives in `application/factory/lifecycle.ts`, and MCP tool use cases live in `application/mcp/tools.ts`.
- `src/integrations/` — GitHub, better-auth, MCP, OAuth connection credentials, source-code access, skills.sh, AI Gateway, notification, and cryptographic adapters. External protocol, grant-signing, credential-refresh, and provider-specific details belong here, never in data queries. GitHub REST JSON and pagination go through `integrations/github/client.ts`.
- `src/http/` — Hono adapters and server-rendered views for transports intentionally outside the Effect JSON API: auth callbacks, WebSockets, multipart, redirects, raw streams, public capability URLs, webhooks, MCP, and the sandbox AI proxy. Permanent credentials stay in the Worker. The landing page's injected script string must not contain backticks or `${` sequences.
- `src/client/` — the signed-in SPA: TanStack Router (code-based routes in `main.tsx`), TanStack Query (loaders + polling while agents run), Tailwind v4 tokens in `styles.css`, shared primitives in `components/ui/`, one file per page in `pages/`. Built by `vite.client.config.ts` into `public/app` (fixed entry names `app.js`/`app.css`, referenced by the shell in ui.ts); the `@pierre/diffs` cockpit is a lazy route. `npm run build:app` builds it; `dev`/`build`/`deploy` run it first.
- `src/app.ts` — the HTTP composition root; provider setup and route mounting only. `/internal/*` is implemented in `src/http/internal.ts` and requires `Authorization: Bearer $REVIEW_SECRET`.
- `src/cloudflare.ts` — Worker-level exports and non-HTTP handlers.
- `db/migrations/` — Drizzle migrations for the PostgreSQL `app` and `auth` schemas. Generate from `src/data/schema.ts` with `vp exec drizzle-kit generate --name=<name>`, apply through a direct `DATABASE_URL` with `vp run db:migrate`, and verify with `vp run db:verify`. Worker traffic uses the `HYPERDRIVE` binding.
- `public/` — static assets (logo), auto-served by the Cloudflare Vite plugin.
- `wrangler.jsonc` — Worker config; every Flue durable identity needs a Durable Object migration entry, while generic agents run in Workflows.

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
- `vp run test:schema` — apply every migration to an embedded fresh PostgreSQL instance and verify structural invariants.
- `vp run test:worker` — migrate `DATABASE_URL`, then run Worker integration tests against PostgreSQL through Hyperdrive.
- `vp run db:check` — validate the Drizzle migration snapshots.
- `vp run db:migrate` / `vp run db:status` / `vp run db:verify` — operate the direct PostgreSQL migration connection.
- `vp lint` / `vp fmt` — Oxlint / Oxfmt (fmt configured for the repo's tabs + single
  quotes in `vite.config.ts`).
- `vp exec <bin>` — escape hatch for anything a `vp` subcommand doesn't cover
  (e.g. `vp exec wrangler ...`).

- `npx flue docs search <query>` — search the Flue docs from the terminal (then `flue docs read <path>`).

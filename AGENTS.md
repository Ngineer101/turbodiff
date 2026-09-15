# AGENTS.md

Turbodiff is a multi-tenant software factory hosted on Cloudflare Workers.
`docs/architecture.md` is the canonical design document.

## Layout

- `src/agents/` — pure TypeScript agent definitions and the generic `runAgent()` boundary.
- `src/artifacts/` — typed immutable contracts passed between agents and stages.
- `src/domain/` — pure policy and value logic.
- `src/data/` — PostgreSQL persistence through Hyperdrive; `schema.ts` is authoritative, `postgres.ts` owns the runtime connection, and domain files own their SQL.
- `src/integrations/` — external-system and runtime adapters for Better Auth, GitHub, hosted Git, AI Gateway, MCP, email, crypto, and sandbox execution.
- `src/application/` — reusable auth, webhook, repository, integration, automation, and factory use cases.
- `src/api/contract/` — the complete signed-in JSON API contract.
- `src/api/server/` — Effect handlers and API-specific services grouped by domain.
- `src/api/client/` — the contract-derived browser client.
- `src/http/` — Hono adapters for pages and protocol-specific auth, webhooks, WebSockets, uploads, and streams.
- `src/shared/` — small provider-neutral values and parsers shared across boundaries.
- `src/client/` — TanStack Router/Query SPA built into `public/app`.
- `src/app.ts` and `src/cloudflare.ts` — HTTP and Worker composition roots.
- `db/migrations/0000_baseline.sql` — clean database baseline; it requires an empty database.

## Commands

- `vp install` — install dependencies.
- `vp run dev` — build the client and start the Worker locally.
- `vp run build` / `vp run deploy` — build or deploy.
- `vp run check:types` — regenerate Worker types and typecheck Worker and client.
- `vp check` — lint, typecheck, and formatting checks.
- `vp test` — unit tests.
- `vp run test:integration` — service integration tests against `DATABASE_URL`; writes roll back.
- `vp run test:schema` — apply and validate the baseline on embedded PostgreSQL.
- `vp run db:generate --name=<name>` — generate a migration after changing `src/data/schema.ts`.
- `vp run db:migrate` / `vp run db:status` / `vp run db:verify` — operate the direct PostgreSQL migration connection using `DATABASE_URL`.
- `vp run db:check` — validate the Drizzle schema and migration history.

## Rules

- Better Auth organizations are tenant roots. GitHub installations are integrations.
- Every cross-tenant-capable relationship must be protected by an organization-aware foreign key.
- Agent definitions never own databases, queues, providers, publication, or orchestration.
- Agent input/output bodies are immutable artifacts in R2 with metadata in PostgreSQL.
- Factory state is `factory_run → stage_run → agent_run`, with append-only lifecycle events.
- API schemas and endpoints live in `src/api/contract`; the browser uses the derived client.
- Reusable use cases belong in `src/application`, provider mechanics in `src/integrations`, and SQL in `src/data`.
- Queue messages contain durable ids, not duplicated business payloads.
- Do not introduce compatibility layers for the deleted legacy API or schema.

# Architecture

Turbodiff uses a small layered architecture. The layers are directories, not
framework abstractions: functions remain plain TypeScript and dependencies are
imported directly.

## Dependency direction

```text
HTTP / Worker entrypoints
        |
        v
application services <---- AI orchestration
        |                       |
        +----------+------------+
                   v
             data + integrations
                   |
                   v
                 domain
```

- `src/domain/` contains pure policy and value logic. It does not import
  Cloudflare bindings, Hono, databases, or remote clients.
- `src/data/` contains PostgreSQL row types and queries. `db.ts` is a stable facade;
  implementations are grouped by responsibility so callers do not depend on a
  single query god-module.
- `src/integrations/` adapts external systems: GitHub, better-auth, MCP,
  notifications, and cryptography. Network protocol details stay here. The
  GitHub client owns authenticated JSON requests and bounded pagination.
- `src/services/` implements application use cases and authorization policy.
  Services may coordinate data and integrations, but never accept or return
  Hono contexts. Factory producers enqueue the shared message contract through
  `factory-queue.ts` rather than reaching into a queue binding directly.
- `src/ai/` owns agent definitions, tools, sandbox runners, metering, dispatch,
  and durable Workflows. `runtime/` contains shared runner authentication,
  sandbox access, secret redaction, skill mounting, and repository-workspace
  mechanics; `runners/` and `workflows/` keep stage orchestration explicit.
  HTTP routes enqueue or call these use cases; agent code does not own request
  authentication.
- `src/http/` owns request parsing, response serialization, middleware, and
  server-rendered pages. Routes should validate transport input and delegate
  decisions to services or AI use cases.
- `src/app.ts` and `src/cloudflare.ts` are composition roots only: they register
  providers and mount HTTP, queue, cron, Workflow, and Durable Object handlers.
- `src/shared/` contains serializable contracts shared across Worker, client,
  persistence, or AI boundaries.

## Boundary examples

The GitHub webhook route verifies the signature and parses JSON in
`src/http/webhooks.ts`. `src/services/github-webhooks.ts` decides what the
event means, and `src/ai/review/dispatch.ts` admits and dispatches the durable
reviewer.

Connection rows and compare-and-set refresh claims live in
`src/data/connections.ts`. Credential decryption and OAuth refresh policy live
in `src/services/connections.ts`; protocol calls live in
`src/integrations/mcp/oauth.ts`. The non-secret connection contract lives in
`src/shared/connections.ts`, while its row-to-contract mapping belongs to the
service layer.

Factory queue payloads live in `src/shared/factory-messages.ts`. Producers use
`src/services/factory-queue.ts`; the composition root in `src/cloudflare.ts`
is the only place that routes the union to concrete runners and Workflows.

## Adding functionality

1. Put pure rules and stable value types in `domain` or `shared`.
2. Add PostgreSQL queries to the matching `data` module and re-export them from
   `data/db.ts` when they are part of the data API.
3. Put external protocol details in `integrations`.
4. Coordinate the use case in `services` or `ai`.
5. Keep the HTTP/queue handler to parsing, authentication, delegation, and
   response mapping.

Avoid repository classes, dependency-injection containers, and one-interface-
per-function abstractions. Add an abstraction only when it creates a real
boundary, enables a test seam, or consolidates policy used by multiple entry
points.

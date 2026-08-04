# Turbodiff

<img src="public/logo-small.png" alt="Turbodiff logo" width="64" align="right" />

Open-source AI code review for teams that ship more code than they can review.
Turbodiff is a GitHub App built with [Flue](https://flueframework.com) and hosted
end-to-end on Cloudflare Workers: install it, pick your repositories, and every
new pull request gets an automatic review — a short summary plus inline comments
on the exact lines each finding concerns.

**Live at [turbodiff.dev](https://turbodiff.dev)** — or self-host it on your own
Cloudflare account (see [One-time setup](#one-time-setup)).

```
GitHub webhook (PR opened) ──▶ Worker ──▶ PrReviewer agent (Durable Object, one per PR)
        │                        │            │  fetch_pr / fetch_file (GitHub API,
Landing + settings + /reviews    │            │    per-installation App tokens)
(sign in, toggle repos, watch    │            │  model calls via env.AI ─▶ AI Gateway ─▶ Claude
running reviews) ──▶ D1 config ◀─┘            └─ post_review ──▶ inline PR comments
                     & review status ◀────────────┘ (marks the review completed)
```

## How it works

- [src/agents/pr-reviewer.ts](src/agents/pr-reviewer.ts) — the agent: model choice
  (`cloudflare/anthropic/claude-sonnet-5` through your gateway) and review instructions.
- [src/tools/github.ts](src/tools/github.ts) — its tools: `fetch_pr` (metadata + diff),
  `fetch_file` (extra context), `post_review` (summary body + inline comments anchored to
  diff lines, falling back to body-only if an anchor is rejected; also flips the review's
  D1 row to `completed`). All GitHub calls authenticate as the App installation that owns
  the repo (looked up in D1).
- [src/routes/webhooks.ts](src/routes/webhooks.ts) — GitHub App webhooks: syncs
  installations/repositories into D1 and auto-dispatches reviews on `pull_request`
  `opened` / `ready_for_review` (drafts skipped, per-installation daily cap).
- [src/routes/landing.tsx](src/routes/landing.tsx) — the signed-out home page, a
  server-rendered hono/jsx component with a Three.js "self-typing terminal" animation.
- [src/routes/settings.ts](src/routes/settings.ts) — the signed-in UI: enable/disable
  reviews per repository, and the `/reviews` activity page showing each review as
  `reviewing` (live, auto-refreshing), `done` (linking to the posted review), or
  `stalled` (dispatched but never completed).
- [src/lib/github-app.ts](src/lib/github-app.ts) — App JWTs, installation tokens, webhook
  signature verification, OAuth.
- [src/app.ts](src/app.ts) — routing and the manual `POST /review` trigger.
- [migrations/](migrations/) — D1 schema: `installations`, `repositories`, `reviews`
  (including review lifecycle status).
- [public/](public/) — static assets (logo), served by the Worker's asset binding.

Each PR gets its own durable agent instance (`owner--repo--number`), so a re-review of the
same PR continues the same conversation.

## One-time setup

Everything runs on a single Cloudflare account: the Worker, D1, the AI Gateway, and the
static assets. To self-host, create your own GitHub App and deploy:

1. **Dependencies** (peer-dep conflict upstream in `agents`/`ai` requires the flag):

   ```sh
   npm install --legacy-peer-deps
   ```

2. **AI Gateway** — in [wrangler.jsonc](wrangler.jsonc), set `AI_GATEWAY_ID` to your existing
   gateway's name. The gateway must be able to serve Anthropic models: either store your
   Anthropic key in the gateway (BYOK) or enable Cloudflare's unified billing for it.

3. **D1** — create a `turbodiff` D1 database, put its id in [wrangler.jsonc](wrangler.jsonc),
   and apply the schema:

   ```sh
   npx wrangler d1 migrations apply turbodiff --local    # for dev
   npx wrangler d1 migrations apply turbodiff --remote   # for production
   ```

4. **GitHub App** — create one at <https://github.com/settings/apps> (or under your org):
   - **Webhook URL**: `https://<your-worker>/webhooks/github`, with a webhook secret
     (`openssl rand -hex 32`).
   - **Repository permissions**: Contents (read-only), Pull requests (read & write).
   - **Subscribe to events**: Pull request, Installation target, Repository.
     (Installation events are always delivered to Apps.)
   - **Callback URL** (under "Identifying and authorizing users"):
     `https://<your-worker>/auth/callback`. Note the OAuth client id and generate a client
     secret.
   - Generate a **private key** and convert it to PKCS#8 (WebCrypto can't read the PKCS#1
     file GitHub gives you):

     ```sh
     openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem
     ```

   - Set `GITHUB_APP_SLUG` in [wrangler.jsonc](wrangler.jsonc) to the app's URL slug
     (`github.com/apps/<slug>`).

5. **Secrets** — locally, fill in [.dev.vars](.dev.vars); in production:

   ```sh
   npx wrangler secret put GITHUB_APP_ID
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # the PKCS#8 PEM, whole file
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
   npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET           # openssl rand -hex 32
   npx wrangler secret put REVIEW_SECRET            # openssl rand -hex 32 (operator endpoints)
   # Only needed if agents will use authenticated external MCP connections:
   npx wrangler secret put TOKEN_ENCRYPTION_KEY     # openssl rand -hex 32 (seals MCP tokens)
   ```

6. **Custom domain** (optional) — add a custom domain to the Worker (turbodiff.dev in the
   hosted deployment) and update the GitHub App's webhook + callback URLs to match.

## Develop

```sh
npm run dev
```

The landing page is at `/` (settings once signed in). To exercise webhooks locally, either
use a tunnel (`cloudflared tunnel`, `smee.io`) pointed at `/webhooks/github`, or send
signed test payloads by hand (HMAC-SHA256 of the body with your webhook secret in
`x-hub-signature-256: sha256=<hex>`).

> `package.json` pins npm via `devEngines` (npm ≥ 12). If your npm refuses to run scripts,
> call the binaries directly: `./node_modules/.bin/vite dev`, `./node_modules/.bin/tsc --noEmit`.

## Deploy

```sh
npm run deploy
```

## Use it

1. Visit [turbodiff.dev](https://turbodiff.dev) (or your own deployment) and install the
   GitHub App on an organization or account, selecting the repositories to review.
2. Open a pull request (or mark a draft as ready) — Turbodiff reviews it automatically.
   Auto-reviews are capped per installation per day (`REVIEW_DAILY_LIMIT`).
3. Sign in to toggle reviews per repository, and watch in-flight reviews live on
   [`/reviews`](https://turbodiff.dev/reviews) — each shows as reviewing, done (with a
   link to the posted review), or stalled.

Need a manual (re-)review — e.g. after new pushes? The operator endpoint works for any
installed repo:

```sh
curl -X POST https://turbodiff.dev/review \
  -H "Authorization: Bearer $REVIEW_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"pr_url": "https://github.com/OWNER/REPO/pull/123"}'
```

Inspect a PR's conversation at `GET /agents/pr-reviewer/owner--repo--123` (same auth header).

## External tools (MCP)

Any agent can mount remote [MCP](https://modelcontextprotocol.io) servers as extra review
tools — a dependency database, an internal policy service, whatever your reviews need.
On an agent's edit page, add a connection: a server name, its MCP endpoint URL, an
optional bearer token (encrypted at rest with `TOKEN_ENCRYPTION_KEY`, write-only in the
UI), and an optional tool allowlist. The **Test** button performs the MCP handshake and
lists the tools the agent would see, without mounting anything.

The featured path is [Executor](https://executor.sh): configure your integrations (MCP
servers, OpenAPI, GraphQL) with per-tool policies in Executor's catalog, then hand
Turbodiff the single hosted MCP endpoint + token it gives you. Secrets for the underlying
services stay in Executor; rotating or re-scoping tools never touches Turbodiff.

Two things to know before connecting a server: the agent sends it PR context (that's data
egress to wherever the URL points — connect only servers you trust), and everything the
server returns is treated as untrusted content, same as the PR itself. Connections are
`optional` — if a server is down, the review runs without it and notes the gap.

## Learn more

- [Flue docs](https://flueframework.com/docs/) — or `npx flue docs` from the terminal.
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [GitHub Apps](https://docs.github.com/en/apps)

## License

Turbodiff is licensed under the [Functional Source License, Version 1.1, ALv2 Future
License](LICENSE.md) (FSL-1.1-ALv2). In short: you may use, modify, and self-host it
freely — including inside your company — but you may not offer it (or a substantially
similar service) commercially in competition with Turbodiff. Each release automatically
becomes available under the Apache License 2.0 two years after publication. See
[fsl.software](https://fsl.software) for the license's background.

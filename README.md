# Turbodiff

<img src="public/logo-small.png" alt="Turbodiff logo" width="64" align="right" />

Open-source AI code review — growing into a software factory. Turbodiff is a
GitHub App hosted end-to-end on Cloudflare (Workers, Durable Objects, D1,
Queues, Containers, R2) and built with [Flue](https://flueframework.com).

Install it and every new pull request gets an automatic review: a short summary
plus inline comments on the exact lines each finding concerns. Beyond review,
the factory pipeline takes a feature from free-form requirements to a verified
pull request: an agent plans it against your actual code (asking clarifying
questions where the requirements are ambiguous), you approve the plan, agents
generate the code, review it, fix blocking findings automatically, and verify
the result empirically — launching the app in a sandbox and posting screenshot
evidence for every acceptance criterion to the PR.

**Live at [turbodiff.dev](https://turbodiff.dev)** — or self-host on your own
Cloudflare account ([One-time setup](#one-time-setup)).

> [!WARNING]
> **Turbodiff is under heavy development.** Expect rough edges, bugs, and
> breaking changes between releases. If something misbehaves, please
> [open an issue](https://github.com/Ngineer101/turbodiff/issues) — and
> contributions are very welcome: pull requests, bug reports, and ideas all
> help. If you want to work on something bigger, open an issue first so we can
> align on the approach.

## What's inside

**Review** (the original product):

- One durable agent instance per PR (`owner--repo--number`), so re-reviews
  continue the same conversation and reconcile against earlier findings.
- Risk tiering sizes the effort: trivial changes get one generalist agent,
  large or sensitive changes the full agent fleet.
- Optional blocking mode: a P1 finding posts `REQUEST_CHANGES`, a clean review
  approves.
- Custom review agents (personas) per installation, with optional remote
  [MCP](https://modelcontextprotocol.io) tool connections (bearer tokens
  encrypted at rest; servers are treated as untrusted, like the PR itself).

**Factory** (in active development — see
[docs/software-factory-design.md](docs/software-factory-design.md)):

- **Plan** — an agent clones the repo read-only, analyzes your requirements
  against the real code, asks clarifying questions, and produces a file-level
  plan plus machine-checkable acceptance criteria for you to approve.
- **Generate** — an agent implements the approved plan in a sandbox, a
  per-repo check command gates the push, and a PR opens.
- **Auto-fix** — a blocking review dispatches a fix agent (max 3 attempts per
  PR, then a human-handoff comment).
- **Verify** — every acceptance criterion is checked empirically against the
  branch: static criteria by reading the tree, runtime criteria by launching
  the app in the sandbox, visual criteria by driving headless Chrome. The PR
  gets a report comment with a verdict table and inline screenshots; unmet
  criteria feed the auto-fix loop.

Agent runs execute inside Cloudflare Containers (the sandbox) and can spend
either your existing Claude subscription (`claude setup-token`) or API credits
through your AI Gateway.

## Code map

- [src/agents/pr-reviewer.ts](src/agents/pr-reviewer.ts) — the review agent.
- [src/tools/github.ts](src/tools/github.ts) — its tools (`fetch_pr`,
  `fetch_file`, `fetch_review_threads`, `post_review`).
- [src/lib/planner.ts](src/lib/planner.ts) /
  [generator.ts](src/lib/generator.ts) / [fixer.ts](src/lib/fixer.ts) /
  [verifier.ts](src/lib/verifier.ts) — the factory pipeline stages, each a
  sandboxed agent run.
- [src/cloudflare.ts](src/cloudflare.ts) — the factory queue consumer and the
  sandbox container export.
- [src/routes/webhooks.ts](src/routes/webhooks.ts) — GitHub App webhooks:
  installation sync, review auto-dispatch, auto-fix trigger.
- [src/routes/settings.ts](src/routes/settings.ts) — the signed-in UI:
  dashboard, factory (submit/answer/approve), reviews, agents, per-repo
  settings.
- [src/app.ts](src/app.ts) — routing, operator endpoints (`/review`,
  `/internal/*`), and the public artifact route for verification screenshots.
- [migrations/](migrations/) — D1 schema: installations, repositories, reviews,
  agents, fix attempts, features, plans, verifications.

## One-time setup

Everything runs on a single Cloudflare account. To self-host, create your own
GitHub App and deploy:

1. **Dependencies** (peer-dep conflict upstream requires the flag):

   ```sh
   npm install --legacy-peer-deps
   ```

2. **AI Gateway** — set `AI_GATEWAY_ID` in [wrangler.jsonc](wrangler.jsonc) to
   your gateway's name. It must serve Anthropic models (BYOK or unified
   billing).

3. **D1** — create a `turbodiff` database, put its id in
   [wrangler.jsonc](wrangler.jsonc), and apply the schema:

   ```sh
   npx wrangler d1 migrations apply turbodiff --local    # dev
   npx wrangler d1 migrations apply turbodiff --remote   # production
   ```

4. **Queue and R2 bucket** (factory pipeline):

   ```sh
   npx wrangler queues create turbodiff-factory
   npx wrangler r2 bucket create turbodiff-artifacts
   ```

5. **GitHub App** — create one at <https://github.com/settings/apps>:
   - **Webhook URL**: `https://<your-worker>/webhooks/github`, with a secret
     (`openssl rand -hex 32`).
   - **Repository permissions**: Contents (read & write — the fix and
     generation agents push branches), Pull requests (read & write), Issues
     (read & write, for comment reactions and factory reports).
   - **Subscribe to events**: Pull request, Pull request review, Issue comment,
     Repository.
   - **Callback URL**: `https://<your-worker>/auth/callback`; note the OAuth
     client id and generate a client secret.
   - Generate a **private key** and convert it to PKCS#8 (WebCrypto can't read
     GitHub's PKCS#1 file):

     ```sh
     openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem
     ```

   - Set `GITHUB_APP_SLUG` in [wrangler.jsonc](wrangler.jsonc).

6. **Secrets** — locally in `.dev.vars`; in production:

   ```sh
   npx wrangler secret put GITHUB_APP_ID
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # the PKCS#8 PEM, whole file
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
   npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET           # openssl rand -hex 32
   npx wrangler secret put REVIEW_SECRET            # openssl rand -hex 32 (operator endpoints)
   # Factory agent runs — set at least one:
   npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN  # from `claude setup-token` (Claude subscription)
   npx wrangler secret put FIXER_ANTHROPIC_API_KEY  # gateway mode, with FIXER_ANTHROPIC_BASE_URL var
   # Only if agents use authenticated external MCP connections:
   npx wrangler secret put TOKEN_ENCRYPTION_KEY     # openssl rand -hex 32
   ```

7. **Custom domain** (optional) — add it to the Worker, set `PUBLIC_BASE_URL`
   in [wrangler.jsonc](wrangler.jsonc), and update the GitHub App's webhook +
   callback URLs.

## Develop

Local dev needs **Docker running** (the sandbox container image builds on
first start).

```sh
npm run dev
```

To exercise webhooks locally, use a tunnel (`cloudflared tunnel`, `smee.io`)
pointed at `/webhooks/github`, or send signed test payloads (HMAC-SHA256 of the
body in `x-hub-signature-256: sha256=<hex>`).

> `package.json` pins npm via `devEngines`. If your npm refuses to run scripts,
> call the binaries directly: `./node_modules/.bin/vite dev`,
> `./node_modules/.bin/tsc --noEmit`.

## Deploy

```sh
npm run deploy
```

This builds the Worker and the sandbox container image (Docker required) and
pushes both.

## Use it

1. Install the GitHub App, selecting the repositories to review.
2. Open a pull request — Turbodiff reviews it automatically (capped per
   installation per day via `REVIEW_DAILY_LIMIT`).
3. Sign in to configure repositories on `/settings` — per-repo toggles for
   re-review on push, blocking reviews, auto-fix, and the sandbox check
   command — and watch reviews on `/reviews`.
4. Plan and build features on `/factory`: submit requirements, answer the
   planning agent's questions, approve the plan, and follow the generated PR
   through review and verification.

Operator endpoints (Bearer `REVIEW_SECRET`) mirror the UI for automation:
`POST /review` (manual re-review), `POST /internal/generate`,
`POST /internal/plans` + `/answers` + `/approve`, `POST /internal/fix`, and
`GET /internal/pr-reviewer/<owner--repo--number>` to inspect a review agent's
conversation.

## License

Turbodiff is licensed under the [Functional Source License, Version 1.1, ALv2
Future License](LICENSE.md) (FSL-1.1-ALv2): use, modify, and self-host freely —
including inside your company — but don't offer it (or a substantially similar
service) commercially in competition with Turbodiff. Each release becomes
Apache 2.0 two years after publication. See [fsl.software](https://fsl.software).

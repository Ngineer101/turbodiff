# turbodiff

A PR review agent built with [Flue](https://flueframework.com), hosted on Cloudflare Workers.
Install the Turbodiff GitHub App on your organization, pick the repositories to watch, and
every new pull request gets an automatic AI review — a short summary plus inline comments on
the exact lines each finding concerns.

```
GitHub webhook (PR opened) ──▶ Worker ──▶ PrReviewer agent (Durable Object, one per PR)
        │                        │            │  fetch_pr / fetch_file (GitHub API,
Settings UI (sign in, toggle     │            │    per-installation App tokens)
repos)          ──▶ D1 config ◀──┘            │  model calls via env.AI ─▶ AI Gateway ─▶ Claude
                                              └─ post_review ──▶ summary + inline PR comments
```

## How it works

- [src/agents/pr-reviewer.ts](src/agents/pr-reviewer.ts) — the agent: model choice
  (`cloudflare/anthropic/claude-sonnet-5` through your gateway) and review instructions.
- [src/tools/github.ts](src/tools/github.ts) — its tools: `fetch_pr` (metadata + diff),
  `fetch_file` (extra context), `post_review` (summary body + inline comments anchored to
  diff lines, falling back to body-only if an anchor is rejected). All GitHub calls
  authenticate as the App installation that owns the repo (looked up in D1).
- [src/routes/webhooks.ts](src/routes/webhooks.ts) — GitHub App webhooks: syncs
  installations/repositories into D1 and auto-dispatches reviews on `pull_request`
  `opened` / `ready_for_review` (drafts skipped, per-installation daily cap).
- [src/routes/settings.ts](src/routes/settings.ts) — minimal settings UI: sign in with
  GitHub, see your installations, enable/disable reviews per repository.
- [src/lib/github-app.ts](src/lib/github-app.ts) — App JWTs, installation tokens, webhook
  signature verification, OAuth.
- [src/app.ts](src/app.ts) — routing and the manual `POST /review` trigger.
- [migrations/](migrations/) — D1 schema: `installations`, `repositories`, `reviews`.

Each PR gets its own durable agent instance (`owner--repo--number`), so a re-review of the
same PR continues the same conversation.

## One-time setup

1. **Dependencies** (peer-dep conflict upstream in `agents`/`ai` requires the flag):

   ```sh
   npm install --legacy-peer-deps
   ```

2. **AI Gateway** — in [wrangler.jsonc](wrangler.jsonc), set `AI_GATEWAY_ID` to your existing
   gateway's name. The gateway must be able to serve Anthropic models: either store your
   Anthropic key in the gateway (BYOK) or enable Cloudflare's unified billing for it.

3. **D1** — the database id in [wrangler.jsonc](wrangler.jsonc) points at the `turbodiff` D1
   database. Apply the schema:

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
   ```

## Develop

```sh
npm run dev
```

The settings UI is at `/`. To exercise webhooks locally, either use a tunnel
(`cloudflared tunnel`, `smee.io`) pointed at `/webhooks/github`, or send signed test
payloads by hand (HMAC-SHA256 of the body with your webhook secret in
`x-hub-signature-256: sha256=<hex>`).

## Deploy

```sh
npm run deploy
```

## Use it

1. Visit your Worker's URL and install the GitHub App on an organization or account,
   selecting the repositories to review.
2. Open a pull request (or mark a draft as ready) — Turbodiff reviews it automatically.
   Auto-reviews are capped per installation per day (`REVIEW_DAILY_LIMIT`).
3. Sign in on the settings page to toggle reviews per repository.

Need a manual (re-)review — e.g. after new pushes? The operator endpoint still works for any
installed repo:

```sh
curl -X POST https://<your-worker>/review \
  -H "Authorization: Bearer $REVIEW_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"pr_url": "https://github.com/OWNER/REPO/pull/123"}'
```

Inspect a PR's conversation at `GET /agents/pr-reviewer/owner--repo--123` (same auth header).

## Learn more

- [Flue docs](https://flueframework.com/docs/) — or `npx flue docs` from the terminal.
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [GitHub Apps](https://docs.github.com/en/apps)

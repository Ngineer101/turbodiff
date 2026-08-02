# turbodiff

A PR review agent built with [Flue](https://flueframework.com), hosted on Cloudflare Workers.
Any repository can request a review with one HTTP call (usually from a tiny GitHub Action);
Turbodiff fetches the diff, reviews it with Claude via your Cloudflare AI Gateway, and posts
the review back to the pull request.

```
GitHub Action ──POST /review──▶ Worker ──▶ PrReviewer agent (Durable Object, one per PR)
                                              │  fetch_pr / fetch_file (GitHub API)
                                              │  model calls via env.AI ──▶ AI Gateway ──▶ Claude
                                              └─ post_review ──▶ PR review comment
```

## How it works

- [src/agents/pr-reviewer.ts](src/agents/pr-reviewer.ts) — the agent: model choice
  (`cloudflare/anthropic/claude-sonnet-5` through your gateway) and review instructions.
- [src/tools/github.ts](src/tools/github.ts) — its tools: `fetch_pr` (metadata + diff),
  `fetch_file` (extra context), `post_review` (posts one review comment).
- [src/app.ts](src/app.ts) — routing: gateway provider registration, Bearer-secret auth,
  and `POST /review` which maps a PR URL to a stable per-PR agent instance.

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

3. **Secrets** — locally, fill in [.dev.vars](.dev.vars); in production:

   ```sh
   npx wrangler secret put GITHUB_TOKEN     # repo read + PR write on repos you review
   npx wrangler secret put REVIEW_SECRET    # e.g. openssl rand -hex 32
   ```

   A fine-grained PAT needs Repository permissions: Contents (read) and Pull requests (read & write).

## Develop

```sh
npm run dev
```

Then request a review of any PR the token can see:

```sh
curl -X POST http://localhost:5173/review \
  -H "Authorization: Bearer $REVIEW_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"pr_url": "https://github.com/OWNER/REPO/pull/123"}'
```

Inspect the conversation at `GET /agents/pr-reviewer/owner--repo--123` (same auth header).

## Deploy

```sh
npm run deploy
```

## Hook up a repository

Copy [examples/turbodiff-review.yml](examples/turbodiff-review.yml) into the repo as
`.github/workflows/turbodiff-review.yml`, point `TURBODIFF_URL` at your deployed Worker,
and add a `TURBODIFF_SECRET` Actions secret matching `REVIEW_SECRET`. That's it — the same
Worker serves as many repositories as you like. No workflow? Anything that can `curl` can
trigger a review.

## Learn more

- [Flue docs](https://flueframework.com/docs/) — or `npx flue docs` from the terminal.
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)

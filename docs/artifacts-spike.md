# Cloudflare Artifacts spike (Phase 0)

Throwaway probe validating that Cloudflare Artifacts (closed beta) can carry
the factory's git provider loop before we invest in the provider abstraction:
create repo → mint scoped tokens → clone/commit/push from the sandbox
container → receive push events. **Read `docs/artifacts-vision.md` first** —
it explains the end state these primitives build toward (turbodiff as its own
forge, GitHub as import-only) and maps each spike step to a leg of that loop.
This doc is the runbook for the spike itself.

## What's in the spike

- `wrangler.jsonc` — `GIT_ARTIFACTS` binding (namespace `turbodiff-spike`).
  Named `GIT_ARTIFACTS` because `ARTIFACTS` is the R2 evidence bucket.
- `src/ai/runners/artifacts-spike.ts` — the E2E probe (binding + sandbox git).
- `src/http/artifacts-spike.ts` — operator routes under
  `/internal/artifacts-spike` (shared-secret auth like the rest of /internal).
- `src/shared/artifacts-events.ts` + `src/services/artifacts-events.ts` +
  the `cloudflare.ts` consumer hook — event-subscription messages ride the
  factory queue (a second consumer hangs the local dev plugin) and are
  captured raw to R2 under `artifacts-spike/events/` (no D1 migration for a
  throwaway; objects are private — no capability signature is issued for
  this prefix).

## One-time setup

1. Artifacts beta must be enabled on the account the Worker deploys to
   (the binding fails to provision otherwise).
2. Event subscriptions deliver to the existing `turbodiff-factory` queue.
   Account-level repo lifecycle events:

   ```sh
   npx wrangler queues subscription create turbodiff-factory \
     --source artifacts --events repo.created,repo.deleted
   ```

   Repo-level push events are per repo (source `artifacts.repo` with a
   namespace + repo name — flag names TBC against
   `wrangler queues subscription create --help`; the docs don't show a
   namespace-wide wildcard). For the spike, create one after a repo exists:

   ```sh
   npx wrangler queues subscription create turbodiff-factory \
     --source artifacts.repo --namespace turbodiff-spike --repo <name> \
     --events pushed
   ```

## Runbook

```sh
BASE=https://turbodiff.dev
AUTH="Authorization: Bearer $REVIEW_SECRET"

# Full E2E probe (~1 min; first run pays the container boot).
curl -sX POST "$BASE/internal/artifacts-spike/run" -H "$AUTH" | jq

# Captured event-subscription messages (allow ~1 min after a push).
curl -s "$BASE/internal/artifacts-spike/events" -H "$AUTH" | jq

# Inventory / cleanup.
curl -s "$BASE/internal/artifacts-spike/repos" -H "$AUTH" | jq
curl -sX DELETE "$BASE/internal/artifacts-spike/repos/<name>" -H "$AUTH" | jq
```

`POST /run` reports per-step timings and proves, in order: create repo
(binding), mint write token (ttl 900s), `git init` + commit + push from the
sandbox, mint read token, clone + head verification, a second (non-initial)
push, token listing, token revocation, and that a revoked token is rejected.
`ok: true` at the top level means every step passed.

## What Phase 0 must answer

- Does the binding provision and behave on this account (closed beta)?
- Does sandbox git speak the Artifacts remote cleanly? (Push is protocol v1
  only — irrelevant for the git CLI, which always pushes over v0/v1, but
  worth confirming; matters later for isomorphic-git.)
- Do `pushed` events arrive on the queue, with usable payloads (ref, before/
  after, commits) to drive review-on-push?
- Are repo-level event subscriptions manageable per repo (they would become
  part of repo provisioning in Phase 2), or is there a namespace-wide option?
- Token ergonomics: TTL bounds (types say 60s–1y, default 24h), revocation
  latency, and whether `create()`'s initial token makes a separate mint
  redundant.

## Findings feeding later phases

- The binding has `import()` (public HTTPS remotes) and `fork()` — a
  GitHub → Artifacts migration path is nearly free, and fork could back
  cheap per-feature workspaces.
- The workerd types pinned here (`wrangler types`, 2026-06-01) expose **no
  content-read methods** (`log`/`readCommit`/`readTree` appear in newer docs
  but not in these types), and the REST API has no diff endpoint — so the
  native change-request layer's diff mechanism is sandbox git vs
  isomorphic-git in the Worker. That comparison is the follow-up spike.
- Naming: `owner/name` in D1 maps to Artifacts `namespace/repo`; the spike
  uses one namespace (`turbodiff-spike`) — production wants a namespace per
  org.

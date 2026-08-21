# Git provider seam + Artifacts-hosted projects (Phase 1)

Production groundwork for turbodiff as its own forge (`docs/artifacts-vision.md`):
repos can now live on Cloudflare Artifacts in turbodiff's account instead of
GitHub, with the whole runtime reaching them through one provider seam. The
Phase-0/0.5 spikes that de-risked this live on the (unmerged) `artifacts-phase0-spike`
branch; everything here is production code.

## What ships in Phase 1

- **Provider seam** — `src/integrations/git/remotes.ts` (pure remote shapes)
  and `provider.ts` (credential minting + dispatch). Every sandbox git
  operation goes through a `WorkspaceRemote`; no call site builds a forge URL
  anymore. GitHub's command shapes are byte-identical to before.
- **Synthetic tenancy** — Artifacts projects reuse the installation-scoped
  access model via installation/repository rows in the **negative id range**
  (GitHub ids are positive, so the spaces cannot collide). Migration
  `0035_git_providers.sql`; allocation in `src/data/repositories.ts`.
- **Provisioning** — `POST /internal/projects {owner, name, description?}`
  creates the Artifacts repo (collision-suffixed name `owner--name`), seeds an
  initial commit from the sandbox, and records the D1 rows. Compensating
  deletes on failure; no row ever points at a broken remote.
- **Clone credentials** — `POST /internal/repos/clone-token {repo, scope?, ttl_seconds?}`
  mints a repo-scoped token so a user clones/pushes with plain git:
  `git clone` the returned `remote` with header `Authorization: Bearer <token>`
  (or a credential helper). This is the deploy-key replacement.
- **Event ingestion** — declarative `triggers.events` entries in
  `wrangler.jsonc` start one `ArtifactsEventsWorkflow` instance per
  `repo.pushed` / `repo.deleted` event in the namespace. No per-repo
  subscription provisioning, no API tokens; a repo created tomorrow is
  covered by today's config. Pushes stamp `repositories.last_push_at`;
  deletes drop the stale row.
- **Capability gating** — every factory intake that ends in a GitHub PR
  (features, plans, automations, fix runs) rejects Artifacts repos with an
  explicit "needs the native change-request layer (Phase 2)" error instead of
  stranding a run at the PR step. GitHub repos are untouched.

## Design decisions

- **Auth mechanics differ per provider and that's fine.** GitHub keeps
  `https://x-access-token:$GIT_TOKEN@github.com/...` (token via env);
  Artifacts uses `-c http.extraHeader="Authorization: Bearer $GIT_TOKEN"`
  because its tokens can carry `?expires=` — URL-hostile. Both shapes live in
  `remotes.ts` only.
- **Negative synthetic ids over a schema rewrite.** `installation_id` drives
  scoping, budgets, and org mapping across dozens of query sites. Synthetic
  rows preserve every invariant with zero query changes; `mintToken` and
  `syncInstallationRepos` hard-guard against a negative id ever reaching
  GitHub.
- **PR-head flows stay GitHub-constructed.** Fix and conflict-resolution
  operate on a PR's head repo (possibly a fork), so they build a GitHub
  remote for that slug directly rather than resolving from the repo row.

## Operational setup (one-time)

1. Artifacts closed beta enabled on the account (the `GIT_ARTIFACTS` binding
   fails to provision otherwise).
2. Namespace `turbodiff-repos` — must match `ARTIFACTS_NAMESPACE` in
   `src/integrations/git/remotes.ts` and the `triggers.events` filters.
3. Migrations + deploy ride the normal CI path (migrations applied before
   deploy, `wrangler deploy --dry-run` validates the new config in PR CI).

Smoke test after deploy:

```sh
AUTH="Authorization: Bearer $REVIEW_SECRET"
curl -sX POST https://turbodiff.dev/internal/projects -H "$AUTH" \
  -d '{"owner": "nico", "name": "hello-artifacts", "description": "first hosted project"}' | jq
curl -sX POST https://turbodiff.dev/internal/repos/clone-token -H "$AUTH" \
  -d '{"repo": "nico/hello-artifacts", "scope": "read"}' | jq
# then: git -c http.extraHeader="Authorization: Bearer <token>" clone <remote>
# push something; ~a minute later the repo row's last_push_at is stamped.
```

## What Phase 2 builds on this

Native change requests: CR tables in D1, diff compute/cache via the sandbox
engine prototyped in Phase 0.5, cockpit CR view (the app already ships
`@pierre/diffs`), reviews/checks/merges — at which point the
`factoryUnsupportedReason` gates lift one flow at a time. Multi-installation
organizations (a GitHub org that _also_ hosts Artifacts projects under the
same cockpit org) are deferred with them.

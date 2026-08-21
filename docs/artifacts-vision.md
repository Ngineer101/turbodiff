# Artifacts as a GitHub alternative — the end state

The Phase 0 spike (`docs/artifacts-spike.md`) proves plumbing. This doc is the
reason the plumbing matters: what turbodiff looks like when a project never
touches GitHub, and how each spike primitive becomes a leg of that product.

## The litmus test

A user creates a project in turbodiff. No GitHub account, no App install, no
Cloudflare account. The factory generates features, opens change requests,
reviews them, merges them, and issues build certificates — and the user can
`git clone` their repo with a turbodiff-issued token at any point. If we
deleted the GitHub App tomorrow, this project would not notice.

That is the end state. GitHub becomes one of two providers — the
import-your-existing-repo path — instead of the substrate everything stands on.

## The honest split: what Artifacts gives us vs what we build

Artifacts (closed beta) is a git remote with an API. It provides:

- repos under namespaces, created from a Worker binding (`create`, `fork`,
  `import`)
- git smart-HTTP for clone/push
- repo-scoped, short-TTL tokens (mint, list, revoke)
- push/lifecycle events delivered to a Queue

It has **no** pull requests, no reviews, no merge API, no diff endpoint, no
CI, no statuses. Everything users associate with "GitHub" above the git layer
does not exist.

That gap is not a problem — it is the product. turbodiff already owns the
agents, the review policy, the cockpit, and the sandbox with a full git CLI in
it. We build the forge layer natively, shaped for a factory rather than for
humans-emulating-a-factory:

| GitHub concept    | Native replacement                                          |
| ----------------- | ----------------------------------------------------------- |
| Pull request      | Change request: D1 row (repo, source/target branch, status) |
| PR diff           | Sandbox `git diff target...source`, cached in R2            |
| Review comments   | D1 rows anchored to file+line, same shape as cockpit today  |
| Merge button      | Sandbox `git merge` + push, driven by `auto-merge.ts` logic |
| Conflict badge    | Sandbox `git merge --no-commit` dry-run                     |
| Webhooks          | Queue event subscriptions (already on the factory queue)    |
| CI checks         | turbodiff's own checks in the sandbox, statuses in D1       |
| Deploy keys / PAT | Repo-scoped Artifacts tokens minted per job and per user    |

## The loop, end to end

1. **Create project** → `GIT_ARTIFACTS.create('org-slug/repo')`, namespace
   per org. The spike's create step is this, minus the D1 bookkeeping.
2. **Agent works** → sandbox clones with a short-TTL write token (spike:
   mint → push → revoke), commits to `turbodiff/feat-N`, pushes.
3. **Push event** arrives on the factory queue (spike: event capture) →
   opens or refreshes the change request row, computes the diff in the
   sandbox, caches it to R2.
4. **Review** → Flue reviews the cached diff natively — no
   `github-webhooks.ts` hop — comments stored like `cockpit_comments`,
   verdict via the existing `review-policy.ts`.
5. **Checks** → the sandbox runs the project's build/tests; results are
   status rows on the CR. This is _better_ than the GitHub path, where CI
   findings were a capability we consumed rather than owned.
6. **Merge** → dry-run conflict check, then merge + push from the sandbox
   (`merge-conflicts.ts` and `auto-merge.ts` logic pointed at a new
   transport). Certificate issued as today.
7. **User access** → the cockpit offers "clone this repo": a user-scoped
   read (or write) token minted on demand — the same primitive the spike
   revokes in its last step.

Every step above is either already proven by the spike (1, 2, 3-ingest, 7)
or is existing turbodiff logic re-pointed at a `GitProvider` interface
(4, 5, 6). Nothing in the loop requires a capability Artifacts lacks.

## Why this beats wrapping GitHub

- **The factory owns its forge.** Review policy, merge rules, and checks are
  turbodiff decisions executed directly, not encoded as webhook reactions to
  a third-party state machine we don't control.
- **Zero-friction onboarding.** Repos live in turbodiff's account
  (turbodiff-hosted tenancy, decided 2026-08-20); users bring nothing.
- **Migration is nearly free both ways.** `import()` pulls any public HTTPS
  remote in; the repo is standard git, so users can push it back to GitHub
  whenever they want. No lock-in story to defend.
- **`fork()` enables cheap per-feature workspaces** — an isolation primitive
  GitHub-based flow never had.

## Build-out order

- **Phase 0 / 0.5 (spikes, unmerged `artifacts-phase0-spike` branch)**:
  binding, tokens, sandbox git, events — proven; plus the working CR
  prototype (native change requests, sandbox-git diffs, dry-run
  mergeability, inline comments, merge with conflict ripple). Reference
  implementations, deliberately never merged.
- **Phase 1 (this PR)**: the provider seam (`src/integrations/git/`),
  synthetic tenancy in D1, Artifacts project provisioning + clone tokens,
  declarative push/delete event ingestion, and capability gates on every
  PR-bound factory intake — `docs/artifacts-provider.md`.
- **Phases 2-3 (this PR)**: the native CR layer in production — D1 records,
  the sandbox diff/merge engine, native reviews/checks/verification/merges,
  the cockpit rendering CRs through the existing diff surface, and a
  create-project UI. Remaining GitHub-only flows: automations, the PR fix
  loop, and GitHub import (`import()`) as the migration path.

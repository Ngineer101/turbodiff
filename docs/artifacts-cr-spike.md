# Native change requests on Artifacts (Phase 0.5 prototype)

Phase 0 (`docs/artifacts-spike.md`) proved the plumbing. This is the
prototype of the product: the forge layer GitHub normally provides — change
requests, diffs, review comments, mergeability, the merge button — running
natively over a bare Artifacts remote. The end-state argument lives in
`docs/artifacts-vision.md`; this is that argument as working code.

Everything a GitHub PR does here is computed by turbodiff itself:

- **CR records** — JSON in R2 under `artifacts-spike/crs/` (throwaway stand-in
  for the production D1 rows; private prefix, no capability signatures).
- **Diff** — sandbox git: merge-base + `diff --numstat/--name-status` + the
  unified patch, per-step timings recorded. Those timings are the spike's
  primary data: they decide sandbox-git-per-refresh vs isomorphic-git.
- **Mergeability** — a real `git merge --no-commit` dry-run, not a heuristic.
- **Merge** — `git merge --no-ff` + push with a write token, then every
  sibling open CR is recomputed (the "target moved" ripple).
- **Review** — comments anchored to file+line, rendered inline in the diff.
- **Webhook replacement** — a `cf.artifacts.repo.pushed` event on the factory
  queue recomputes any CR whose source or target branch moved.

## Runbook — the whole story in five calls

```sh
BASE=https://turbodiff.dev
AUTH="Authorization: Bearer $REVIEW_SECRET"
CR=$BASE/internal/artifacts-cr

# 1. Build the demo: a pricing service repo on Artifacts (never touches
#    GitHub) with two feature branches that BOTH merge cleanly against main
#    but edit the same lines of src/pricing.ts. Opens a CR for each.
#    (~1-2 min; first run pays the container boot.)
curl -sX POST "$CR/demo" -H "$AUTH" | jq

# 2. Look at a CR the way a reviewer would — rendered diff, stats, lamps.
curl -s "$CR/crs/<id>/view" -H "$AUTH" > /tmp/cr.html && open /tmp/cr.html

# 3. Leave a review comment anchored in the diff (re-fetch the view to see it).
curl -sX POST "$CR/crs/<id>/comments" -H "$AUTH" \
  -d '{"file": "src/pricing.ts", "line": 7, "body": "annualUsd should come from billing config"}' | jq

# 4. Merge CR 1. The response includes `rippled`: CR 2, clean a second ago,
#    is recomputed against the moved main and flips to mergeable: false with
#    src/pricing.ts listed in conflict_files. This is the moment the
#    prototype exists for — PR mechanics with no forge underneath.
curl -sX POST "$CR/crs/<id1>/merge" -H "$AUTH" | jq

# 5. Try to merge CR 2 anyway: rejected with git's own conflict output.
curl -sX POST "$CR/crs/<id2>/merge" -H "$AUTH" | jq
```

Supporting calls: `GET /crs[?repo=]` (list), `GET /crs/:id` (full record incl.
patch + engine timings), `POST /crs/:id/refresh` (manual recompute), `POST
/crs {repo, source, target, title}` (open a CR on any Artifacts repo, not
just demo ones). Demo repos are ordinary spike repos — delete via the Phase-0
route (`DELETE /internal/artifacts-spike/repos/:name`).

## Event-driven refresh (optional but the point)

With a per-repo push subscription in place (Phase-0 doc, `--source
artifacts.repo`), any push to a CR's source branch recomputes it — no manual
refresh. To see it: push a new commit to `turbodiff/feat-2-enterprise-tier`
with a spike token, wait ~1 min, re-fetch the CR. Without subscriptions the
manual `/refresh` route covers the same path. The queue hook parses the beta
payload tolerantly and logs a warning when the shape doesn't match — that
warning is itself a spike finding (record the real shape in this doc).

## What this must answer

- **Latency of forge-less diffs.** Every CR carries `timings`: token mint,
  clone-vs-fetch (cold/warm is in the detail), merge-base + diff, dry-run.
  If a warm refresh lands in low seconds, sandbox git carries the production
  CR layer and isomorphic-git stays unnecessary; if it's tens of seconds, the
  isomorphic-git comparison spike gets priority.
- **Correctness of the mergeability signal.** The demo's engineered conflict
  must show clean → merged → sibling conflicted, with the right file named.
- **Does the review surface hold up** — is a rendered diff + anchored
  comments over R2 records enough for Flue to review against (Phase 3), or
  does the patch need structure (per-hunk records) sooner?

## Known prototype shortcuts

Deliberate, all noted for the Phase 1/2 build: CR records in R2 instead of
D1 (no migration for a throwaway); no locking on the shared per-repo
workspace (concurrent refreshes of the same repo could interleave); queue
consumer recomputes inline instead of enqueueing; patch capped at 256 KB;
sequence-free CR ids (`cr-<hex8>`) instead of per-repo numbers.

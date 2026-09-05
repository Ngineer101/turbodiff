# The Explain tab

The cockpit review workspace has two tabs over one change: **Diff**, the raw
patches with line comments, and **Explain**, a short visual explanation of
what the change does. Explain exists so a reviewer understands the change
before judging it. It is not a review: no verdicts, no findings.

The format is humanlayer's [show-me](https://github.com/humanlayer/skills)
skill applied to a diff: skip the preamble, one plain sentence per block,
then the smallest code-shape sketch that makes the point.

## The document

`src/domain/explain.ts` owns the contract; `src/shared/api-types.ts` carries
the wire types. A document is an ordered list of blocks:

| kind             | sketch                                                    |
| ---------------- | --------------------------------------------------------- |
| `summary`        | two or three sentences: before, after, why it matters     |
| `call_tree`      | indented call tree, optionally diff-marked (`+`/`-`)      |
| `pseudocode`     | a rule, formula, schedule, or state machine               |
| `component_tree` | UI structure, only what the change touches                |
| `file_tree`      | shallow tree with a `# responsibility` per file           |
| `sequence`       | participants + messages, drawn as an SVG lifeline diagram |

The summary comes first and exactly once. Every other block carries **refs**:
a changed file and, where the sketch maps to a hunk, new-file line numbers.
The cockpit renders each ref as a jump link that switches to the Diff tab and
scrolls to that file. Refs to files outside the diff are rejected at submit
time, so a stored document always points somewhere real.

## How one is written

- **On demand, cached per head.** The first open of the Explain tab for a
  change head with no row requests one; later opens hit the cache. A push
  moves the head, so the tab shows the earlier document marked stale until
  someone opens the tab again (which requests the rewrite) or clicks
  Regenerate. Nothing runs for pull requests nobody opens.
- **One bounded model call.** `Explainer` (`src/ai/agents/explainer.ts`) is a
  Flue agent on the same AI Gateway path as the reviewers. It receives the
  diff in the dispatch body — the same file list and patches the Diff tab
  renders (`src/services/feature-diff.ts`) — and answers only through the
  `submit_explanation` tool. It never fetches.
- **One row per run.** `app.feature_explanations` keys rows by feature and
  head; a partial unique index allows one running row per feature. Usage is
  metered onto the row by instance id (`src/ai/explain/metering.ts`); a run
  that settles without submitting is marked failed by the same observer.

## Routes

- `GET /api/factory/features/:id/explain?v=<head>` — the row for that head
  (`none` | `running` | `ready` | `failed`), plus `previous`: the newest
  finished document for an earlier head, when the current one is not ready.
- `POST /api/factory/features/:id/explain` `{ v, force? }` — admit a run.
  Idempotent unless `force`; 409 while another run is in flight.

## Not yet

- Explanation cost is stored on the row but not yet rolled into the usage
  page's per-stage totals.
- Jump refs land on the file, not the exact line range.
- The explanation model is the reviewer default; there is no per-repo
  setting for it.

# Software factory design

Status: draft (2026-08-05). Companion to `custom-agents-design.md`.

Turbodiff today reviews PRs. The goal is a full **software factory**: feature intake →
plan → generate → review → fix → verify → merge, running end-to-end on Cloudflare
primitives with humans approving at two gates (plan approval, merge — until auto-merge
is earned).

## Pipeline

```
Intake ──▶ Plan ──▶ [approve?] ──▶ Generate ──▶ PR ──▶ Verify ──▶ Review ──▶ Gate
                                       ▲                                      │
                                       └──────── fix iteration (≤3) ◀── P1/P2 found
                                                                              │
                                                             clean ──▶ [merge: auto|manual]
```

What already exists in this repo is more than the "Review" box:

- **Blocking reviews** (P1 → `REQUEST_CHANGES`, clean → `APPROVE`) *is* the merge gate.
- **Risk tiering** (`src/lib/risk.ts`) is a generic "size the work, scale the workers"
  primitive that generalizes beyond review (e.g. sizing the fix/codegen model).
- GitHub App auth, per-repo settings, agents-as-data, metering, and the D1 schema are
  pipeline infrastructure, not review infrastructure.

Two things are genuinely new:

1. **Code mutation** — an agent that can clone, edit, test, and push (the Phase 1 spike).
2. **Durable orchestration** — a spine that spans days and human approvals
   (Cloudflare Workflows, from Phase 2).

## Cloudflare primitive mapping

| Pipeline piece    | Primitive                                   | Why |
|-------------------|---------------------------------------------|-----|
| Orchestration     | Cloudflare Workflows                        | Durable steps, retries, `step.waitForEvent()` for plan approval and CI webhooks; sleeps for days without compute cost |
| Codegen / fixer   | Sandbox SDK (containers)                    | Claude Code headless with git, real filesystem, test execution |
| Review + gate     | Turbodiff as-is (Flue agents on DOs)        | Already built |
| Frontend evidence | Playwright/agent-browser in the sandbox     | Record a video of the feature; store in R2, link in PR |
| Pipeline state    | D1 (extend existing schema)                 | `features`, `fix_attempts` tables; FK from `reviews` |
| Intake/approvals  | Existing Hono dashboard + session auth      | Already built |

## Design decisions (from the braindump review)

1. **Spec conformance is a separate axis from code correctness.** The plan step must
   emit machine-checkable acceptance criteria; a spec-conformance persona (an `agents`
   row, not new code) reviews the diff against them. A flawless diff that builds the
   wrong thing must not pass the gate.
2. **Test before review.** The codegen/fix sandbox runs unit tests *before* pushing —
   the cheapest iteration loop. CI on the PR is the ground truth the workflow waits on
   (`check_suite` webhook); we do not rebuild CI. The browser video is evidence for the
   human, not a gate.
3. **Fix-loop convergence.** Cap at 3 iterations per PR (tracked in D1). Findings are
   passed to the fixer verbatim as its work order. Reviewer-side reconciliation (already
   in the pr-reviewer prompt) prevents finding churn. On cap exhaustion, produce a human
   handoff summary — what was attempted, what the reviewer still objects to — never a
   silent failure.
4. **Self-review bias.** Generate and review with different models where possible
   (per-agent model overrides already exist).
5. **Auto-merge is earned, not configured.** Ship manual-merge only; add a per-repo
   `auto_merge` column later, after observed pipeline reliability.

## Runner auth: bring-your-own-subscription

Users already pay for Claude (Pro/Max) or ChatGPT (Codex) subscriptions. The fixer and
codegen steps should be able to spend *those* instead of API tokens through the gateway.
The runner abstraction supports three auth modes:

| Mode                  | Mechanism | Notes |
|-----------------------|-----------|-------|
| `claude_subscription` | `claude setup-token` → long-lived OAuth token → `CLAUDE_CODE_OAUTH_TOKEN` env in the sandbox; Claude Code CLI runs headless (`claude -p`) | Officially supported by Anthropic for CI/headless use. Token is user-scoped: store per-user, sealed. |
| `gateway`             | Claude Code CLI with `ANTHROPIC_BASE_URL` pointed at the AI Gateway's Anthropic endpoint (BYOK) + gateway auth header | Same metering/caching path as reviews. Default when no subscription token is configured. |
| `codex_subscription`  | Codex CLI (`codex exec`) with a ChatGPT-authenticated `auth.json` | **Future.** OpenAI's terms around headless/server reuse of ChatGPT subscriptions are less clear than Anthropic's `setup-token` flow — needs a ToS check before shipping to users. |

The agent CLI is the abstraction boundary: the sandbox runs "a coding CLI with env-var
auth", so adding a runner is a Dockerfile line plus an env mapping — no orchestration
changes. Production credential storage: a `runner_credentials` D1 table sealed with
AES-256-GCM via the existing `src/lib/crypto.ts` (same pattern as `agent_connections`
auth). The spike uses Worker secrets instead (see below).

## Data model (Phase 2+)

```sql
features (
  id, repo_id, title, spec, plan, acceptance_criteria,  -- criteria as JSON list
  status,           -- draft | planning | awaiting_approval | generating | reviewing | fixing | verifying | ready | merged | handed_off
  iteration_count,  -- fix-loop counter, cap 3
  workflow_instance_id, created_at, updated_at
)
fix_attempts (
  id, repo_id, pr_number, feature_id NULL,  -- NULL: fix run on a human-authored PR
  trigger,          -- review_blocked | manual
  findings, status, commit_sha, tokens/cost columns, created_at
)
-- reviews gets: feature_id NULL FK
```

## Roadmap (build backwards from the review)

1. **Phase 1 — close the loop (fix iteration).** On `pull_request_review` submitted
   with `REQUEST_CHANGES` from turbodiff (opt-in per repo), dispatch a fix agent in a
   Cloudflare Sandbox: clone head branch → apply findings → run tests → push. Works on
   human-authored PRs too — standalone value before any factory exists. *Status: done —
   manual trigger (`POST /internal/fix`), webhook trigger (`pull_request_review` →
   `FIX_QUEUE` → consumer in `src/cloudflare.ts`), per-repo `auto_fix` dashboard toggle,
   and the `fix_attempts` cap with human-handoff comment. The GitHub App needs
   Contents: Read & write and the Pull request review webhook event.*
2. **Phase 2 — generation.** A Workflow: spec → sandbox codegen → tests → open PR →
   existing review + fix loop take over. API-triggered, no UI.
3. **Phase 3 — planning intake.** Dashboard feature entry; planning agent asks
   clarifying questions, produces plan + acceptance criteria; `waitForEvent` approval
   gate; spec-conformance reviewer persona.
4. **Phase 4 — verification artifacts.** *Built:* an empirical verification step
   doubling as the spec-conformance gate. After generation opens a PR, a verify
   run checks each acceptance criterion against the checked-out branch — static
   criteria by reading the tree, runtime criteria by launching the app
   (per-repo `run_command` + `app_port`), visual criteria by driving headless
   Chromium (puppeteer-core in the sandbox image) and capturing screenshots.
   Evidence lands on the PR as a report comment (✅/❌ table + inline images
   served from R2 via `GET /artifacts/*`); unmet criteria feed the auto-fix
   loop as findings. Screenshots-over-video: they render inline in PR comments.
5. **Phase 5 — auto-merge + trust**, per-feature token budgets, pipeline dashboard.

## Phase 1 spike (this repo, now)

`POST /internal/fix` (Bearer `REVIEW_SECRET`):

```json
{
  "pr_url": "https://github.com/<owner>/<repo>/pull/<n>",
  "findings": "markdown list of P1/P2 findings to address",
  "auth_mode": "claude_subscription | gateway",   // optional; auto-detected
  "test_command": "npm test"                      // optional
}
```

Flow: parse PR → mint installation token → `getSandbox()` → shallow-clone the PR head
branch (token embedded in the remote URL, scrubbed from logs) → write the findings
prompt → run `claude -p` headless with the resolved auth env → run `test_command` →
commit + push → post a summary comment on the PR. The request stays open for the
duration (minutes); production moves this into a Workflow step.

Config:

- Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) enables subscription
  mode; `FIXER_ANTHROPIC_API_KEY` (+ `FIXER_ANTHROPIC_BASE_URL` var) enables gateway
  mode. If both are set, `auth_mode` in the request picks; default prefers subscription.
- `Dockerfile` extends `cloudflare/sandbox` with the Claude Code CLI preinstalled.
- Local dev needs Docker running; deploy with `pnpm run deploy` (builds the container
  image).

Spike success criteria: a real PR branch gets a pushed commit that addresses the listed
findings with tests passing, under each auth mode.

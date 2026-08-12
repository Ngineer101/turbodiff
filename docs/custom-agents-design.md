# Custom review agents — architecture exploration

Status: draft for discussion (no code yet).

## Vision

Turbodiff grows from "a PR reviewer" into "a platform for PR agents": alongside the
built-in code reviewer, users enable prebuilt personas (security, a11y, o11y) and create
fully custom agents — their own instructions, model choice, and external tools — scoped
to their installation and enabled per repo.

Product decisions already made:

- **Full customization including external tools**, with an MCP-based integration path
  (Executor — executor.sh — as the featured way to bring many tools with one endpoint).
- **One GitHub review per agent** — isolated failures, trivial cost attribution, clear
  provenance; accepted trade-off is N bot reviews per PR.
- **Config lives in the dashboard UI** (D1, installation-scoped). Repo-file config can
  layer on later.
- **Auto-run all repo-enabled agents** on PR open/ready; mentions address one agent by
  name. The daily cap counts each agent-run.

## Core architecture: one generic agent, N configs

Flue agents are code — a `'use agent'` export with durable identity and a DO binding.
Tenants cannot ship code into the Worker, so user-created agents are **rows, not
modules**: a single generic reviewer agent is parameterized by a config loaded from D1.

- **Instance identity**: `<agent-slug>--<owner>--<repo>--<pr>` (slug first keeps the
  existing `owner--repo--pr` parser unambiguous to extend). Every agent × PR pair gets
  its own durable conversation, preserving the re-review-with-memory behavior.
- **Config resolution**: dispatch resolves the agent row from D1 and passes a config
  snapshot with the dispatched message; the agent renders hooks from it
  (`useModel(config.model)`, fixed GitHub tools, conditional `useMcpConnection` per
  configured connection). Config edits take effect on the next dispatch.
  _Implementation detail to verify: initial-data payload vs. `useAgentStart` +
  persistent state as the loading mechanism — both are supported Flue patterns._
- **Prompt = fixed scaffold + user instructions.** The scaffold (review process,
  posting/anchoring rules, P1/P2/P3 taxonomy, re-review authorization, PR-content
  injection defense) is Turbodiff-owned and non-negotiable. User instructions are
  inserted into a clearly-delimited "focus" section: they steer _what to look for_,
  not _how to post_ or _what to trust_.
- **Built-ins are seed rows.** The current reviewer plus security / a11y / o11y
  personas ship as `is_builtin` config rows every installation gets; users clone and
  edit them. One machinery, no special cases.

### Alternatives considered

- _One Flue agent module per persona_ — dead end: no runtime code deployment on
  Workers, and custom agents would be second-class.
- _Sub-agents under an orchestrating lead reviewer, one combined review_ — rejected by
  the output-model decision; also couples failures and complicates attribution.

## Data model (D1)

```
agents            id, installation_id, slug, name, description, instructions,
                  model, is_builtin, created_at        (slug unique per installation)
agent_connections agent_id, name, url, tool_allowlist (JSON), auth_ciphertext,
                  optional                              (MCP servers, e.g. Executor)
repo_agents       repository_id, agent_id, enabled     (per-repo enablement)
reviews           + agent_id, agent_slug               (attribution; metering parses
                                                        the extended instance id)
```

`repositories.enabled` stays as the master auto-review switch; `repo_agents` chooses
which agents run when it's on.

## Dispatch & triggers

- **PR open/ready**: loop over the repo's enabled agents, dispatch each to its own
  instance, insert one review row per agent. Cap check counts rows, so N agents on a
  PR consume N of the daily budget.
- **Mentions**: `@turbodiff review` → default reviewer; `@turbodiff <slug>` → that
  agent; `@turbodiff all` → every enabled agent. Unknown slug: 👎 reaction, no dispatch.
  Existing guards (collaborators+, dedupe per PR × agent, bots, edits, closed) apply.
- **Review identity on the PR**: everything posts as `turbodiff[bot]` (one GitHub App),
  so provenance is badged in the review body's first line: `**Turbodiff · Security**`.

## External tools (the "full custom" part)

Rather than building per-integration plumbing (OpenAPI importers, per-service OAuth),
Turbodiff consumes **one standard: remote MCP**. Flue's `useMcpConnection` already
handles discovery, mounting, namespacing (`mcp__<server>__<tool>`), allowlists,
`optional` degradation, and bearer auth (static or per-request function).

A custom agent's tool config is just: MCP URL + write-only bearer secret + optional
tool allowlist. **Executor** is the featured path because it turns "many integrations"
into exactly that shape — users configure MCP servers / OpenAPI / GraphQL with
per-tool policies in Executor's catalog and hand Turbodiff a single hosted MCP
endpoint; secrets stay host-side in Executor, and tool policy enforcement (allow /
approve / block) happens there rather than in Turbodiff.

### Security model

- **Blast radius**: agent configs are authored by installation admins and only run on
  that installation's repos, spending that installation's cap. A malicious config
  hurts only its author's tenant.
- **Data egress is a documented choice**: an agent with repo read access plus a
  user-supplied MCP endpoint can send code context to that endpoint. That's inherent
  to "bring your own tools" — surfaced in the UI copy, not silently allowed.
- **Secrets**: connection tokens encrypted at rest (AES-GCM with a Worker secret key),
  write-only in the UI, decrypted only inside the auth callback.
- **Endpoint hygiene**: HTTPS-only URLs; connection failures degrade per Flue's
  `optional` flag; scaffold prompt treats MCP tool _results_ as untrusted content,
  same as PR data.
- **Cost**: metering already attributes per instance; the dashboard gains a per-agent
  cost dimension. Per-agent model choice may need an allowlist (e.g. haiku/sonnet
  tiers) as a cost-control valve.

## Dashboard & UI

- New **/agents** area: list (built-ins + custom), create / clone / edit — name, slug,
  instructions, model, connections (URL + secret + allowlist), and a per-repo
  enablement matrix. A "test connection" action that performs the MCP handshake and
  lists discovered tools is high-value.
- Dashboard: cost-by-agent breakdown; review rows show the agent badge; `/reviews`
  filterable by agent.

## Phasing

1. **Multi-agent core** — schema, generic agent + config loading, dispatch loop,
   mention-by-name, seeded built-ins, agents CRUD UI. No external tools yet.
2. **External tools** — `agent_connections`, encrypted secrets, `useMcpConnection`
   wiring, Executor onboarding docs, test-connection UI.
3. **Refinement** — per-agent trigger rules (path filters, event choice), repo-file
   overrides, per-agent caps, shareable agent templates.

## Resolved decisions (2026-08-03)

- **Model per agent**: free choice of any gateway-served coding-capable model id, with
  `claude-sonnet-5` as the pre-selected default in the UI. Save-time validation should
  catch broken ids early (cheap test call or catalog check) since unvetted ids
  otherwise fail at review time.
- **Cap**: the installation daily cap counts agent-runs (existing counter; N enabled
  agents drain it N× faster per PR).
- **Agent admin**: anyone in the installation (same authorization as the settings UI).
- **Sequencing**: prompt-caching fix ships first as its own PR (priority #1 — zero
  cache reads today, ~$1.46 per medium review, multiplied by N agents), then Phase 1
  (multi-agent core), then Phase 2 (MCP/Executor connections).

## Open questions

- Whether mention slugs need namespacing against future reserved commands
  (`@turbodiff help`, `@turbodiff status`).

## Investigated and declined (2026-08-12): per-agent provider/gateway override

Considered letting a review agent point at its own provider or AI Gateway (bring-your-own,
mirroring the factory runner credentials above) instead of the installation's one
Worker-wide `setProvider()` call in `src/app.ts`. Declined for now, after inspecting the
installed `@flue/runtime@2.0.1`:

- `setProvider()` registers globally by the provider's own `id`, and `useModel()` only
  ever resolves a `<provider-id>/<model-id>` string against whatever's currently
  registered — there's no per-call/per-dispatch provider parameter. A safe override would
  have to call `setProvider()` from code that runs inside the same execution context as
  the `useModel()` call it's meant to affect (i.e. from within the agent module itself,
  not from `dispatchReviewAgent` in `app.ts`, which runs in the dispatching Worker
  request, a different execution context from wherever the agent's `useModel()` actually
  resolves) — and even then, a mutable-by-id global registry is a correctness hazard if
  more than one dispatch can be in flight against it concurrently.
- The only provider factory `@flue/runtime` exposes to application code is
  `cloudflareBindingProvider` (Cloudflare AI Gateway only, via the `env.AI` binding).
  Anything else (a custom Anthropic/OpenAI-compatible endpoint) would need a `Provider`
  built from `@earendil-works/pi-ai` directly — a transitive dependency this repo doesn't
  currently depend on directly, with no bundled docs to verify its API against.

Model validation (`MODEL_RE` in `src/routes/api.ts`) is therefore unchanged: every agent's
model is still a Cloudflare AI Gateway id, and review continues to dispatch through the
installation's one default gateway exactly as before. Revisit if a future `@flue/runtime`
version exposes a documented per-dispatch provider selector.

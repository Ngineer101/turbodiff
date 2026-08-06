# Security

Turbodiff runs AI agents against untrusted input by design: pull-request
diffs, review threads, repository contents, and user-submitted requirements
all flow into agent prompts, and the agents act on real repositories with
real credentials. This document describes the trust model, what is mitigated,
and — just as importantly — what is not yet.

**Reporting:** please report suspected vulnerabilities via
[GitHub private vulnerability reporting](https://github.com/Ngineer101/turbodiff/security/advisories/new)
rather than a public issue.

## Trust model

| Component | Trust level |
|---|---|
| Repository contents, PR diffs, review threads | **Untrusted** — may contain prompt-injection payloads |
| Feature requirements / plan answers | Untrusted as *content*; submitted only by authenticated repo admins |
| Per-repo commands (`check_command`, `run_command`) | Trusted — set only by users who already control the repo the commands run against |
| The sandbox container | Semi-trusted execution: it isolates agent runs from the Worker, but code inside it (including the app under test and anything an agent writes) runs with the container's env and network |
| The Worker | Trusted — holds the App private key and mints all tokens |

## Mitigations in place

- **Least-privilege sandbox tokens.** Sandboxes never see the full
  installation token. Each run mints a token scoped to the one repository it
  operates on, with `contents` permission only — read-only for planner and
  verifier runs, write for generator and fixer runs. A prompt-injected agent
  cannot touch other repositories in the installation or use other App
  permissions (issues, pull requests, webhooks). Tokens are scrubbed from all
  surfaced output and removed from the git remote in a `finally` block.
- **Signed artifact URLs.** Verification screenshots are served from R2 via
  capability URLs — an HMAC over the object key is required, so evidence for
  a private repo's app cannot be enumerated or guessed. Anyone who can read
  the PR (where the URL is posted) can view its evidence, which is the
  intended audience.
- **Shell-safety.** Untrusted values (branch names, feature titles, tokens)
  travel into sandbox commands via environment variables, never string
  interpolation.
- **Prompt-injection defense in depth.** Every agent prompt carries explicit
  untrusted-content rules (`src/lib/prompt-security.ts`). These are a layer,
  not a boundary — the structural mitigations above assume prompt rules can
  fail.
- **Webhooks and operator endpoints.** GitHub webhooks are authenticated
  solely by HMAC signature. Operator endpoints require a bearer secret
  compared in constant time. The local-dev fake login is honored only on
  loopback hosts.
- **Push gating.** Generated and fixed code must pass the repo's
  `check_command` before it is pushed; agent changes are committed before
  checks run so check-side working-tree mutations cannot leak into commits.
- **MCP connections.** Bearer tokens for agent MCP connections are AES-GCM
  encrypted at rest and write-only in the UI; MCP responses are treated as
  untrusted content.

## Known limitations (accepted for single-tenant, blocking for multi-tenant)

- **Unrestricted sandbox egress.** Cloudflare Containers do not currently
  expose per-container network policy, so a fully compromised agent run could
  exfiltrate what the container holds. Token scoping bounds the blast radius
  to one repository's contents.
- **Runner credential in the container.** The Claude subscription token (or
  gateway key) is present in the sandbox environment during agent runs and is
  a theft target under prompt injection. Use a gateway key with spend limits
  where this matters; subscription mode is recommended only for repos you
  own.
- **Agents run with permission checks disabled** inside the sandbox
  (`--dangerously-skip-permissions`); the container plus token scoping is the
  isolation boundary, not the agent harness.
- **Auto-fix pushes to PR branches on its own.** The cap (3 attempts/PR),
  check gate, and review reconciliation bound it, but a malicious blocking
  review body on a repo with auto-fix enabled is an injection channel into
  the fixer; only enable auto-fix on repos whose collaborators you trust.
- **Single-operator deployment.** There is no per-user authorization inside
  an installation beyond GitHub's own (any user who can access the
  installation can configure its repos). Multi-tenant hosting needs a proper
  authorization review first.

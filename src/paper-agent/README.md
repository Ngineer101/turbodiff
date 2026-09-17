# Autonomous Paper Design Agent (MVP)

A Cloudflare-hosted agent that autonomously creates and iterates on designs in
Paper without the user's browser tab staying open. Paper runs inside a
persistent Cloudflare Browser Run session; the agent drives it primarily through
WebMCP, inspects the result with screenshots, critiques it with a multimodal
model, and iterates — all asynchronously.

This is a **technical proof of concept**, not production infrastructure. Its main
dependency, WebMCP, is currently exposed only through Browser Run's experimental
"lab" environment, and Paper's WebMCP surface has origin/authentication
restrictions.

## Architecture

```
Web app / API  ──POST /paper/jobs──▶  Worker (Hono route)
                                          │
                                          ▼
                                DesignJob Durable Object   ◀── source of truth
                                 (objective, status,
                                  iteration, sessionId,
                                  conversation, artifacts)
                                          │  one turn per alarm
                                          ▼
                                Cloudflare Browser Run (lab)
                                  persistent Chrome + Paper
                                   ├─ WebMCP tools (paper.*)
                                   └─ screenshots / DOM (browser.*)
                                          │  screenshot + tool results
                                          ▼
                                 Claude (AI Gateway) — plan → execute
                                   → observe → evaluate → decide
```

The Durable Object owns job state; Browser Run is an execution environment. That
split lets a job survive Worker termination and resume by reconnecting to the
same warm browser session by id.

## Files

| File            | Responsibility                                                          |
| --------------- | ----------------------------------------------------------------------- |
| `types.ts`      | `DesignJob` job model and WebMCP tool shapes                            |
| `config.ts`     | Env-derived configuration (model, Paper URL, limits, Live View)         |
| `browser.ts`    | Browser Run session: open/resume, screenshot, navigate, inspect, WebMCP |
| `webmcp.ts`     | WebMCP `listTools` payload normalisation (pure, unit-tested)            |
| `model.ts`      | Claude Messages calls through Cloudflare AI Gateway                     |
| `tools.ts`      | Builds the model's tool catalog: `paper.*` / `browser.*` / `job.*`      |
| `agent-loop.ts` | One agent turn: model round-trip + tool execution                       |
| `artifacts.ts`  | Screenshot persistence to R2 as signed capability URLs                  |
| `design-job.ts` | `DesignJob` Durable Object: alarm-driven loop, resumption               |
| `routes.ts`     | `/paper/jobs` HTTP surface                                              |

## API

- `POST /paper/jobs` — `{ objective, paperUrl?, model? }` → `DesignJob`
- `GET /paper/jobs/:id` — inspect a job
- `POST /paper/jobs/:id/resume` — re-queue a paused/failed job (e.g. after auth)
- `GET /paper/jobs/:id/live-view` — session id + Live View URL for auth

All routes are session-authenticated and scoped to the caller's organization.

## Tool groups

- `paper__*` — Paper WebMCP tools discovered at runtime (preferred).
- `browser_screenshot` / `browser_navigate` / `browser_inspect` — visual + DOM fallback.
- `job_note` / `job_request_user_input` / `job_complete` — job control.

Future groups (`code.*`, `deploy.*`, `github.*`) would extend the same agent from
design → implementation → visual comparison → iteration.

## Authentication

Initial Paper authentication may require a human. When the agent opens Paper and
the WebMCP surface is absent, the job moves to `needs_user`; an operator opens
the Browser Run Live View (see `GET .../live-view`), signs in, and calls
`resume`. The warm session (and its cookies) persists across turns, so this is a
one-time step per session.

## Configuration

Set via deployment vars/secrets (see `.dev.vars.example`):

- `PAPER_BASE_URL` — default authenticated Paper document URL (overridable per job).
- `PAPER_AGENT_MODEL` — AI Gateway model id for planning + critique (multimodal Anthropic).
- `PAPER_LIVE_VIEW_BASE` — base used to build Live View URLs.

Requires the Browser Run binding (`BROWSER`) with lab access, the R2 `ARTIFACTS`
bucket, and the existing AI Gateway configuration.

## MVP success criteria (from the spec)

1. Paper stays authenticated inside Browser Run — warm session + resume.
2. WebMCP tools discovered (`listWebMcpTools`) and executed (`executeWebMcpTool`).
3. Session can be disconnected and resumed — one disconnect/reconnect per turn.
4. The model performs multiple Paper tool calls with no user interaction.
5. Screenshots feed back into the agent as image blocks for visual iteration.
6. Job state survives individual Worker executions — Durable Object storage.

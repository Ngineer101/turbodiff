// Autonomous Paper Design Agent — job model.
//
// A design request becomes a persistent DesignJob owned by the DesignJob
// Durable Object. Cloudflare Browser Run is an execution environment, not the
// source of truth: the job's objective, iteration count, and artifacts survive
// individual Worker executions because they live in Durable Object storage.
//
// This file defines the public, serialisable shapes only. Runtime behaviour
// (browser control, model calls, the agent loop) lives in sibling modules so
// this contract stays free of platform bindings and easy to test.

import type { JsonObject, JsonValue } from '../shared/json.ts';

export type DesignJobStatus =
  | 'queued'
  | 'planning'
  | 'designing'
  | 'evaluating'
  | 'needs_user'
  | 'complete'
  | 'failed';

/** Terminal statuses never schedule further agent work. */
export const TERMINAL_STATUSES: ReadonlySet<DesignJobStatus> = new Set<DesignJobStatus>([
  'complete',
  'failed',
]);

/** Public view of a job, returned by the API and safe to show a client. */
export interface DesignJob {
  id: string;
  objective: string;
  status: DesignJobStatus;
  iteration: number;
  browserSessionId?: string;
  paperDocumentId?: string;
  artifacts: {
    // Signed capability URLs (served by GET /artifacts/*) for each screenshot
    // captured during iteration, oldest first.
    screenshots: string[];
  };
  // Extensions beyond the design spec, useful while operating a proof of
  // concept: attribution, timing, the model's running notes, and the reason a
  // job paused or failed.
  organizationId: string;
  createdAt: string;
  updatedAt: string;
  notes: string[];
  needsUserReason?: string;
  error?: string;
}

/** A tool advertised by Paper through the WebMCP surface. */
export interface WebMcpTool {
  name: string;
  description?: string;
  // JSON Schema for the tool's arguments, as returned by
  // navigator.modelContextTesting.listTools(). Shape is provider-defined, so
  // it is carried as a JSON object and only re-serialised into the tool list.
  inputSchema?: JsonObject;
}

/** Result of executing a WebMCP tool inside the Paper page. */
export interface WebMcpToolResult {
  ok: boolean;
  // Structured result value when the tool succeeded.
  value?: JsonValue;
  // Human-readable error when it did not.
  error?: string;
}

/** Input accepted by POST /paper/jobs. */
export interface CreateDesignJobInput {
  objective: string;
  organizationId: string;
  authUserId: string;
  // The authenticated Paper document/share URL the agent should operate in.
  // Supplied per request so operators can point a job at any document they can
  // reach; falls back to the PAPER_BASE_URL env var when omitted.
  paperUrl?: string;
  // Optional model override (Cloudflare AI Gateway unified id, e.g.
  // "anthropic/claude-...").
  model?: string;
}

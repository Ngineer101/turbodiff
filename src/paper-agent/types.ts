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

// A job either reads an existing Paper design and proves it is readable
// ('read', the current proof-of-concept goal) or autonomously builds/iterates a
// design ('design', the eventual factory flow). Read mode never writes to Paper.
export type JobMode = 'read' | 'design';

/** What a read-mode job discovered about a Paper design's readability. */
export interface WebMcpReadProbe {
  // Whether Paper's WebMCP surface was present on the page.
  available: boolean;
  // Names of the WebMCP tools discovered (empty when unavailable).
  tools: string[];
  // Result of invoking one read-only WebMCP tool, when a safe one was found.
  // The value is JSON-encoded so this report stays a shallow, serialisable
  // record across the Durable Object RPC boundary.
  read?: { tool: string; result: string };
  // Why a WebMCP read did not happen or failed.
  error?: string;
}

/** Proof that a Paper design can be read through the browser/WebMCP setup. */
export interface DesignReadReport {
  paperUrl: string;
  capturedAt: string;
  // Visual proof: signed URL of a screenshot of the rendered design.
  screenshot?: string;
  // Structural proof (when authenticated + lab enabled): WebMCP discovery/read.
  webMcp: WebMcpReadProbe;
  // Text proof: visible text extracted from the page (layer/page names, copy).
  // `textUrl` is a signed URL of the full extracted text stored in R2 (the
  // inline sample is capped); `textLength` is the full length.
  dom: { title?: string; textSample: string; textLength: number; textUrl?: string };
}

/** Public view of a job, returned by the API and safe to show a client. */
export interface DesignJob {
  id: string;
  objective: string;
  mode: JobMode;
  status: DesignJobStatus;
  iteration: number;
  browserSessionId?: string;
  paperDocumentId?: string;
  artifacts: {
    // Signed capability URLs (served by GET /artifacts/*) for each screenshot
    // captured during iteration, oldest first.
    screenshots: string[];
  };
  // Populated by a read-mode job: the evidence that the design is readable.
  readReport?: DesignReadReport;
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
  // 'read' (default) proves an existing design is readable without writing;
  // 'design' runs the autonomous build/iterate loop.
  mode?: JobMode;
  // The authenticated Paper document/share URL the agent should operate in.
  // Supplied per request so operators can point a job at any document they can
  // reach; falls back to the PAPER_BASE_URL env var when omitted.
  paperUrl?: string;
  // Attach to an existing Browser Run session (by id) instead of launching a
  // fresh one. Lets an operator sign into Paper once in the Live View and then
  // run a read job against that already-authenticated session, so WebMCP is
  // available. When omitted, a new session is launched.
  sessionId?: string;
  // Optional model override (Cloudflare AI Gateway unified id, e.g.
  // "anthropic/claude-...").
  model?: string;
}

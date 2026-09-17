// Configuration surface for the Paper design agent.
//
// Everything an operator can tune is read from the environment here so the
// rest of the module depends on plain values, not `env`. Defaults are chosen
// to make the proof-of-concept runnable with only a Paper URL configured.

// Cloudflare AI Gateway unified model id used for planning and multimodal
// critique. Must be a multimodal Anthropic model enabled on the account's
// gateway. Overridable per job (CreateDesignJobInput.model) or per deployment
// (PAPER_AGENT_MODEL).
export const DEFAULT_PAPER_AGENT_MODEL = 'anthropic/claude-3-7-sonnet-latest';

// Upper bound on agent turns (model round-trips) per job. Each turn may issue
// several tool calls. Keeps a runaway loop from burning tokens indefinitely.
export const MAX_ITERATIONS = 12;

// Cap on screenshots retained per job, protecting Durable Object storage and
// the model's context window.
export const MAX_SCREENSHOTS = 24;

// How long Browser Run keeps the session warm after the agent disconnects, in
// seconds. Long enough to bridge the gap between alarm-driven turns while the
// Worker isolate is gone.
export const BROWSER_KEEP_ALIVE_SECONDS = 600;

// Max tokens the model may emit per turn.
export const MODEL_MAX_TOKENS = 4096;

// Env subset the model/config helpers need. The Browser Run binding is passed
// explicitly to the browser module rather than carried here, keeping this
// structurally assignable from the ambient Worker Env.
export interface PaperAgentEnv {
  ARTIFACTS: R2Bucket;
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_API_TOKEN: string;
  PAPER_BASE_URL?: string;
  PAPER_AGENT_MODEL?: string;
  // Optional base used to build a Browser Run Live View URL for human-assisted
  // authentication, e.g. "https://<account>.browser-run.cloudflare.dev/live".
  PAPER_LIVE_VIEW_BASE?: string;
}

export function resolveModel(env: PaperAgentEnv, requested?: string): string {
  return (requested ?? env.PAPER_AGENT_MODEL ?? DEFAULT_PAPER_AGENT_MODEL).trim();
}

export function resolvePaperUrl(env: PaperAgentEnv, requested?: string): string {
  const url = (requested ?? env.PAPER_BASE_URL ?? '').trim();
  if (!url) {
    throw new Error(
      'no Paper URL: pass paperUrl in the request body or set PAPER_BASE_URL for this deployment',
    );
  }
  return url;
}

/** Build a Live View URL for a session when a base is configured. */
export function liveViewUrl(env: PaperAgentEnv, sessionId: string): string | null {
  const base = env.PAPER_LIVE_VIEW_BASE?.trim();
  if (!base) return null;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}sessionId=${encodeURIComponent(sessionId)}`;
}

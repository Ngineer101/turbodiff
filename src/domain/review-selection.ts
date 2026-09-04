import { REVIEW_NOISE_PATTERNS } from './review-diff.ts';
import { DEFAULT_AGENT_SLUG } from './personas.ts';

// Pure review-dispatch policy: which risk tier a set of changed files earns,
// which enabled agents that tier runs, and — on a push to an already-reviewed
// change — which agents actually need another look. The service layer
// (services/review-policy.ts, services/change-review.ts) fetches the inputs;
// nothing here touches the network or the database.

// Risk-tiered dispatch, after Cloudflare's AI code review setup: small
// mechanical changes get one generalist pass, mid-size changes a reduced
// fleet, and large or security-sensitive changes every enabled agent. Only
// automatic (PR open/ready/push) dispatch tiers; mentions and the /review
// endpoint are explicit intent and always run what was asked.
export type RiskTier = 'trivial' | 'lite' | 'full';

// Reviewable (noise-filtered) line budget per tier.
const TRIVIAL_MAX_LINES = 10;
const LITE_MAX_LINES = 100;
// At or past this many changed files it's a full review regardless of lines.
const FULL_MIN_FILES = 50;

// Paths whose changes always escalate to a full review regardless of size:
// auth/crypto/secret-adjacent code and CI workflow definitions.
const SENSITIVE_PATH =
  /auth|crypto|secret|token|session|password|permission|security|\.github\/workflows\//i;

// Built-in slugs that still run on a mid-size ("lite") PR.
const LITE_SLUGS = new Set([DEFAULT_AGENT_SLUG, 'security']);

export interface RiskFileEntry {
  filename: string;
  additions: number;
  deletions: number;
  // Set on renames (GitHub compare/files shape): the path before the move.
  previous_filename?: string;
}

// The pure classification — shared by the GitHub path (files from the PR
// or compare API) and native change requests (files from the CR record).
export function computeRiskTierFromFiles(files: RiskFileEntry[]): RiskTier {
  if (files.length >= FULL_MIN_FILES) return 'full';
  if (files.some((f) => SENSITIVE_PATH.test(f.filename))) return 'full';

  const lines = files
    .filter((f) => !REVIEW_NOISE_PATTERNS.some((n) => n.pattern.test(f.filename)))
    .reduce((n, f) => n + f.additions + f.deletions, 0);
  if (lines <= TRIVIAL_MAX_LINES) return 'trivial';
  return lines <= LITE_MAX_LINES ? 'lite' : 'full';
}

// The subset of enabled agents a tier dispatches. Installations running only
// custom agents (no built-ins enabled) keep exactly one reviewer on small
// PRs: the first enabled agent (the list orders built-ins first, then name).
export function agentsForTier<T extends { slug: string }>(tier: RiskTier, enabled: T[]): T[] {
  if (tier === 'full') return enabled;
  const wanted = tier === 'trivial' ? new Set([DEFAULT_AGENT_SLUG]) : LITE_SLUGS;
  const subset = enabled.filter((a) => wanted.has(a.slug));
  return subset.length > 0 ? subset : enabled.slice(0, 1);
}

export type ReviewVerdict = 'approve' | 'comment' | 'request_changes';

// What changed between the last reviewed head and the pushed one.
export interface PushDelta {
  sinceHead: string;
  files: RiskFileEntry[];
  tier: RiskTier;
}

// An agent's most recent completed review of the change.
export interface PriorReview {
  agentSlug: string;
  verdict: ReviewVerdict;
  // Files its findings anchored to (empty for a clean approval, or for rows
  // recorded before finding paths were kept).
  findingPaths: string[];
}

export interface PushSelection<T> {
  agents: T[];
  skipped: { slug: string; reason: string }[];
  tier: RiskTier;
}

// Who re-reviews after a push. Without a usable delta (no prior head, or the
// compare failed) this is the opened-PR policy on the whole change. With one:
//   - an agent that never concluded runs iff the delta's tier includes it;
//   - an agent that requested changes always runs — it owns a standing block
//     and must re-judge it;
//   - an agent that approved (or merely commented) stays approved unless the
//     delta is big or sensitive enough to be 'full', or touches a file it
//     flagged. Anything else is a change it already signed off on.
// Because every blocker re-runs, an empty selection means no agent holds a
// block, and the stage can settle as clean without dispatching anyone.
export function selectAgentsForPush<T extends { slug: string }>(
  enabled: T[],
  priors: PriorReview[],
  delta: PushDelta | null,
  wholeChangeTier: RiskTier,
): PushSelection<T> {
  if (!delta) {
    return { agents: agentsForTier(wholeChangeTier, enabled), skipped: [], tier: wholeChangeTier };
  }
  const inTier = new Set(agentsForTier(delta.tier, enabled).map((agent) => agent.slug));
  const touched = new Set(
    delta.files.flatMap((file) =>
      file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
    ),
  );
  const priorBySlug = new Map(priors.map((prior) => [prior.agentSlug, prior]));
  const selection: PushSelection<T> = { agents: [], skipped: [], tier: delta.tier };
  for (const agent of enabled) {
    const prior = priorBySlug.get(agent.slug);
    if (!prior) {
      if (inTier.has(agent.slug)) selection.agents.push(agent);
      else selection.skipped.push({ slug: agent.slug, reason: `outside the ${delta.tier} tier` });
      continue;
    }
    if (prior.verdict === 'request_changes' || delta.tier === 'full') {
      selection.agents.push(agent);
      continue;
    }
    const hit = prior.findingPaths.find((path) => touched.has(path));
    if (hit) selection.agents.push(agent);
    else {
      selection.skipped.push({
        slug: agent.slug,
        reason: 'approved earlier and the push does not touch its findings',
      });
    }
  }
  return selection;
}

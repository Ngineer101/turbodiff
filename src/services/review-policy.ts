import { env } from 'cloudflare:workers';
import { githubRequest as gh } from '../integrations/github/client.ts';
import { REVIEW_NOISE_PATTERNS } from '../domain/review-diff.ts';
import { installationToken } from '../integrations/github/app.ts';
import { DEFAULT_AGENT_SLUG } from '../domain/personas.ts';
import { reviewCountLastDay } from '../data/db.ts';

// Risk-tiered dispatch, after Cloudflare's AI code review setup: small
// mechanical changes get one generalist pass, mid-size changes a reduced
// fleet, and large or security-sensitive changes every enabled agent. Only
// automatic (PR open/ready) dispatch tiers; mentions and the /review
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
}

// The pure classification — shared by the GitHub path (files from the PR
// API) and native change requests (files from the CR record).
export function computeRiskTierFromFiles(files: RiskFileEntry[]): RiskTier {
  if (files.length >= FULL_MIN_FILES) return 'full';
  if (files.some((f) => SENSITIVE_PATH.test(f.filename))) return 'full';

  const lines = files
    .filter((f) => !REVIEW_NOISE_PATTERNS.some((n) => n.pattern.test(f.filename)))
    .reduce((n, f) => n + f.additions + f.deletions, 0);
  if (lines <= TRIVIAL_MAX_LINES) return 'trivial';
  return lines <= LITE_MAX_LINES ? 'lite' : 'full';
}

export async function computeRiskTier(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<RiskTier> {
  const token = await installationToken(installationId);
  // One page suffices: at 50+ files the tier is already 'full', so anything
  // past the first 100 can't change the answer.
  const res = await gh(token, `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
  // SAFETY: gh() throws on non-2xx, and GitHub's "list pull request files"
  // response is an array whose items always carry filename, additions, and
  // deletions.
  const files = (await res.json()) as RiskFileEntry[];
  return computeRiskTierFromFiles(files);
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

// Optional cheap-model override for trivial reviews. TRIVIAL_MODEL is a
// gateway model id in wrangler.jsonc vars; empty disables the downgrade and
// trivial reviews run each agent's configured model.
export function tierModelOverride(tier: RiskTier): string | undefined {
  return tier === 'trivial' && env.TRIVIAL_MODEL ? env.TRIVIAL_MODEL : undefined;
}

// Agent-runs left under the installation's rolling daily cap — the shared
// admission control for review dispatch, GitHub webhooks and native change
// requests alike (each selected agent consumes one unit).
export async function remainingDailyBudget(
  installationId: number,
  accountLabel: string,
): Promise<number> {
  const limit = Number(env.REVIEW_DAILY_LIMIT) || 50;
  const used = await reviewCountLastDay(installationId);
  const remaining = limit - used;
  if (remaining <= 0) {
    console.warn(
      `turbodiff: daily review cap (${limit}) reached for installation ${installationId} (${accountLabel})`,
    );
  }
  return remaining;
}

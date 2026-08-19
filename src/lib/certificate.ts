// "Proof of Build" certificate assembly (render: src/routes/certificate-page.tsx). Each
// feature gets a public capability URL at GET /b/:id — the HMAC over
// cert/<id> is the only credential, mirroring the /artifacts/* scheme, so
// links are shareable but not enumerable.
import { env } from 'cloudflare:workers';
import { signArtifactKey } from './crypto.ts';
import {
  getFeature,
  getRepoById,
  latestVerificationForFeature,
  listAgentRunsForFeature,
  countFixAttempts,
} from './db.ts';
import type { CertificateData } from '../routes/certificate-page.tsx';

// Scoped under cert/ so a certificate sig replayed against /artifacts/* hits
// a key space where no object ever lives (and vice versa).
export const certificateSigKey = (featureId: number) => `cert/${featureId}`;

export async function certificateUrl(featureId: number): Promise<string> {
  const sig = await signArtifactKey(certificateSigKey(featureId));
  return `${env.PUBLIC_BASE_URL}/b/${featureId}?sig=${sig}`;
}

// Thumbnails shown on the card; the count line still reports every capture.
const MAX_SHOTS = 5;

interface RawResult {
  index: number;
  verdict: 'pass' | 'fail' | 'skip';
  note: string;
  screenshot?: string;
}

export async function loadCertificateData(featureId: number): Promise<CertificateData | null> {
  const feature = await getFeature(featureId);
  // A certificate only exists once there is a PR to certify.
  if (!feature || !feature.pr_number) return null;
  const repo = await getRepoById(feature.repository_id);
  if (!repo) return null;

  const verification = await latestVerificationForFeature(featureId);
  const criteria: string[] = feature.acceptance ? JSON.parse(feature.acceptance) : [];
  const results: RawResult[] = verification?.results ? JSON.parse(verification.results) : [];
  const byIndex = new Map(results.map((r) => [r.index, r]));

  const shotNames = [
    ...new Set(results.map((r) => r.screenshot).filter((s): s is string => !!s)),
  ].map((name) => ({ name, safe: name.replace(/[^\w.-]/g, '') }));
  const screenshots = await Promise.all(
    shotNames.slice(0, MAX_SHOTS).map(async ({ name, safe }) => {
      const key = `verify/${featureId}/${safe}`;
      return {
        url: `${env.PUBLIC_BASE_URL}/artifacts/${key}?sig=${await signArtifactKey(key)}`,
        label: name.replace(/\.png$/, '').replaceAll('-', ' '),
      };
    }),
  );

  const runs = await listAgentRunsForFeature(featureId);
  // Wall clock of the factory run: generation start to the last agent run.
  // Older features predate run_started_at/agent_runs — omit rather than guess.
  let agentMinutes: number | null = null;
  const lastRun = runs.at(-1);
  if (feature.run_started_at && lastRun) {
    const ms = sqliteMs(lastRun.created_at) - sqliteMs(feature.run_started_at);
    if (Number.isFinite(ms) && ms > 0) agentMinutes = Math.max(1, Math.round(ms / 60_000));
  }

  const verdicts = criteria.map((_, i) => byIndex.get(i)?.verdict ?? null);
  return {
    serial: `TD-${yearOf(feature.created_at)}-${String(feature.id).padStart(4, '0')}`,
    featureTitle: feature.title,
    repoFullName: `${repo.owner}/${repo.name}`,
    prNumber: feature.pr_number,
    prUrl: `https://github.com/${repo.owner}/${repo.name}/pull/${feature.pr_number}`,
    authorLogin: feature.author_login,
    verifiedAt: verification?.created_at ?? null,
    criteria: criteria.map((text, i) => ({ text, verdict: verdicts[i] })),
    screenshots,
    screenshotCount: shotNames.length,
    agentMinutes,
    fixIterations: await countFixAttempts(feature.repository_id, feature.pr_number),
    agentRuns: runs.length,
    verified:
      verification?.status === 'passed' &&
      criteria.length > 0 &&
      verdicts.every((v) => v === 'pass' || v === 'skip'),
    pageUrl: await certificateUrl(featureId),
  };
}

// SQLite datetime('now') has no timezone marker; treat it as UTC.
function sqliteMs(ts: string): number {
  return new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`).getTime();
}

function yearOf(ts: string): string {
  const y = new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`).getUTCFullYear();
  return Number.isFinite(y) ? String(y) : '0000';
}

import { describe, expect, it } from 'vite-plus/test';
import {
  agentsForTier,
  computeRiskTierFromFiles,
  selectAgentsForPush,
  type PriorReview,
  type PushDelta,
  type RiskFileEntry,
} from './review-selection.ts';

const agents = [{ slug: 'review' }, { slug: 'security' }, { slug: 'a11y' }, { slug: 'o11y' }];
const slugs = (selection: { agents: { slug: string }[] }) =>
  selection.agents.map((agent) => agent.slug);

function delta(files: RiskFileEntry[]): PushDelta {
  return { sinceHead: 'aaaaaaa', files, tier: computeRiskTierFromFiles(files) };
}

function approved(agentSlug: string, findingPaths: string[] = []): PriorReview {
  return { agentSlug, verdict: 'approve', findingPaths };
}

const small = (filename: string, lines = 2): RiskFileEntry => ({
  filename,
  additions: lines,
  deletions: 0,
});

describe('computeRiskTierFromFiles', () => {
  it('tiers by reviewable lines, file count, and sensitive paths', () => {
    expect(computeRiskTierFromFiles([small('src/a.ts', 4)])).toBe('trivial');
    expect(computeRiskTierFromFiles([small('src/a.ts', 60)])).toBe('lite');
    expect(computeRiskTierFromFiles([small('src/a.ts', 400)])).toBe('full');
    expect(computeRiskTierFromFiles([small('src/auth/login.ts', 1)])).toBe('full');
    expect(
      computeRiskTierFromFiles(Array.from({ length: 50 }, (_, i) => small(`src/f${i}.ts`, 1))),
    ).toBe('full');
    expect(computeRiskTierFromFiles([small('pnpm-lock.yaml', 5000)])).toBe('trivial');
  });
});

describe('agentsForTier', () => {
  it('narrows the fleet on small changes and keeps one custom reviewer', () => {
    expect(agentsForTier('full', agents)).toEqual(agents);
    expect(agentsForTier('lite', agents).map((a) => a.slug)).toEqual(['review', 'security']);
    expect(agentsForTier('trivial', agents).map((a) => a.slug)).toEqual(['review']);
    expect(agentsForTier('trivial', [{ slug: 'custom-b' }, { slug: 'custom-a' }])).toEqual([
      { slug: 'custom-b' },
    ]);
  });
});

describe('selectAgentsForPush', () => {
  it('falls back to whole-change tiering when the delta is unknown', () => {
    const selection = selectAgentsForPush(agents, [approved('a11y', ['src/a.ts'])], null, 'lite');
    expect(slugs(selection)).toEqual(['review', 'security']);
    expect(selection.tier).toBe('lite');
    expect(selection.skipped).toEqual([]);
  });

  it('runs agents without a prior verdict only when the delta tier includes them', () => {
    const selection = selectAgentsForPush(agents, [], delta([small('src/a.ts')]), 'full');
    expect(slugs(selection)).toEqual(['review']);
    expect(selection.tier).toBe('trivial');
    expect(selection.skipped.map((s) => s.slug)).toEqual(['security', 'a11y', 'o11y']);
  });

  it('always re-runs an agent that requested changes, whatever the delta', () => {
    const priors: PriorReview[] = [
      { agentSlug: 'a11y', verdict: 'request_changes', findingPaths: ['src/dialog.tsx'] },
      approved('security'),
    ];
    const selection = selectAgentsForPush(agents, priors, delta([small('README.md')]), 'full');
    expect(slugs(selection)).toEqual(['review', 'a11y']);
    expect(selection.skipped).toContainEqual({
      slug: 'security',
      reason: 'approved earlier and the push does not touch its findings',
    });
  });

  it('keeps an approval unless the delta touches a flagged file or is full', () => {
    const priors = [approved('review', ['src/a.ts']), approved('security', ['src/b.ts'])];
    const touchesA = selectAgentsForPush(agents, priors, delta([small('src/a.ts')]), 'full');
    expect(slugs(touchesA)).toEqual(['review']);

    const untouched = selectAgentsForPush(agents, priors, delta([small('src/c.ts')]), 'full');
    expect(slugs(untouched)).toEqual([]);

    const big = selectAgentsForPush(agents, priors, delta([small('src/c.ts', 500)]), 'full');
    expect(slugs(big)).toEqual(['review', 'security', 'a11y', 'o11y']);
  });

  it('matches a flagged file across a rename', () => {
    const priors = [approved('review', ['src/old.ts'])];
    const renamed: RiskFileEntry = {
      filename: 'src/new.ts',
      additions: 1,
      deletions: 1,
      previous_filename: 'src/old.ts',
    };
    expect(slugs(selectAgentsForPush(agents, priors, delta([renamed]), 'full'))).toEqual([
      'review',
    ]);
  });

  it('treats a comment verdict like an approval', () => {
    const priors: PriorReview[] = [{ agentSlug: 'review', verdict: 'comment', findingPaths: [] }];
    expect(slugs(selectAgentsForPush(agents, priors, delta([small('src/a.ts')]), 'full'))).toEqual(
      [],
    );
  });

  it('gives a legacy approval with no recorded paths another look only on a full delta', () => {
    const priors = [approved('review')];
    expect(slugs(selectAgentsForPush(agents, priors, delta([small('src/a.ts')]), 'full'))).toEqual(
      [],
    );
    expect(
      slugs(selectAgentsForPush(agents, priors, delta([small('src/auth.ts')]), 'full')),
    ).toEqual(['review', 'security', 'a11y', 'o11y']);
  });
});

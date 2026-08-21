import { describe, expect, it } from 'vite-plus/test';
import { isArtifactsPushedEvent, parseArtifactsEvent } from './artifacts-events.ts';

// Envelope shapes from the documented schema:
// developers.cloudflare.com/queues/event-subscriptions/events-schemas/
const PUSHED = {
  type: 'cf.artifacts.repo.pushed',
  source: { type: 'artifacts.repo', namespace: 'turbodiff-repos', repoName: 'acme--api' },
  payload: {
    ref: 'refs/heads/main',
    before: 'abc123def456abc123def456abc123def456abc1',
    after: 'def789ghi012def789ghi012def789ghi012def7',
    commits: [],
    totalCommitsCount: 1,
    commitsTruncated: false,
  },
  metadata: {
    accountId: 'f9f79265f388666de8122cfb508d7776',
    eventSubscriptionId: '1830c4bb612e43c3af7f4cada31fbf3f',
    eventSchemaVersion: 1,
    eventTimestamp: '2026-08-21T02:48:57.132Z',
  },
};

describe('parseArtifactsEvent', () => {
  it('parses a documented pushed event', () => {
    const event = parseArtifactsEvent(PUSHED);
    expect(event).not.toBeNull();
    if (!event || !isArtifactsPushedEvent(event)) throw new Error('expected pushed event');
    expect(event.namespace).toBe('turbodiff-repos');
    expect(event.repoName).toBe('acme--api');
    expect(event.ref).toBe('refs/heads/main');
    expect(event.after).toBe('def789ghi012def789ghi012def789ghi012def7');
    expect(event.eventTimestamp).toBe('2026-08-21T02:48:57.132Z');
  });

  it('parses a lifecycle event without a pushed payload', () => {
    const event = parseArtifactsEvent({
      type: 'cf.artifacts.repo.deleted',
      source: { type: 'artifacts', namespace: 'turbodiff-repos', repoName: 'acme--api' },
      payload: { repoId: '0tvugavnogssnwzk' },
      metadata: { eventTimestamp: '2026-08-21T00:00:00.000Z' },
    });
    expect(event).toEqual({
      type: 'cf.artifacts.repo.deleted',
      namespace: 'turbodiff-repos',
      repoName: 'acme--api',
      eventTimestamp: '2026-08-21T00:00:00.000Z',
    });
  });

  it('rejects a pushed event with a malformed payload rather than crashing', () => {
    expect(parseArtifactsEvent({ ...PUSHED, payload: { ref: 42 } })).toBeNull();
  });

  it('rejects non-artifacts and shapeless input', () => {
    expect(parseArtifactsEvent(null)).toBeNull();
    expect(parseArtifactsEvent('cf.artifacts.repo.pushed')).toBeNull();
    expect(
      parseArtifactsEvent({ type: 'cf.r2.bucket.created', source: { type: 'r2' } }),
    ).toBeNull();
    expect(parseArtifactsEvent({ type: 'cf.artifacts.repo.pushed', source: {} })).toBeNull();
  });
});

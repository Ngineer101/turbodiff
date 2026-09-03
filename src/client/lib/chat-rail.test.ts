import { describe, expect, it } from 'vite-plus/test';
import type { ApiChatMessage } from '../../shared/api-types.ts';
import {
  agoShort,
  chatLedger,
  clampRailWidth,
  commitUrl,
  dayLabel,
  fmtClock,
  fmtSpan,
  groupByDay,
  latestReplyId,
  pendingTurn,
  previousUserBody,
  quoteBlock,
  railRestWidth,
  suggestions,
  turnSteps,
  unreadReplies,
  withFileContext,
} from './chat-rail.ts';

const NOW = Date.parse('2026-09-03T12:00:00Z');

function msg(
  partial: Partial<ApiChatMessage> & { id: number; role: ApiChatMessage['role'] },
): ApiChatMessage {
  return {
    body: '',
    author: partial.role === 'user' ? 'nico' : null,
    status: 'done',
    outcome: null,
    commit_sha: null,
    error: null,
    created_at: '2026-09-03T11:00:00Z',
    ...partial,
  };
}

describe('clampRailWidth', () => {
  it('keeps the rail usable whatever the stored value', () => {
    expect(clampRailWidth(384)).toBe(384);
    expect(clampRailWidth(10)).toBe(320);
    expect(clampRailWidth(9000)).toBe(560);
    expect(clampRailWidth(Number.NaN)).toBe(384);
    expect(clampRailWidth(400.6)).toBe(401);
  });
});

describe('turn bookkeeping', () => {
  const history = [
    msg({ id: 1, role: 'user', body: 'first' }),
    msg({ id: 2, role: 'assistant', outcome: 'changed', commit_sha: 'abc' }),
    msg({ id: 3, role: 'user', body: 'second', status: 'running' }),
  ];

  it('finds the in-flight user turn', () => {
    expect(pendingTurn(history)?.id).toBe(3);
    expect(pendingTurn(history.slice(0, 2))).toBeNull();
  });

  it('counts replies newer than the last seen one, ignoring optimistic rows', () => {
    const withOptimistic = [...history, msg({ id: -5, role: 'user', status: 'queued' })];
    expect(latestReplyId(withOptimistic)).toBe(2);
    expect(unreadReplies(withOptimistic, 0)).toBe(1);
    expect(unreadReplies(withOptimistic, 2)).toBe(0);
  });

  it('describes the turn by what its status proves', () => {
    expect(turnSteps('queued').map((s) => s.state)).toEqual(['live']);
    expect(turnSteps('running').map((s) => s.state)).toEqual(['done', 'live']);
  });

  it('recalls the sender’s last message for ↑', () => {
    expect(previousUserBody(history, 'nico')).toBe('second');
    expect(previousUserBody(history, 'someone-else')).toBeNull();
    expect(previousUserBody(history, null)).toBe('second');
  });
});

describe('time formatting', () => {
  it('formats the working clock', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(38)).toBe('0:38');
    expect(fmtClock(605)).toBe('10:05');
    expect(fmtClock(3661)).toBe('1:01:01');
  });

  it('formats compact relative times', () => {
    expect(agoShort('2026-09-03T11:59:20Z', NOW)).toBe('40s');
    expect(agoShort('2026-09-03T11:46:00Z', NOW)).toBe('14m');
    expect(agoShort('2026-09-03T09:00:00Z', NOW)).toBe('3h');
    expect(agoShort('2026-08-30T12:00:00Z', NOW)).toBe('4d');
  });

  it('labels days relative to now and groups consecutive messages', () => {
    expect(dayLabel('2026-09-03T01:00:00Z', NOW)).toBe('Today');
    expect(dayLabel('2026-09-02T13:00:00Z', NOW)).toBe('Yesterday');
    expect(dayLabel('2026-08-20T13:00:00Z', NOW)).toBe('Aug 20');
    expect(dayLabel('2025-12-24T13:00:00Z', NOW)).toBe('Dec 24, 2025');
    const groups = groupByDay(
      [
        msg({ id: 1, role: 'user', created_at: '2026-09-02T10:00:00Z' }),
        msg({ id: 2, role: 'assistant', created_at: '2026-09-02T10:05:00Z' }),
        msg({ id: 3, role: 'user', created_at: '2026-09-03T10:00:00Z' }),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.messages.length])).toEqual([
      ['Yesterday', 2],
      ['Today', 1],
    ]);
  });

  it('formats the ledger span', () => {
    expect(fmtSpan(0)).toBe('1 min');
    expect(fmtSpan(41 * 60 + 20)).toBe('41 min');
    expect(fmtSpan(125 * 60)).toBe('2 h 05 min');
  });
});

describe('chatLedger', () => {
  it('totals turns, pushes, and failures across the conversation', () => {
    const ledger = chatLedger([
      msg({ id: 1, role: 'user', created_at: '2026-09-03T10:00:00Z' }),
      msg({ id: 2, role: 'assistant', outcome: 'changed', created_at: '2026-09-03T10:04:00Z' }),
      msg({ id: 3, role: 'user', created_at: '2026-09-03T10:10:00Z' }),
      msg({
        id: 4,
        role: 'assistant',
        outcome: 'tests_failed',
        created_at: '2026-09-03T10:20:00Z',
      }),
      msg({ id: 5, role: 'user', status: 'failed', created_at: '2026-09-03T10:41:00Z' }),
    ]);
    expect(ledger).toEqual({ turns: 3, pushes: 1, failures: 2, spanSeconds: 41 * 60 });
    expect(chatLedger([])).toEqual({ turns: 0, pushes: 0, failures: 0, spanSeconds: 0 });
  });
});

describe('composer text', () => {
  it('prefixes the viewed file as context', () => {
    expect(withFileContext('Add a test', 'src/http/api.ts')).toBe(
      '(Looking at `src/http/api.ts`)\n\nAdd a test',
    );
    expect(withFileContext('Add a test', null)).toBe('Add a test');
  });

  it('quotes every line and leaves room to reply', () => {
    expect(quoteBlock('one\ntwo\n')).toBe('> one\n> two\n\n');
  });

  it('links commits only where a commit page exists', () => {
    expect(commitUrl('acme/app', 'github', 'abc123')).toBe(
      'https://github.com/acme/app/commit/abc123',
    );
    expect(commitUrl('acme/app', 'artifacts', 'abc123')).toBeNull();
    expect(commitUrl('acme/app', 'github', null)).toBeNull();
  });

  it('suggests starting points from the PR state, three at most', () => {
    expect(suggestions({ activeFile: 'src/http/webhooks.ts', checksFailing: true })).toEqual([
      'Fix the failing check',
      'Add tests for webhooks.ts',
      'Explain what this PR changes',
    ]);
    expect(suggestions({ activeFile: null, checksFailing: false })).toHaveLength(3);
  });
});

describe('railRestWidth', () => {
  it('reserves the collapsed rail or the saved width before the rail mounts', () => {
    expect(railRestWidth('closed', '500')).toBe(48);
    expect(railRestWidth(null, null)).toBe(384);
    expect(railRestWidth('open', '500')).toBe(500);
    expect(railRestWidth('open', 'garbage')).toBe(384);
  });
});

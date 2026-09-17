import { describe, expect, it } from 'vite-plus/test';
import { pickReadTool, summariseReadReport } from '../../../src/paper-agent/read-report.ts';
import type { DesignReadReport } from '../../../src/paper-agent/types.ts';

describe('pickReadTool', () => {
  it('picks a read-only tool by name', () => {
    expect(pickReadTool([{ name: 'get_document' }])).toBe('get_document');
    expect(pickReadTool([{ name: 'listNodes' }])).toBe('listNodes');
    expect(pickReadTool([{ name: 'exportSelection' }])).toBe('exportSelection');
  });

  it('never picks a mutating tool, even when it contains a read-ish word', () => {
    expect(pickReadTool([{ name: 'create_frame' }, { name: 'updateNode' }])).toBeNull();
    // "getOrCreate" contains create -> denied.
    expect(pickReadTool([{ name: 'getOrCreateLayer' }])).toBeNull();
    expect(pickReadTool([{ name: 'deleteDocument' }])).toBeNull();
  });

  it('prefers the first safe tool and skips unsafe ones', () => {
    expect(pickReadTool([{ name: 'addText' }, { name: 'readCanvas' }])).toBe('readCanvas');
  });

  it('returns null when nothing matches', () => {
    expect(pickReadTool([{ name: 'ping' }])).toBeNull();
    expect(pickReadTool([])).toBeNull();
  });
});

describe('summariseReadReport', () => {
  const base: DesignReadReport = {
    paperUrl: 'https://app.paper.design/file/x/1-0',
    capturedAt: '2026-09-17T00:00:00.000Z',
    webMcp: { available: false, tools: [] },
    dom: { textSample: 'Page 1', textLength: 6 },
  };

  it('summarises an unauthenticated read (screenshot + dom, no webmcp)', () => {
    const line = summariseReadReport({ ...base, screenshot: 'https://x/s.png' });
    expect(line).toContain('screenshot captured');
    expect(line).toContain('dom text 6 chars');
    expect(line).toContain('webmcp unavailable');
  });

  it('summarises a webmcp read', () => {
    const line = summariseReadReport({
      ...base,
      screenshot: 'https://x/s.png',
      webMcp: {
        available: true,
        tools: ['get_document', 'add_text'],
        read: { tool: 'get_document', result: '{"nodes":3}' },
      },
    });
    expect(line).toContain('webmcp 2 tools');
    expect(line).toContain('read via get_document');
  });
});

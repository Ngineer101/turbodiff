import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createSkillsShClient, SkillsShApiError } from './client.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('skills.sh catalog client', () => {
  it('reports unconfigured and refuses requests without a token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = createSkillsShClient(undefined);

    expect(client.configured()).toBe(false);
    await expect(client.search('review')).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the bearer token to the skills.sh origin and normalizes entries', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        Response.json({
          skills: [
            {
              source: 'anthropics/skills',
              slug: 'pdf-forms',
              name: 'PDF Forms',
              description: 'Fill forms',
              installs: 42,
              unknown_field: true,
            },
            { slug: 'missing-source' },
          ],
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createSkillsShClient('secret');

    expect(client.configured()).toBe(true);
    await expect(client.search('pdf')).resolves.toEqual([
      {
        source: 'anthropics/skills',
        slug: 'pdf-forms',
        name: 'PDF Forms',
        description: 'Fill forms',
        installs: 42,
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://skills.sh/api/v1/skills/search?q=pdf&limit=30');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
  });

  it('maps a non-2xx response to a SkillsShApiError with a truncated body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(2000), { status: 500 })),
    );
    const client = createSkillsShClient('secret');

    await expect(client.leaderboard('trending')).rejects.toMatchObject({
      name: 'SkillsShApiError',
      status: 500,
      // The upstream body is truncated to 500 chars in the message.
      message: expect.stringMatching(/^skills\.sh API 500 on [^:]+: x{500}$/),
    });
  });

  it('returns null files/hash tolerantly on detail and null on a 404 audit', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ source: 'a/b', slug: 'c', name: 'C', files: null }),
        )
        .mockResolvedValueOnce(new Response('not found', { status: 404 })),
    );
    const client = createSkillsShClient('secret');

    await expect(client.detail('a/b', 'c')).resolves.toEqual({
      source: 'a/b',
      slug: 'c',
      name: 'C',
      description: null,
      installs: null,
      hash: null,
      files: null,
    });
    await expect(client.audit('a/b', 'c')).resolves.toBeNull();
  });

  it('normalizes audit verdict rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          audits: [
            { auditor: 'claude', verdict: 'pass', extra: 1 },
            { verdict: 'orphaned' },
          ],
        }),
      ),
    );
    const client = createSkillsShClient('secret');

    await expect(client.audit('a/b', 'c')).resolves.toEqual([
      { auditor: 'claude', verdict: 'pass' },
    ]);
  });
});

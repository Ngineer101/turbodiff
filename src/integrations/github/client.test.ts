import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { githubJson, githubPaginate } from './client.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub REST client', () => {
  it('applies authentication and protocol headers to JSON requests', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => Response.json({ login: 'octocat' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(githubJson<{ login: string }>('secret', '/user')).resolves.toEqual({
      login: 'octocat',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/user');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
    expect(new Headers(init?.headers).get('x-github-api-version')).toBe('2022-11-28');
  });

  it('follows absolute next links only on the GitHub API origin', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { repositories: [{ id: 1 }] },
          {
            headers: {
              link: '<https://api.github.com/user/repos?page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(Response.json({ repositories: [{ id: 2 }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      githubPaginate<{ repositories: { id: number }[] }, { id: number }>(
        'secret',
        '/user/repos?page=1',
        (page) => page.repositories,
      ),
    ).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/user/repos?page=2');
  });

  it('rejects pagination links that leave the GitHub API origin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([], {
          headers: { link: '<https://example.com/steal>; rel="next"' },
        }),
      ),
    );

    await expect(
      githubPaginate<unknown[], unknown>('secret', '/items', (page) => page),
    ).rejects.toThrow('unexpected origin');
  });

  it('fails explicitly instead of silently truncating bounded pagination', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([], {
          headers: { link: '<https://api.github.com/items?page=2>; rel="next"' },
        }),
      ),
    );

    await expect(
      githubPaginate<unknown[], unknown>('secret', '/items', (page) => page, { maxPages: 1 }),
    ).rejects.toThrow('exceeded 1 pages');
  });
});

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { RepositoryRow } from '../data/db.ts';
import { readFile } from './repo-browser.ts';

// readFile only reads owner/name off the row; the rest never leaves the DB
// layer in these tests.
const repo = { owner: 'octo', name: 'shop' } as RepositoryRow;

const BLOB_SHA = 'a0373c127e472633630c8da9f9440ae5bb4c9127';

// GitHub's documented rejection for 1–100 MB blobs on the contents API.
function tooLargeResponse(): Response {
  return Response.json(
    { message: 'This API returns blobs up to 1 MB in size.', errors: [{ code: 'too_large' }] },
    { status: 403 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readFile too_large fallback', () => {
  it('recovers a previewable file under the cap via git/blobs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tooLargeResponse())
      .mockResolvedValueOnce(
        Response.json([
          {
            name: 'screenshot.png',
            path: 'assets/screenshot.png',
            type: 'file',
            size: 2 * 1024 * 1024,
            sha: BLOB_SHA,
          },
        ]),
      )
      .mockResolvedValueOnce(
        // The blobs API wraps base64 with newlines, like the contents API.
        Response.json({ sha: BLOB_SHA, content: 'aGVs\nbG8=\n', encoding: 'base64' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(readFile('secret', repo, 'main', 'assets/screenshot.png')).resolves.toEqual({
      path: 'assets/screenshot.png',
      ref: 'main',
      sha: BLOB_SHA,
      size: 2 * 1024 * 1024,
      text: null,
      binary: true,
      too_large: false,
      content_base64: 'aGVsbG8=',
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.github.com/repos/octo/shop/contents/assets?ref=main',
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      `https://api.github.com/repos/octo/shop/git/blobs/${BLOB_SHA}`,
    );
  });

  it('keeps the notice for a previewable file over the cap without fetching the blob', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tooLargeResponse())
      .mockResolvedValueOnce(
        Response.json([
          {
            name: 'screenshot.png',
            path: 'assets/screenshot.png',
            type: 'file',
            size: 11 * 1024 * 1024,
            sha: BLOB_SHA,
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(readFile('secret', repo, 'main', 'assets/screenshot.png')).resolves.toEqual({
      path: 'assets/screenshot.png',
      ref: 'main',
      sha: '',
      size: 0,
      text: null,
      binary: false,
      too_large: true,
      content_base64: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the notice for a non-previewable path without extra requests', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tooLargeResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(readFile('secret', repo, 'main', 'logs/build.txt')).resolves.toEqual({
      path: 'logs/build.txt',
      ref: 'main',
      sha: '',
      size: 0,
      text: null,
      binary: false,
      too_large: true,
      content_base64: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the direct contents read untouched for files under 1 MB', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({
        name: 'screenshot.png',
        path: 'assets/screenshot.png',
        type: 'file',
        size: 4,
        sha: BLOB_SHA,
        content: 'iVBO\nRw==\n',
        encoding: 'base64',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(readFile('secret', repo, 'main', 'assets/screenshot.png')).resolves.toEqual({
      path: 'assets/screenshot.png',
      ref: 'main',
      sha: BLOB_SHA,
      size: 4,
      text: null,
      binary: true,
      too_large: false,
      content_base64: 'iVBORw==',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

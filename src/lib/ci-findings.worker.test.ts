/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { ciFailureFindings } from './ci-findings.ts';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ciFailureFindings', () => {
  it('returns null when none of the run jobs failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          jobs: [
            { id: 1, name: 'build', conclusion: 'success' },
            { id: 2, name: 'test', conclusion: 'success' },
          ],
        }),
      ),
    );

    expect(await ciFailureFindings('token', 'acme', 'api', 9001)).toBeNull();
  });

  it('bounds failed jobs, keeps each log tail, and preserves partial findings', async () => {
    const failedJobs = Array.from({ length: 6 }, (_, index) => ({
      id: index + 2,
      name: `failed-${index + 1}`,
      conclusion: 'failure',
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === 'https://api.github.com/repos/acme/api/actions/runs/9001/jobs?per_page=100') {
          return jsonResponse({
            jobs: [{ id: 1, name: 'passing', conclusion: 'success' }, ...failedJobs],
          });
        }
        if (url.endsWith('/actions/jobs/3/logs')) {
          return new Response('expired', { status: 404 });
        }
        const jobId = Number(url.match(/\/actions\/jobs\/(\d+)\/logs$/)?.[1]);
        if (jobId >= 2 && jobId <= 6) {
          return new Response(`discard-me-${jobId}\n${'x'.repeat(8_100)}\nTAIL-${jobId}`, {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const findings = await ciFailureFindings('token', 'acme', 'api', 9001);
    expect(findings?.match(/^### Job:/gm)).toHaveLength(5);
    expect(findings).toContain('### Job: failed-1');
    expect(findings).toContain('TAIL-2');
    expect(findings).not.toContain('discard-me-2');
    expect(findings).toContain('### Job: failed-2');
    expect(findings).toContain('_logs unavailable: GitHub API 404');
    expect(findings).toContain('### Job: failed-5');
    expect(findings).not.toContain('### Job: failed-6');
    expect(findings).not.toContain('### Job: passing');
  });
});

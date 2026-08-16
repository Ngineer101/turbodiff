/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it, vi } from 'vite-plus/test';
import { ciFailureFindings } from './ci-findings.ts';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

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

  it('returns markdown with each failed job name and a log tail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/actions/runs/9001/jobs')) {
          return jsonResponse({
            jobs: [
              { id: 1, name: 'build', conclusion: 'success' },
              { id: 2, name: 'test', conclusion: 'failure' },
            ],
          });
        }
        if (url.includes('/actions/jobs/2/logs')) {
          return new Response('...log output...\nError: test failed', { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const findings = await ciFailureFindings('token', 'acme', 'api', 9001);
    expect(findings).toContain('### Job: test');
    expect(findings).toContain('Error: test failed');
    expect(findings).not.toContain('### Job: build');
  });
});

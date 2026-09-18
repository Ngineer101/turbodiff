import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Fetch } from '@typesafe-ai/sdk';
import { classifyTaskComplexity } from '../../../../src/integrations/typesafe/task-complexity.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const mockFetch = (impl?: Fetch) => vi.fn<Fetch>(impl ?? (async () => new Response()));

const signals = {
  title: 'Add a task complexity classifier',
  requirements: 'Classify each task as trivial or standard before planning.',
  repositoryCount: 1,
  attachmentCount: 0,
};

function choiceResponse(choice: 'trivial' | 'standard', confidence: number): Response {
  return Response.json({
    model: 'jev-latest',
    answers: {
      tier: {
        type: 'choice',
        choice,
        confidence,
        probabilities: { trivial: choice === 'trivial' ? confidence : 1 - confidence, standard: 0 },
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

describe('classifyTaskComplexity', () => {
  it('returns null and makes no request when no API key is configured', async () => {
    const fetch = mockFetch();
    await expect(classifyTaskComplexity(signals, { apiKey: '  ', fetch })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('calls the TypeSafe systemone endpoint with bearer auth and returns the judged tier', async () => {
    const fetch = mockFetch(async () => choiceResponse('trivial', 0.92));

    await expect(classifyTaskComplexity(signals, { apiKey: 'test-key', fetch })).resolves.toBe(
      'trivial',
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
    expect(await new Request(url, init).json()).toMatchObject({
      state: { title: signals.title, repositoryCount: 1 },
      questions: { tier: { type: 'choice' } },
    });
  });

  it('applies the domain confidence floor: a low-confidence trivial answer is standard', async () => {
    const fetch = mockFetch(async () => choiceResponse('trivial', 0.3));
    await expect(classifyTaskComplexity(signals, { apiKey: 'test-key', fetch })).resolves.toBe(
      'standard',
    );
  });

  it('returns null when the API call fails so planning can fall back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = mockFetch(async () => Response.json({ error: 'bad request' }, { status: 400 }));
    await expect(
      classifyTaskComplexity(signals, { apiKey: 'test-key', fetch }),
    ).resolves.toBeNull();
  });
});

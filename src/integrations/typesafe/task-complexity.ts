import { choice, TypeSafeClient, type Fetch, type TypeSafeClientConfig } from '@typesafe-ai/sdk';
import type { PlanningTier } from '../../artifacts/plan.ts';
import {
  taskComplexityState,
  tierFromComplexityChoice,
  type TaskComplexitySignals,
} from '../../domain/task-complexity.ts';

// Provider mechanics for the task-complexity judgment: build the Jev question,
// call the TypeSafe API, and hand the answer to the domain for interpretation.
// The tier policy (confidence floor, safe default) stays in the domain.

export interface ComplexityClassifierConfig {
  /** TypeSafe API key. When absent or blank the classifier is disabled. */
  apiKey: string | undefined;
  /** API root override; defaults to the SDK's `https://api.typesafe.ai`. */
  baseURL?: string;
  /** Model override; defaults to the SDK's `jev-latest`. */
  model?: string;
  /** Custom fetch, primarily for tests. */
  fetch?: Fetch;
  /** Per-attempt timeout; kept short so the judgment never stalls planning. */
  timeoutMs?: number;
}

// The classifier is best-effort and off the critical path, so bound its latency:
// a short timeout and a single retry, then fall back to the caller's default.
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 1;

function complexityQuestions() {
  return {
    tier: choice(
      'How much planning and investigation does this software task need before it can be implemented?',
      {
        trivial:
          'A small, localized change — editing a few existing files, with no new subsystem, no database schema or public API change, and no cross-cutting design decision.',
        standard:
          'Anything larger or less certain — new subsystems, schema or API changes, work spanning several areas or repositories, or ambiguity that needs investigation and clarifying questions.',
      },
    ),
  };
}

/**
 * Classify how much planning a task needs using TypeSafe's Jev model.
 *
 * Returns the judged tier, or `null` when the classifier is unconfigured (no API
 * key) or the call fails. Callers fall back to their default tier so a classifier
 * outage never blocks planning.
 */
export async function classifyTaskComplexity(
  signals: TaskComplexitySignals,
  config: ComplexityClassifierConfig,
): Promise<PlanningTier | null> {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) return null;

  const clientConfig: TypeSafeClientConfig = { apiKey };
  if (config.baseURL) clientConfig.baseURL = config.baseURL;
  if (config.model) clientConfig.defaultModel = config.model;
  if (config.fetch) clientConfig.fetch = config.fetch;
  const client = new TypeSafeClient(clientConfig);

  try {
    const { answers } = await client.systemOne(
      { state: taskComplexityState(signals), questions: complexityQuestions() },
      { timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, retry: { maxRetries: MAX_RETRIES } },
    );
    return tierFromComplexityChoice(answers.tier);
  } catch (error) {
    console.error('turbodiff: task-complexity classification failed; using default tier', error);
    return null;
  }
}

import { env } from 'cloudflare:workers';
import { resolveRunnerModel } from '../../data/models.ts';
import { isJsonObject, parseJson, type JsonObject } from '../../shared/json.ts';
import {
  AI_GATEWAY_GRANT_TTL_MS,
  createAiGatewayGrant,
} from '../../integrations/security/ai-gateway-grant.ts';

export type RunnerAuthMode = 'claude_subscription' | 'gateway';

export interface RunnerAuth {
  mode: 'gateway';
  // Secrets: callers must redact these from surfaced output.
  vars: Record<string, string>;
  // Provider/model id understood by Cloudflare AI Gateway's unified catalog.
  model: string;
}

export async function resolveRunnerAuth(
  requested?: RunnerAuthMode,
  model?: string | null,
): Promise<RunnerAuth> {
  if (requested === 'claude_subscription') {
    throw new Error(
      'claude_subscription runner mode is no longer supported; configure the model-neutral AI Gateway runner',
    );
  }
  const accountId = (env.AI_GATEWAY_ACCOUNT_ID ?? '').trim();
  const gatewayId = (env.AI_GATEWAY_ID ?? '').trim();
  if (!accountId || !(env.AI_GATEWAY_API_TOKEN ?? '').trim() || !gatewayId) {
    throw new Error(
      'gateway runner requires AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, and the AI_GATEWAY_API_TOKEN secret',
    );
  }
  const normalizedModel = normalizeRunnerModel(model ?? (await resolveRunnerModel()));
  return {
    mode: 'gateway',
    vars: {
      TURBODIFF_AI_GATEWAY_GRANT: await createAiGatewayGrant(
        env.AI_GATEWAY_API_TOKEN,
        normalizedModel,
        Date.now() + AI_GATEWAY_GRANT_TTL_MS,
      ),
    },
    model: normalizedModel,
  };
}

// Stored runner ids now use provider/model. Keep accepting the old bare
// Anthropic ids so in-flight Workflow state and pre-migration rows can finish.
export function normalizeRunnerModel(model: string): string {
  let selected = model.trim();
  if (!selected) throw new Error('runner model is required');
  if (selected.startsWith('cloudflare-ai-gateway/')) {
    selected = selected.slice('cloudflare-ai-gateway/'.length);
  }
  if (selected.startsWith('cloudflare/')) selected = selected.slice('cloudflare/'.length);
  if (selected.startsWith('workers-ai/@cf/')) selected = selected.slice('workers-ai/'.length);
  if (!selected.includes('/')) selected = `anthropic/${selected}`;
  if (selected === 'anthropic/claude-fable-5-1') return 'anthropic/claude-fable-5.1';
  if (selected === 'anthropic/claude-haiku-4-5-20251001') return 'anthropic/claude-haiku-4.5';
  return selected;
}

function runnerConfig(auth: RunnerAuth, extensionJson?: string): string {
  let extension: JsonObject = {};
  if (extensionJson) {
    const parsed = parseJson(extensionJson);
    if (!isJsonObject(parsed)) throw new Error('runner config extension must be a JSON object');
    extension = parsed;
  }
  const existingProvider = isJsonObject(extension.provider) ? extension.provider : {};
  const configuredGateway = isJsonObject(existingProvider['cloudflare-ai-gateway'])
    ? existingProvider['cloudflare-ai-gateway']
    : {};
  const existingModels = isJsonObject(configuredGateway.models) ? configuredGateway.models : {};
  const existingOptions = isJsonObject(configuredGateway.options) ? configuredGateway.options : {};
  const modelProvider = auth.model.startsWith('openai/')
    ? '@ai-sdk/openai'
    : auth.model.startsWith('anthropic/')
      ? '@ai-sdk/anthropic'
      : '@ai-sdk/openai-compatible';
  return JSON.stringify({
    ...extension,
    $schema: 'https://opencode.ai/config.json',
    share: 'disabled',
    enabled_providers: ['cloudflare-ai-gateway'],
    provider: {
      ...existingProvider,
      'cloudflare-ai-gateway': {
        ...configuredGateway,
        options: {
          ...existingOptions,
          apiKey: '{env:TURBODIFF_AI_GATEWAY_GRANT}',
          baseURL: `${env.PUBLIC_BASE_URL}/ai-proxy/v1`,
        },
        models: {
          ...existingModels,
          [auth.model]: { name: auth.model, provider: { npm: modelProvider } },
        },
      },
    },
  });
}

export function runnerEnvironment(
  auth: RunnerAuth,
  extra: Record<string, string> = {},
  configExtensionJson?: string,
) {
  return {
    ...auth.vars,
    TURBODIFF_RUNNER_MODEL: `cloudflare-ai-gateway/${auth.model}`,
    OPENCODE_CONFIG_CONTENT: runnerConfig(auth, configExtensionJson),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_TERMINAL_TITLE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    // Repository-owned OpenCode config/plugins are untrusted harness code.
    // AGENTS.md and mounted Agent Skills remain discoverable independently.
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_CLIENT: 'turbodiff',
    CI: 'true',
    ...extra,
  };
}

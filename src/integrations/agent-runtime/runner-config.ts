import { isJsonObject, parseJson, type JsonObject } from '../../shared/json.ts';

export interface RunnerAuth {
  baseURL: string;
  // Secrets: callers must redact these from surfaced output.
  vars: Record<string, string>;
  // Provider/model id understood by Cloudflare AI Gateway's unified catalog.
  model: string;
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
          baseURL: auth.baseURL,
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

import { Context, Effect, Layer } from 'effect';
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  updateIntegration,
  updateIntegrationAuth,
  type IntegrationRow,
} from '../../../data/integrations.ts';
import { encryptionConfigured, sealToken } from '../../../integrations/security/crypto.ts';
import { testHttpApiEndpoint } from '../../../integrations/http-api/client.ts';
import { resolveIntegrationAuth } from '../../../application/integrations/credentials.ts';
import { mcpIntegrationConfig } from '../../../integrations/mcp/credentials.ts';
import { testMcpEndpoint } from '../../../integrations/mcp/client.ts';
import { isJsonObject, isString, type JsonObject } from '../../../shared/json.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  CreateIntegration,
  Integration,
  IntegrationCollection,
  IntegrationTest,
  UpdateIntegration,
} from '../../contract/integrations.ts';
import { badRequest, conflict, notFound, type DomainError } from '../../contract/errors.ts';
import { dataEffect, requireOrganizationWrite } from '../authorization.ts';

export interface IntegrationOperations {
  readonly list: (user: CurrentUserIdentity) => Effect.Effect<IntegrationCollection, DomainError>;
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<Integration, DomainError>;
  readonly create: (
    user: CurrentUserIdentity,
    input: CreateIntegration,
  ) => Effect.Effect<Integration, DomainError>;
  readonly update: (
    user: CurrentUserIdentity,
    id: number,
    input: UpdateIntegration,
  ) => Effect.Effect<Integration, DomainError>;
  readonly remove: (user: CurrentUserIdentity, id: number) => Effect.Effect<void, DomainError>;
  readonly test: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<IntegrationTest, DomainError>;
}
export class IntegrationService extends Context.Tag('Turbodiff/IntegrationService')<
  IntegrationService,
  IntegrationOperations
>() {}

const serialize = (row: IntegrationRow): Integration => ({
  id: row.id,
  organizationId: row.organization_id,
  kind: row.kind,
  provider: row.provider,
  name: row.name,
  externalAccountId: row.external_account_id,
  config: row.config,
  hasCredentials: row.auth_ciphertext !== null,
  needsReauthorization: row.needs_reauthorization,
  authorizationStatus:
    isJsonObject(row.config) && row.config.authType === 'oauth'
      ? row.needs_reauthorization
        ? 'needs_reauth'
        : !row.auth_ciphertext || !row.auth_expires_at
          ? 'not_connected'
          : new Date(row.auth_expires_at).getTime() <= Date.now()
            ? 'expired'
            : 'connected'
      : null,
  enabled: row.enabled,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const integrationUrl = (row: IntegrationRow): string => {
  if (!isJsonObject(row.config) || !isString(row.config.url) || !row.config.url) {
    throw new Error('Integration URL is missing');
  }
  return row.config.url;
};

const validEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    );
  } catch {
    return false;
  }
};

const validateConfig = (
  kind: IntegrationRow['kind'],
  config: JsonObject,
  credential: string | undefined,
): string | null => {
  if (kind !== 'mcp' && kind !== 'api') return null;
  const url = config.url;
  if (!isString(url) || !validEndpoint(url)) return 'Endpoint must be an HTTPS URL';
  const authType = config.authType;
  if (
    authType !== 'none' &&
    authType !== 'bearer' &&
    authType !== 'api_key' &&
    authType !== 'client_credentials' &&
    authType !== 'oauth'
  ) {
    return 'Unknown integration auth type';
  }
  if (authType === 'oauth' && kind !== 'mcp') return 'OAuth is only available for MCP integrations';
  if (authType !== 'none' && !encryptionConfigured()) {
    return 'Credential storage is not configured';
  }
  if (authType !== 'none' && authType !== 'oauth' && !credential) {
    return 'The selected auth type requires a credential';
  }
  if (authType === 'api_key' && (!isString(config.headerName) || !config.headerName.trim())) {
    return 'API key auth requires a header name';
  }
  if (authType === 'client_credentials') {
    if (!isString(config.clientId) || !config.clientId.trim()) {
      return 'Client credentials auth requires a client id';
    }
    if (!isString(config.tokenEndpoint) || !validEndpoint(config.tokenEndpoint)) {
      return 'Client credentials auth requires an HTTPS token endpoint';
    }
  }
  return null;
};

const testResult = async (row: IntegrationRow): Promise<IntegrationTest> => {
  try {
    const auth = await resolveIntegrationAuth(row);
    const result =
      row.kind === 'mcp'
        ? await testMcpEndpoint(mcpIntegrationConfig(row).url, auth ?? undefined)
        : await testHttpApiEndpoint(integrationUrl(row), auth ?? undefined);
    const tools = 'tools' in result && Array.isArray(result.tools) ? result.tools : [];
    const authorizationRejected = result.status === 401 || result.status === 403;
    return {
      ok: result.ok,
      detail: result.detail,
      tools,
      reauthorizationRequired: row.needs_reauthorization || authorizationRejected,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'The integration could not be tested',
      tools: [],
      reauthorizationRequired: row.needs_reauthorization,
    };
  }
};

export const IntegrationServiceLive = Layer.succeed(IntegrationService, {
  list: (user) =>
    dataEffect(() => listIntegrations(user.organizationIds)).pipe(
      Effect.map((items) => ({ items: items.map(serialize) })),
      Effect.map((result) => ({ ...result, credentialStorageConfigured: encryptionConfigured() })),
    ),
  get: (user, id) =>
    dataEffect(() => getIntegration(id)).pipe(
      Effect.flatMap((row) =>
        row && user.organizationIds.includes(row.organization_id)
          ? Effect.succeed(serialize(row))
          : Effect.fail(notFound('Unknown integration')),
      ),
    ),
  create: (user, input) =>
    Effect.gen(function* () {
      yield* requireOrganizationWrite(user, input.organizationId);
      const name = input.name.trim();
      const provider = input.provider.trim();
      const rawConfig = input.config ?? {};
      const config: JsonObject | null = isJsonObject(rawConfig) ? rawConfig : null;
      if (!name || !provider)
        return yield* Effect.fail(badRequest('Name and provider are required'));
      if (!config)
        return yield* Effect.fail(badRequest('Integration config must be a JSON object'));
      const credential = input.credential?.trim();
      const configError = validateConfig(input.kind, config, credential);
      if (configError) return yield* Effect.fail(badRequest(configError));
      if (
        (yield* dataEffect(() => listIntegrations([input.organizationId]))).some(
          (item) => item.name === name,
        )
      )
        return yield* Effect.fail(conflict('Integration name already exists'));
      const authCiphertext = credential ? yield* dataEffect(() => sealToken(credential)) : null;
      return serialize(
        yield* dataEffect(() =>
          createIntegration({
            organizationId: input.organizationId,
            kind: input.kind,
            provider,
            name,
            externalAccountId: input.externalAccountId,
            config,
            authCiphertext,
          }),
        ),
      );
    }),
  update: (user, id, input) =>
    Effect.gen(function* () {
      const row = yield* dataEffect(() => getIntegration(id));
      if (!row || !user.organizationIds.includes(row.organization_id))
        return yield* Effect.fail(notFound('Unknown integration'));
      yield* requireOrganizationWrite(user, row.organization_id);
      const config: JsonObject | null =
        input.config === undefined
          ? isJsonObject(row.config)
            ? row.config
            : null
          : isJsonObject(input.config)
            ? input.config
            : null;
      if (!config)
        return yield* Effect.fail(badRequest('Integration config must be a JSON object'));
      const name = input.name?.trim() ?? row.name;
      if (!name) return yield* Effect.fail(badRequest('Name is required'));
      yield* dataEffect(() =>
        updateIntegration(id, { name, config, enabled: input.enabled ?? row.enabled }),
      );
      if (input.credential !== undefined) {
        const credential = input.credential?.trim();
        yield* dataEffect(async () =>
          updateIntegrationAuth(id, credential ? await sealToken(credential) : null, null, false),
        );
      }
      const updated = yield* dataEffect(() => getIntegration(id));
      if (!updated) return yield* Effect.fail(notFound('Unknown integration'));
      return serialize(updated);
    }),
  remove: (user, id) =>
    Effect.gen(function* () {
      const row = yield* dataEffect(() => getIntegration(id));
      if (!row || !user.organizationIds.includes(row.organization_id))
        return yield* Effect.fail(notFound('Unknown integration'));
      yield* requireOrganizationWrite(user, row.organization_id);
      yield* dataEffect(() => deleteIntegration(id));
    }),
  test: (user, id) =>
    dataEffect(() => getIntegration(id)).pipe(
      Effect.flatMap((row) =>
        row && user.organizationIds.includes(row.organization_id)
          ? Effect.promise(() => testResult(row))
          : Effect.fail(notFound('Unknown integration')),
      ),
    ),
} satisfies IntegrationOperations);

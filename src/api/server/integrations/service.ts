import { Context, Effect, Layer } from 'effect';
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  updateIntegration,
  updateIntegrationAuth,
  type IntegrationRow,
} from '../../../data/db.ts';
import { sealToken } from '../../../integrations/security/crypto.ts';
import { isJsonObject, type JsonObject } from '../../../shared/json.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  CreateIntegration,
  Integration,
  IntegrationCollection,
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
  enabled: row.enabled,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const IntegrationServiceLive = Layer.succeed(IntegrationService, {
  list: (user) =>
    dataEffect(() => listIntegrations(user.organizationIds)).pipe(
      Effect.map((items) => ({ items: items.map(serialize) })),
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
      if (
        (yield* dataEffect(() => listIntegrations([input.organizationId]))).some(
          (item) => item.name === name,
        )
      )
        return yield* Effect.fail(conflict('Integration name already exists'));
      const authCiphertext = input.credential?.trim()
        ? yield* dataEffect(() => sealToken(input.credential!.trim()))
        : null;
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
} satisfies IntegrationOperations);

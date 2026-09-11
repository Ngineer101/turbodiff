import { Context, Effect, Either, Layer } from 'effect';
import {
  createConnection,
  deleteConnection,
  getConnection,
  getRepoById,
  listConnections,
  listInstallationsWithRepos,
  listRepoConnectionLinks,
  setRepoConnectionLink,
  updateConnectionAuth,
  type ConnectionRow,
} from '../../../data/db.ts';
import {
  encryptionConfigured,
  sealJson,
  sealToken,
} from '../../../integrations/security/crypto.ts';
import {
  ConnectionAuthError,
  connectionSnapshot,
  oauthStatus,
} from '../../../integrations/connections/credentials.ts';
import { capabilityDenied } from '../../../application/auth/access-control.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  Connection,
  ConnectionCollection,
  ConnectionTest,
  CreateConnection,
  RepositoryConnection,
} from '../../contract/connections.ts';
import {
  badRequest,
  forbidden,
  internalServerError,
  notFound,
  type DomainError,
} from '../../contract/errors.ts';
import { ApiDependencies } from '../context.ts';

export interface ConnectionOperations {
  readonly list: (user: CurrentUserIdentity) => Effect.Effect<ConnectionCollection, DomainError>;
  readonly create: (
    user: CurrentUserIdentity,
    input: CreateConnection,
  ) => Effect.Effect<Connection, DomainError>;
  readonly remove: (user: CurrentUserIdentity, id: number) => Effect.Effect<void, DomainError>;
  readonly test: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<ConnectionTest, DomainError>;
  readonly setRepository: (
    user: CurrentUserIdentity,
    connectionId: number,
    repositoryId: number,
    input: RepositoryConnection,
  ) => Effect.Effect<RepositoryConnection, DomainError>;
}

export class ConnectionService extends Context.Tag('Turbodiff/ConnectionService')<
  ConnectionService,
  ConnectionOperations
>() {}

const operation = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      console.error('turbodiff: Effect connection operation failed', error);
      return internalServerError();
    },
  });

const validUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    );
  } catch {
    return false;
  }
};

export const ConnectionServiceLive = Layer.effect(
  ConnectionService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const authorized = (user: CurrentUserIdentity, id: number) =>
      operation(() => getConnection(id)).pipe(
        Effect.flatMap((connection) =>
          connection && user.installationIds.includes(connection.installation_id)
            ? Effect.succeed(connection)
            : Effect.fail(notFound('Unknown connection')),
        ),
      );

    const requireSettings = (user: CurrentUserIdentity, installationId: number) =>
      operation(() =>
        capabilityDenied(user, installationId, 'settings', dependencies.orgAdmin),
      ).pipe(Effect.flatMap((denial) => (denial ? Effect.fail(forbidden(denial)) : Effect.void)));

    const serialize = (
      connection: ConnectionRow,
      links: readonly {
        repository_id: number;
        connection_id: number;
        reviews: boolean;
        automations: boolean;
      }[],
    ): Connection => {
      const snapshot = connectionSnapshot(connection);
      // SAFETY: connections.kind is protected by a database CHECK constraint.
      const kind = connection.kind as Connection['kind'];
      // SAFETY: connections.auth_type is protected by a database CHECK constraint.
      const authType = connection.auth_type as Connection['authType'];
      return {
        id: connection.id,
        installationId: connection.installation_id,
        name: connection.name,
        kind,
        url: connection.url,
        tools: snapshot.tools ?? null,
        hasAuth: connection.auth_type !== 'none',
        authType,
        oauthStatus: oauthStatus(connection),
        repositories: links
          .filter((link) => link.connection_id === connection.id)
          .map((link) => ({
            repositoryId: link.repository_id,
            reviews: link.reviews,
            automations: link.automations,
          })),
      };
    };

    return {
      list: (user) =>
        Effect.gen(function* () {
          const [groups, connections, links] = yield* operation(() =>
            Promise.all([
              listInstallationsWithRepos(user.installationIds),
              listConnections(user.installationIds),
              listRepoConnectionLinks(user.installationIds),
            ]),
          );
          return {
            encryptionConfigured: encryptionConfigured(),
            installations: groups.map(({ installation }) => ({
              id: installation.id,
              accountLogin: installation.account_login,
            })),
            repositories: groups.flatMap(({ repos }) =>
              repos
                .filter((repository) => repository.enabled)
                .map((repository) => ({
                  id: repository.id,
                  installationId: repository.installation_id,
                  owner: repository.owner,
                  name: repository.name,
                })),
            ),
            items: connections.map((connection) => serialize(connection, links)),
          };
        }),
      create: (user, input) =>
        Effect.gen(function* () {
          const name = input.name.trim().toLowerCase();
          const url = input.url.trim();
          if (!user.installationIds.includes(input.installationId)) {
            return yield* Effect.fail(notFound('Unknown installation'));
          }
          if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name)) {
            return yield* Effect.fail(
              badRequest('name must be 1-31 chars: lowercase letters, digits, dashes, underscores'),
            );
          }
          if (!validUrl(url))
            return yield* Effect.fail(badRequest('endpoint must be an https:// URL'));
          if (input.authType !== 'none' && !encryptionConfigured()) {
            return yield* Effect.fail(badRequest('Credential storage is not configured'));
          }
          if (input.authType === 'bearer' && !input.token?.trim()) {
            return yield* Effect.fail(badRequest('bearer auth needs a token'));
          }
          if (
            input.authType === 'api_key' &&
            (!input.headerName?.trim() || !input.headerValue?.trim())
          ) {
            return yield* Effect.fail(badRequest('api_key auth needs a header name and value'));
          }
          if (
            input.authType === 'client_credentials' &&
            (!input.clientId?.trim() || !input.clientSecret?.trim() || !input.tokenEndpoint?.trim())
          ) {
            return yield* Effect.fail(
              badRequest('client_credentials auth needs clientId, clientSecret, and tokenEndpoint'),
            );
          }
          if (input.tokenEndpoint && !validUrl(input.tokenEndpoint)) {
            return yield* Effect.fail(badRequest('tokenEndpoint must be an https:// URL'));
          }
          if (input.authType === 'oauth' && input.kind !== 'mcp') {
            return yield* Effect.fail(badRequest('OAuth is only available for MCP connections'));
          }
          const existing = yield* operation(() => listConnections([input.installationId]));
          if (existing.some((connection) => connection.name === name)) {
            return yield* Effect.fail(badRequest(`A connection named "${name}" already exists`));
          }
          yield* requireSettings(user, input.installationId);

          let authCiphertext: string | null = null;
          let authConfigCiphertext: string | null = null;
          if (input.authType === 'bearer') {
            authCiphertext = yield* operation(() => sealToken(input.token!.trim()));
          } else if (input.authType === 'api_key') {
            authConfigCiphertext = yield* operation(() =>
              sealJson({
                headerName: input.headerName!.trim(),
                headerValue: input.headerValue!.trim(),
              }),
            );
          } else if (input.authType === 'client_credentials') {
            authConfigCiphertext = yield* operation(() =>
              sealJson({
                clientId: input.clientId!.trim(),
                clientSecret: input.clientSecret!.trim(),
                tokenEndpoint: input.tokenEndpoint!.trim(),
                scope: input.scope?.trim() || undefined,
              }),
            );
          }
          yield* operation(() =>
            createConnection({
              installationId: input.installationId,
              name,
              kind: input.kind,
              url,
              toolAllowlist:
                input.tools.length > 0
                  ? input.tools.map((tool) => tool.trim()).filter(Boolean)
                  : null,
              authCiphertext,
              authType: input.authType,
              authConfigCiphertext,
            }),
          );
          const created = (yield* operation(() => listConnections([input.installationId]))).find(
            (connection) => connection.name === name,
          );
          if (!created) return yield* Effect.fail(internalServerError());
          return serialize(created, []);
        }),
      remove: (user, id) =>
        Effect.gen(function* () {
          const connection = yield* authorized(user, id);
          yield* requireSettings(user, connection.installation_id);
          yield* operation(() => deleteConnection(connection.id));
        }),
      test: (user, id) =>
        Effect.gen(function* () {
          const connection = yield* authorized(user, id);
          const resolvedAuth = yield* Effect.either(
            Effect.tryPromise({
              try: () => dependencies.resolveConnectionAuth(connection),
              catch: (error) => error,
            }),
          );
          if (Either.isLeft(resolvedAuth)) {
            const error = resolvedAuth.left;
            if (error instanceof ConnectionAuthError) {
              return {
                ok: false,
                detail: error.message,
                tools: [],
                reauthorizationRequired: error.reason === 'reauth_required',
              };
            }
            console.error(`turbodiff: connection ${connection.id} credentials failed`, error);
            return {
              ok: false,
              detail: 'The connection could not be verified because of an internal error',
              tools: [],
              reauthorizationRequired: false,
            };
          }
          const auth = resolvedAuth.right;
          if (connection.kind === 'api') {
            const fetched = yield* Effect.either(
              Effect.tryPromise({
                try: () =>
                  fetch(connection.url, {
                    headers: auth ? { [auth.headerName]: auth.headerValue } : undefined,
                  }),
                catch: (error) => error,
              }),
            );
            if (Either.isLeft(fetched)) {
              return {
                ok: false,
                detail: 'The connection could not be reached',
                tools: [],
                reauthorizationRequired: false,
              };
            }
            return {
              ok: fetched.right.ok,
              detail: `HTTP ${fetched.right.status} ${fetched.right.statusText}`,
              tools: [],
              reauthorizationRequired: false,
            };
          }
          const result = yield* operation(() =>
            dependencies.testMcpEndpoint(connection.url, auth ?? undefined),
          );
          if (
            connection.auth_type === 'oauth' &&
            (result.status === 401 || result.status === 403)
          ) {
            dependencies.defer(
              updateConnectionAuth(connection.id, { oauthNeedsReauth: true }).catch((error) =>
                console.error(`turbodiff: could not flag connection ${connection.id}`, error),
              ),
            );
            return {
              ok: false,
              detail: 'The connection rejected its OAuth authorization; reconnect it to continue',
              tools: [],
              reauthorizationRequired: true,
            };
          }
          return {
            ok: result.ok,
            detail: result.detail,
            tools: result.tools ?? [],
            reauthorizationRequired: false,
          };
        }),
      setRepository: (user, connectionId, repositoryId, input) =>
        Effect.gen(function* () {
          const connection = yield* authorized(user, connectionId);
          yield* requireSettings(user, connection.installation_id);
          if (connection.kind !== 'mcp') {
            return yield* Effect.fail(badRequest('Only MCP connections attach to repositories'));
          }
          const repository = yield* operation(() => getRepoById(repositoryId));
          if (!repository || repository.installation_id !== connection.installation_id) {
            return yield* Effect.fail(notFound('Unknown repository'));
          }
          yield* operation(() => setRepoConnectionLink(repository.id, connection.id, input));
          return input;
        }),
    } satisfies ConnectionOperations;
  }),
);

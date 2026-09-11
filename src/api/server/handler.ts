import { HttpApiBuilder, HttpApp, HttpServer } from '@effect/platform';
import { env, waitUntil } from 'cloudflare:workers';
import { Effect, Layer, Scope } from 'effect';
import { AppApi } from '../contract/api.ts';
import {
  requireUser,
  userCanPushToRepo,
  userIsGithubOrgAdmin,
} from '../../application/auth/session.ts';
import { enqueueFactoryMessage } from '../../application/factory/queue.ts';
import { resolveConnectionAuth } from '../../integrations/connections/credentials.ts';
import { testMcpEndpoint } from '../../integrations/mcp/client.ts';
import { createSkillsShClient } from '../../integrations/skills-sh/client.ts';
import { AutomationsHandlers } from './automations/handlers.ts';
import { AutomationServiceLive } from './automations/service.ts';
import { SessionAuthLive } from './auth.ts';
import { PlatformHandlers } from './platform/handlers.ts';
import { PlatformServiceLive } from './platform/service.ts';
import { AgentsHandlers } from './agents/handlers.ts';
import { AgentServiceLive } from './agents/service.ts';
import { ConnectionsHandlers } from './connections/handlers.ts';
import { ConnectionServiceLive } from './connections/service.ts';
import { RepositoriesHandlers } from './repositories/handlers.ts';
import { RepositoryServiceLive } from './repositories/service.ts';
import { WorkItemsHandlers } from './work-items/handlers.ts';
import { WorkItemServiceLive } from './work-items/service.ts';
import { SkillsHandlers } from './skills/handlers.ts';
import { SkillServiceLive } from './skills/service.ts';
import { ChangesHandlers } from './changes/handlers.ts';
import { ChangeServiceLive } from './changes/service.ts';
import { OrganizationsHandlers } from './organizations/handlers.ts';
import { OrganizationServiceLive } from './organizations/service.ts';
import { ReportingHandlers } from './reporting/handlers.ts';
import { ReportingServiceLive } from './reporting/service.ts';
import { DeliveriesHandlers } from './deliveries/handlers.ts';
import { DeliveryServiceLive } from './deliveries/service.ts';
import { dispatchExplain } from '../../ai/explain/dispatch.ts';
import { ApiDependencies, type ApiRuntimeDependencies } from './context.ts';

/**
 * Build the Effect runtime synchronously and eagerly.
 *
 * Effect's stock layered web adapter initializes its Layer on the first
 * request. In workerd, aborting that cold request can interrupt the shared
 * initialization fiber and leave the isolate with a permanently unresolved
 * handler. All layers here are data-free, so constructing the runtime during
 * module evaluation avoids request-owned initialization and keeps database
 * I/O inside the request fiber.
 */
export function createEffectApiHandler() {
  const defer = (promise: Promise<void>) => {
    try {
      waitUntil(promise);
    } catch {
      // Direct Hono/Vitest calls do not have a Worker invocation context.
      // The work has already started; consume a rejection just like the
      // production waitUntil path does.
      void promise.catch(() => {});
    }
  };
  const dependencies: ApiRuntimeDependencies = {
    authenticate: requireUser,
    orgAdmin: userIsGithubOrgAdmin,
    enqueueFactory: enqueueFactoryMessage,
    defer,
    // Deployment-managed variables are genuinely absent in a fresh local
    // environment even though generated Worker bindings model them as
    // strings. Keep that absence at the configuration boundary: API
    // contracts always receive strings and use '' for an unconfigured
    // optional integration.
    githubAppSlug: env.GITHUB_APP_SLUG,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    resolveConnectionAuth: resolveConnectionAuth,
    testMcpEndpoint: testMcpEndpoint,
    canPushToRepo: userCanPushToRepo,
    skillsSh: createSkillsShClient(env.SKILLS_SH_API_TOKEN),
    dispatchExplain: dispatchExplain,
  };
  const DependenciesLive = Layer.succeed(ApiDependencies, dependencies);
  const ServicesLive = Layer.mergeAll(
    AutomationServiceLive,
    PlatformServiceLive,
    AgentServiceLive,
    ConnectionServiceLive,
    RepositoryServiceLive,
    WorkItemServiceLive,
    SkillServiceLive,
    ChangeServiceLive,
    OrganizationServiceLive,
    ReportingServiceLive,
    DeliveryServiceLive,
  ).pipe(Layer.provide(DependenciesLive));
  const HandlersLive = Layer.mergeAll(
    AutomationsHandlers,
    PlatformHandlers,
    AgentsHandlers,
    ConnectionsHandlers,
    RepositoriesHandlers,
    WorkItemsHandlers,
    SkillsHandlers,
    ChangesHandlers,
    OrganizationsHandlers,
    ReportingHandlers,
    DeliveriesHandlers,
  ).pipe(Layer.provide(ServicesLive));
  const AuthLive = SessionAuthLive.pipe(Layer.provide(DependenciesLive));
  const ApiLive = HttpApiBuilder.api(AppApi).pipe(
    Layer.provide(HandlersLive),
    Layer.provide(AuthLive),
  );
  const MainLive = Layer.mergeAll(
    ApiLive,
    HttpApiBuilder.Router.Live,
    HttpApiBuilder.Middleware.layer,
    HttpServer.layerContext,
  );

  const scope = Effect.runSync(Scope.make());
  const runtime = Effect.runSync(Layer.toRuntime(MainLive).pipe(Scope.extend(scope)));
  const httpApp = Effect.runSync(HttpApiBuilder.httpApp.pipe(Effect.provide(runtime)));
  const webHandler = HttpApp.toWebHandlerRuntime(runtime)(httpApp);

  return (request: Request) => webHandler(request);
}

export const handleEffectApi = createEffectApiHandler();

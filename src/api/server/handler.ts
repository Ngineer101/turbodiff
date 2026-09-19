import { ViewsHandlers } from './views/handlers.ts';
import { HttpApiBuilder, HttpApp, HttpServer } from '@effect/platform';
import { env } from 'cloudflare:workers';
import { Effect, Layer, Scope } from 'effect';
import { enqueueFactoryMessage } from '../../application/factory/queue.ts';
import { requireUser } from '../../application/auth/session.ts';
import { createSkillsShClient } from '../../integrations/skills-sh/client.ts';
import { AppApi } from '../contract/api.ts';
import { AgentsHandlers } from './agents/handlers.ts';
import { AgentServiceLive } from './agents/service.ts';
import { AutomationsHandlers } from './automations/handlers.ts';
import { AutomationServiceLive } from './automations/service.ts';
import { SessionAuthLive } from './auth.ts';
import { ChangesHandlers } from './changes/handlers.ts';
import { ChangeServiceLive } from './changes/service.ts';
import { ApiDependencies, type ApiRuntimeDependencies } from './context.ts';
import { DeliveriesHandlers } from './deliveries/handlers.ts';
import { DeliveryServiceLive } from './deliveries/service.ts';
import { ExecutionsHandlers } from './executions/handlers.ts';
import { ExecutionServiceLive } from './executions/service.ts';
import { IntegrationsHandlers } from './integrations/handlers.ts';
import { IntegrationServiceLive } from './integrations/service.ts';
import { OrganizationsHandlers } from './organizations/handlers.ts';
import { OrganizationServiceLive } from './organizations/service.ts';
import { PlatformHandlers } from './platform/handlers.ts';
import { PlatformServiceLive } from './platform/service.ts';
import { RepositoriesHandlers } from './repositories/handlers.ts';
import { RepositoryServiceLive } from './repositories/service.ts';
import { ReportingHandlers } from './reporting/handlers.ts';
import { ReportingServiceLive } from './reporting/service.ts';
import { SkillsHandlers } from './skills/handlers.ts';
import { SkillServiceLive } from './skills/service.ts';
import { WorkItemsHandlers } from './work-items/handlers.ts';
import { WorkItemServiceLive } from './work-items/service.ts';
import { ArtifactsHandlers } from './artifacts/handlers.ts';
import { ArtifactServiceLive } from './artifacts/service.ts';

export function createEffectApiHandler(
  dependencies: ApiRuntimeDependencies = {
    authenticate: requireUser,
    enqueueFactory: enqueueFactoryMessage,
    githubAppSlug: env.GITHUB_APP_SLUG ?? '',
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? '',
    skillsSh: createSkillsShClient(env.SKILLS_SH_API_TOKEN),
  },
) {
  const DependenciesLive = Layer.succeed(ApiDependencies, dependencies);
  const ServicesLive = Layer.mergeAll(
    AgentServiceLive,
    AutomationServiceLive,
    ChangeServiceLive,
    DeliveryServiceLive,
    ExecutionServiceLive,
    IntegrationServiceLive,
    OrganizationServiceLive,
    PlatformServiceLive,
    RepositoryServiceLive,
    ReportingServiceLive,
    SkillServiceLive,
    WorkItemServiceLive,
    ArtifactServiceLive,
  ).pipe(Layer.provide(DependenciesLive));
  const HandlersLive = Layer.mergeAll(
    AgentsHandlers,
    AutomationsHandlers,
    ChangesHandlers,
    DeliveriesHandlers,
    ExecutionsHandlers,
    IntegrationsHandlers,
    OrganizationsHandlers,
    PlatformHandlers,
    RepositoriesHandlers,
    ReportingHandlers,
    SkillsHandlers,
    WorkItemsHandlers,
    ArtifactsHandlers,
    ViewsHandlers,
  ).pipe(Layer.provide(ServicesLive));
  const ApiLive = HttpApiBuilder.api(AppApi).pipe(
    Layer.provide(HandlersLive),
    Layer.provide(SessionAuthLive.pipe(Layer.provide(DependenciesLive))),
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
  return HttpApp.toWebHandlerRuntime(runtime)(httpApp);
}

export const handleEffectApi = createEffectApiHandler();

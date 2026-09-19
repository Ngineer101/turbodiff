import { ViewsApi } from './views.ts';
import { HttpApi } from '@effect/platform';
import { SessionAuth } from './auth.ts';
import { AutomationsApi } from './automations.ts';
import { PlatformApi } from './platform.ts';
import { AgentsApi } from './agents.ts';
import { IntegrationsApi } from './integrations.ts';
import { RepositoriesApi } from './repositories.ts';
import { WorkItemsApi } from './work-items.ts';
import { SkillsApi } from './skills.ts';
import { ChangesApi } from './changes.ts';
import { OrganizationsApi } from './organizations.ts';
import { DeliveriesApi } from './deliveries.ts';
import { ExecutionsApi } from './executions.ts';
import { ReportingApi } from './reporting.ts';
import { ArtifactsApi } from './artifacts.ts';

export const AppApi = HttpApi.make('appApi')
  .add(AutomationsApi)
  .add(PlatformApi)
  .add(AgentsApi)
  .add(IntegrationsApi)
  .add(RepositoriesApi)
  .add(WorkItemsApi)
  .add(SkillsApi)
  .add(ChangesApi)
  .add(OrganizationsApi)
  .add(DeliveriesApi)
  .add(ExecutionsApi)
  .add(ReportingApi)
  .add(ArtifactsApi)
  .add(ViewsApi)
  .prefix('/api')
  .middleware(SessionAuth);

import { HttpApi } from '@effect/platform';
import { SessionAuth } from './auth.ts';
import { AutomationsApi } from './automations.ts';
import { PlatformApi } from './platform.ts';
import { AgentsApi } from './agents.ts';
import { ConnectionsApi } from './connections.ts';
import { RepositoriesApi } from './repositories.ts';
import { WorkItemsApi } from './work-items.ts';
import { SkillsApi } from './skills.ts';
import { ChangesApi } from './changes.ts';
import { OrganizationsApi } from './organizations.ts';
import { ReportingApi } from './reporting.ts';
import { DeliveriesApi } from './deliveries.ts';

export const AppApi = HttpApi.make('appApi')
  .add(AutomationsApi)
  .add(PlatformApi)
  .add(AgentsApi)
  .add(ConnectionsApi)
  .add(RepositoriesApi)
  .add(WorkItemsApi)
  .add(SkillsApi)
  .add(ChangesApi)
  .add(OrganizationsApi)
  .add(ReportingApi)
  .add(DeliveriesApi)
  .prefix('/api')
  .middleware(SessionAuth);

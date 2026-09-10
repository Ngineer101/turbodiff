import type { dispatchExplain } from '../../ai/explain/dispatch.ts';
import type { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import type { resolveConnectionAuth } from '../../services/connections.ts';
import type { requireUser, userCanPushToRepo, userIsGithubOrgAdmin } from '../../services/auth.ts';
import type { testMcpEndpoint } from '../../integrations/mcp/client.ts';
import type { SkillsShClient } from '../../integrations/skills-sh/client.ts';

export interface ApiRouteDependencies {
  authenticate?: typeof requireUser;
  canPushToRepo?: typeof userCanPushToRepo;
  orgAdmin?: typeof userIsGithubOrgAdmin;
  // Injectable for tests (the worker-test fixture has no queue binding).
  enqueueFactory?: typeof enqueueFactoryMessage;
  // Injectable for tests (no outbound fetch in the worker pool).
  skillsSh?: SkillsShClient;
  // Injectable for tests (no agent runtime in the worker pool).
  dispatchExplain?: typeof dispatchExplain;
  // Injectable for connection-test transport coverage.
  resolveConnectionAuth?: typeof resolveConnectionAuth;
  testMcpEndpoint?: typeof testMcpEndpoint;
}

export interface ResolvedApiRouteDependencies {
  authenticate: typeof requireUser;
  canPushToRepo: typeof userCanPushToRepo;
  orgAdmin: typeof userIsGithubOrgAdmin;
  enqueueFactory: typeof enqueueFactoryMessage;
  skillsSh: SkillsShClient;
  dispatchExplain: typeof dispatchExplain;
  resolveConnectionAuth: typeof resolveConnectionAuth;
  testMcpEndpoint: typeof testMcpEndpoint;
}

import { Context } from 'effect';
import type { enqueueFactoryMessage } from '../../application/factory/queue.ts';
import type {
  requireUser,
  userCanPushToRepo,
  userIsGithubOrgAdmin,
} from '../../application/auth/session.ts';
import type { resolveConnectionAuth } from '../../integrations/connections/credentials.ts';
import type { testMcpEndpoint } from '../../integrations/mcp/client.ts';
import type { SkillsShClient } from '../../integrations/skills-sh/client.ts';
import type { dispatchExplain } from '../../ai/explain/dispatch.ts';

export interface ApiRuntimeDependencies {
  readonly authenticate: typeof requireUser;
  readonly orgAdmin: typeof userIsGithubOrgAdmin;
  readonly enqueueFactory: typeof enqueueFactoryMessage;
  readonly defer: (promise: Promise<void>) => void;
  readonly githubAppSlug: string;
  readonly vapidPublicKey: string;
  readonly resolveConnectionAuth: typeof resolveConnectionAuth;
  readonly testMcpEndpoint: typeof testMcpEndpoint;
  readonly canPushToRepo: typeof userCanPushToRepo;
  readonly skillsSh: SkillsShClient;
  readonly dispatchExplain: typeof dispatchExplain;
}

export class ApiDependencies extends Context.Tag('Turbodiff/ApiDependencies')<
  ApiDependencies,
  ApiRuntimeDependencies
>() {}

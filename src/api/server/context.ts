import { Context } from 'effect';
import type { enqueueFactoryMessage } from '../../application/factory/queue.ts';
import type { requireUser } from '../../application/auth/session.ts';
import type { SkillsShClient } from '../../integrations/skills-sh/client.ts';

export interface ApiRuntimeDependencies {
  readonly authenticate: typeof requireUser;
  readonly enqueueFactory: typeof enqueueFactoryMessage;
  readonly githubAppSlug: string;
  readonly vapidPublicKey: string;
  readonly skillsSh: SkillsShClient;
}

export class ApiDependencies extends Context.Tag('Turbodiff/ApiDependencies')<
  ApiDependencies,
  ApiRuntimeDependencies
>() {}

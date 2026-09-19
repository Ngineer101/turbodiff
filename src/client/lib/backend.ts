import type {
  ApiAgentDetail,
  ApiAgentsList,
  ApiAutomationDetail,
  ApiAutomationRunDetail,
  ApiAutomationRunsList,
  ApiAutomationsList,
  ApiBoard,
  ApiChatList,
  ApiFeatureDetail,
  ApiFeatureDiff,
  ApiFeatureExplanation,
  ApiIntegrations,
  ApiConnectionTest,
  ApiInvitationAccepted,
  ApiInvitationPreview,
  ApiMe,
  ApiModels,
  ApiOrgMembers,
  ApiPlan,
  ApiRepoCode,
  ApiRepoFile,
  ApiRepoTree,
  ApiSettings,
  ApiSkillCatalog,
  ApiSkillDetail,
  ApiSkillsList,
  ApiTaskDetail,
  ApiUsage,
  ExplanationDocument,
} from '../types.ts';
import type { AppApiClient } from '../../api/client/app-api.ts';
import type { ChangeExplanation } from '../../api/contract/changes.ts';
import { storedPlanArtifactSchema } from '../../artifacts/plan.ts';
import { Effect } from 'effect';
import { z } from 'zod';
import { isJsonArray, isJsonObject, isString } from '../../shared/json.ts';
import { ApiError, protocolJson, runApi } from './api.ts';

const call = <Value, Failure>(operation: (client: AppApiClient) => Effect.Effect<Value, Failure>) =>
  runApi(operation);

export const getCurrentUser = async (): Promise<ApiMe> => {
  const user = await call((client) => client.platform.getCurrentUser({}));
  return {
    ...user,
    organizationIds: [...user.organizationIds],
  };
};

export const getModels = async (): Promise<ApiModels> => {
  const catalog = await call((client) => client.agents.getModels({}));
  return {
    runner: {
      options: [...catalog.options],
      default_model: catalog.defaultModel,
      fast_model: catalog.fastModel,
    },
    reviewer: { options: [...catalog.options], default_model: catalog.defaultModel },
  };
};

const asPlan = (artifactValue: Parameters<typeof storedPlanArtifactSchema.safeParse>[0]) => {
  const parsed = storedPlanArtifactSchema.safeParse(artifactValue);
  if (!parsed.success) return { plan: null, summary: null, acceptance: [] };
  return {
    plan: parsed.data.plan,
    summary: parsed.data.summary,
    acceptance: parsed.data.acceptance,
  };
};

async function planArtifactForWorkItem(workItem: Awaited<ReturnType<typeof getWorkItemResource>>) {
  if (workItem.approvedPlanArtifactId) {
    const artifactId = workItem.approvedPlanArtifactId;
    return call((client) => client.artifacts.getArtifact({ path: { artifactId } }));
  }
  const summaries = await call((client) =>
    client.workItems.listWorkItemFactoryRuns({ path: { workItemId: workItem.id } }),
  );
  for (const summary of summaries.items) {
    if (summary.flowKey !== 'work_item') continue;
    const run = await call((client) =>
      client.executions.getFactoryRun({ path: { factoryRunId: summary.id } }),
    );
    const outputId = run.stages
      .flatMap((stage) => stage.agentRuns)
      .find(
        (agentRun) => agentRun.status === 'succeeded' && agentRun.outputArtifactId,
      )?.outputArtifactId;
    if (outputId) {
      const artifact = await call((client) =>
        client.artifacts.getArtifact({ path: { artifactId: outputId } }),
      );
      if (artifact.kind === 'plan') return artifact;
    }
  }
  return null;
}

const getWorkItemResource = (id: number) =>
  call((client) => client.workItems.getWorkItem({ path: { workItemId: id } }));

function workItemPlan(
  workItem: Awaited<ReturnType<typeof getWorkItemResource>>,
  detailed: false,
): Promise<ApiPlan>;
function workItemPlan(
  workItem: Awaited<ReturnType<typeof getWorkItemResource>>,
  detailed: true,
): Promise<ApiTaskDetail>;
async function workItemPlan(
  workItem: Awaited<ReturnType<typeof getWorkItemResource>>,
  detailed: boolean,
): Promise<ApiPlan | ApiTaskDetail> {
  const [deliveryList, artifact, runList] = await Promise.all([
    call((client) =>
      client.workItems.listWorkItemDeliveries({ path: { workItemId: workItem.id } }),
    ),
    planArtifactForWorkItem(workItem),
    detailed
      ? call((client) =>
          client.workItems.listWorkItemFactoryRuns({ path: { workItemId: workItem.id } }),
        )
      : Promise.resolve({ items: [] }),
  ]);
  const defaultModel = (await getModels()).runner.default_model;
  const selectedModel = window.localStorage.getItem(`turbodiff.workItemModel.${workItem.id}`);
  const deliveries = await Promise.all(
    deliveryList.items.map((item) =>
      call((client) => client.deliveries.getDelivery({ path: { deliveryId: item.id } })),
    ),
  );
  const artifactPlan = asPlan(artifact?.value);
  const status =
    workItem.status === 'planning'
      ? 'analyzing'
      : workItem.status === 'awaiting_approval'
        ? 'plan_ready'
        : workItem.status === 'cancelled'
          ? 'failed'
          : workItem.status === 'open'
            ? 'awaiting_answers'
            : 'approved';
  const base: ApiPlan = {
    id: workItem.id,
    title: workItem.title,
    status,
    error: null,
    created_at: workItem.createdAt,
    questions: [],
    acceptance: artifactPlan.acceptance,
    plan: artifactPlan.plan,
    summary: artifactPlan.summary,
    archived: workItem.status === 'completed' || workItem.status === 'cancelled',
    model: selectedModel || defaultModel,
    attachments: workItem.attachments.map((attachment) => ({ name: attachment.name })),
    repos: workItem.targets.map((target) => {
      const delivery = deliveries.find((item) => item.repository.id === target.repositoryId);
      return {
        repository_id: target.repositoryId,
        owner: target.owner,
        name: target.name,
        provider: delivery?.repository.provider ?? 'github',
        feature_id: delivery?.id ?? null,
        pr_number: delivery?.change?.number ?? null,
        feature_status: delivery?.change?.status ?? delivery?.status ?? null,
        feature_error: null,
        verification: null,
      };
    }),
  };
  if (!detailed) return base;
  return {
    ...base,
    runs: runList.items.map((run) => ({
      id: run.id,
      kind: run.flowKey === 'work_item' ? 'plan_refine' : 'automation',
      success: run.status === 'succeeded',
      created_at: run.createdAt,
    })),
  };
}

export async function getBoard(): Promise<ApiBoard> {
  const [workItems, repositories, organizations, usage] = await Promise.all([
    call((client) => client.workItems.listWorkItems({})),
    call((client) => client.repositories.listRepositories({})),
    call((client) => client.organizations.listOrganizations({})),
    call((client) => client.reporting.getUsageSummary({})),
  ]);
  const todos = workItems.items.filter((item) => item.status === 'open');
  const tasks = workItems.items.filter((item) => item.status !== 'open');
  return {
    stats: { month_pipeline_cost_usd: usage.totals.costUsd, running: usage.totals.running },
    todos: todos.map((item) => ({
      id: item.id,
      organization_id: item.organizationId,
      title: item.title,
      notes: item.description === item.title ? null : item.description,
      created_at: item.createdAt,
      repos: item.targets.map((target) => ({
        id: target.repositoryId,
        owner: target.owner,
        name: target.name,
      })),
    })),
    tasks: await Promise.all(tasks.map((item) => workItemPlan(item, false))),
    organizations: organizations.items.map((organization) => ({
      id: organization.id,
      name: organization.name,
    })),
    repos: repositories.items.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      organization_id: repository.organizationId,
    })),
  };
}

export async function getTask(id: number): Promise<ApiTaskDetail> {
  return workItemPlan(await getWorkItemResource(id), true);
}

export async function getUsage(): Promise<ApiUsage> {
  const [usage, repositories] = await Promise.all([
    call((client) => client.reporting.getUsageSummary({})),
    call((client) => client.repositories.listRepositories({})),
  ]);
  return {
    month: usage.month,
    stats: {
      month_reviews: usage.byFlow.find((item) => item.key === 'review')?.runs ?? 0,
      month_review_cost_usd: usage.byFlow.find((item) => item.key === 'review')?.costUsd ?? 0,
      month_pipeline_cost_usd: usage.totals.costUsd,
      month_tokens: usage.totals.inputTokens + usage.totals.outputTokens,
      avg_duration_s: null,
      avg_findings: null,
      running: usage.totals.running,
    },
    months: [],
    agent_usage: usage.byAgent.map((item) => ({
      agent_slug: item.key,
      reviews: item.runs,
      cost_usd: item.costUsd,
    })),
    repo_count: repositories.items.length,
    enabled_count: repositories.items.filter((repository) => repository.settings.enabled).length,
    recent_repos: repositories.items.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      enabled: repository.settings.enabled,
      suspended: false,
      reviews: 0,
      cost_usd: 0,
    })),
    features: [],
    automation_usage: [],
  };
}

function diffFiles(patch: string): ApiFeatureDetail['files'] {
  const starts = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? patch.length;
    const section = patch.slice(start, end);
    return {
      filename: match[2] ?? match[1] ?? 'unknown',
      status: section.includes('new file mode')
        ? 'added'
        : section.includes('deleted file mode')
          ? 'removed'
          : 'modified',
      additions: section
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: section
        .split('\n')
        .filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      patch: section,
    };
  });
}

export async function getFeature(id: number): Promise<ApiFeatureDetail> {
  const delivery = await call((client) =>
    client.deliveries.getDelivery({ path: { deliveryId: id } }),
  );
  const [workItem, change] = await Promise.all([
    getWorkItemResource(delivery.workItemId),
    delivery.change
      ? call((client) => client.changes.getChange({ path: { changeId: delivery.change!.id } }))
      : Promise.resolve(null),
  ]);
  const revisionArtifact = change?.currentRevision
    ? await call((client) =>
        client.artifacts.getArtifact({
          path: { artifactId: change.currentRevision!.artifactId },
        }),
      )
    : null;
  const revision = isJsonObject(revisionArtifact?.value) ? revisionArtifact.value : null;
  const files = revision && isString(revision.patch) ? diffFiles(revision.patch) : [];
  const planArtifact = await planArtifactForWorkItem(workItem);
  const plan = asPlan(planArtifact?.value);
  const runs = await Promise.all(
    delivery.factoryRuns.map((run) =>
      call((client) => client.executions.getFactoryRun({ path: { factoryRunId: run.id } })),
    ),
  );
  const reviewOutcomes = change?.currentRevision?.reviewOutcomes ?? [];
  return {
    feature: {
      id: delivery.id,
      title: workItem.title,
      status: delivery.change?.status ?? delivery.status,
      error:
        runs.flatMap((run) => run.stages).find((stage) => stage.errorMessage)?.errorMessage ?? null,
      pr_number: delivery.change?.number ?? null,
      criteria_conflict: false,
      proposed_criteria: null,
    },
    repo: `${delivery.repository.owner}/${delivery.repository.name}`,
    provider: delivery.repository.provider,
    diff_version: change?.currentRevision?.headSha ?? null,
    cr_number: delivery.repository.provider === 'github' ? null : (delivery.change?.number ?? null),
    checks: [],
    plan: plan.plan,
    pr: delivery.change
      ? {
          state: delivery.change.status,
          html_url: delivery.change.url,
          additions: files.reduce((total, file) => total + file.additions, 0),
          deletions: files.reduce((total, file) => total + file.deletions, 0),
          changed_files: files.length,
          mergeable_state: null,
        }
      : null,
    files,
    more_files: 0,
    reviews: reviewOutcomes.map((outcome) => ({
      state: outcome.verdict,
      body: outcome.conclusion,
      author: null,
    })),
    comments: [],
    demo: null,
    criteria: plan.acceptance.map((text) => ({
      text,
      verdict: null,
      note: null,
      screenshot_url: null,
    })),
    verification: null,
    runs: runs.flatMap((run) =>
      run.stages.flatMap((stage) =>
        stage.agentRuns.map((agentRun) => ({
          id: agentRun.id,
          kind: run.flowKey === 'review' ? 'verify' : 'generate',
          success: agentRun.status === 'succeeded',
          created_at: agentRun.createdAt,
        })),
      ),
    ),
    lifecycle_runs: runs.map((run) => ({
      id: run.id,
      profile: run.flowKey === 'review' ? 'automatic_review' : 'full_delivery',
      status:
        run.status === 'waiting'
          ? 'awaiting_human'
          : run.status === 'succeeded'
            ? 'completed'
            : run.status === 'failed'
              ? 'failed'
              : run.status === 'cancelled'
                ? 'cancelled'
                : 'active',
      start_stage: run.stages[0]?.stageKey ?? '',
      stop_after_stage: run.stages.at(-1)?.stageKey ?? '',
      handoff_reason: null,
      created_at: run.createdAt,
      completed_at: run.completedAt,
      stages: run.stages.map((stage) => ({
        id: stage.id,
        stage: stage.stageKey,
        attempt: stage.attempt,
        status:
          stage.status === 'succeeded'
            ? 'completed'
            : stage.status === 'failed'
              ? 'failed'
              : stage.status === 'cancelled'
                ? 'cancelled'
                : stage.status === 'running'
                  ? 'running'
                  : 'queued',
        verdict: null,
        error: stage.errorMessage,
        started_at: stage.startedAt,
        completed_at: stage.completedAt,
      })),
      events: [],
    })),
  };
}

export async function getFeatureDiff(id: number): Promise<ApiFeatureDiff> {
  const feature = await getFeature(id);
  return { version: feature.diff_version, files: feature.files, more_files: feature.more_files };
}

export async function getFeatureExplanation(id: number): Promise<ApiFeatureExplanation> {
  const delivery = await call((client) =>
    client.deliveries.getDelivery({ path: { deliveryId: id } }),
  );
  if (!delivery.change) {
    return {
      version: null,
      status: 'none',
      document: null,
      model: null,
      error: null,
      created_at: null,
      completed_at: null,
      previous: null,
    };
  }
  const result = await call((client) =>
    client.changes.getChangeExplanation({ path: { changeId: delivery.change!.id } }),
  );
  return {
    version: result.headSha,
    status: result.status,
    document: result.document ? mutableExplanation(result.document) : null,
    model: null,
    error: result.error,
    created_at: result.createdAt,
    completed_at: result.completedAt,
    previous: null,
  };
}

function mutableExplanation(document: ChangeExplanation['document']): ExplanationDocument {
  if (!document) return { blocks: [] };
  return {
    blocks: document.blocks.map((block) => {
      if (block.kind === 'summary') return { ...block };
      if (block.kind === 'sequence') {
        return {
          ...block,
          participants: [...block.participants],
          messages: block.messages.map((message) => ({ ...message })),
          refs: block.refs.map((ref) => ({ ...ref })),
        };
      }
      return {
        ...block,
        lines: block.lines.map((line) => ({ ...line })),
        refs: block.refs.map((ref) => ({ ...ref })),
      };
    }),
  };
}

export async function generateFeatureExplanation(id: number, force: boolean) {
  const delivery = await call((client) =>
    client.deliveries.getDelivery({ path: { deliveryId: id } }),
  );
  if (!delivery.change) throw new ApiError('There is no change to explain', 409);
  await call((client) =>
    client.changes.createExplanationRun({
      path: { changeId: delivery.change!.id },
      payload: { force },
    }),
  );
  return getFeatureExplanation(id);
}

export async function mergeDeliveryChange(id: number) {
  const delivery = await call((client) =>
    client.deliveries.getDelivery({ path: { deliveryId: id } }),
  );
  const change = delivery.change;
  if (!change) throw new ApiError('There is no change to merge', 409);
  const result = await call((client) =>
    client.changes.mergeChange({ path: { changeId: change.id } }),
  );
  return { resolving: false, queued: false, status: result.status };
}

export async function closeDeliveryChange(id: number) {
  const delivery = await call((client) =>
    client.deliveries.getDelivery({ path: { deliveryId: id } }),
  );
  const change = delivery.change;
  if (!change) throw new ApiError('There is no change to close', 409);
  const result = await call((client) =>
    client.changes.closeChange({ path: { changeId: change.id } }),
  );
  return { branchDeleted: result.branchDeleted ?? false };
}

export async function getDeliveryChat(id: number): Promise<ApiChatList> {
  const messages = await call((client) =>
    client.deliveries.listDeliveryMessages({ path: { deliveryId: id } }),
  );
  return {
    messages: messages.items
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        id: message.id,
        role: message.role === 'assistant' ? 'assistant' : 'user',
        body: message.body,
        author: message.authorUserId,
        status: message.status === 'succeeded' ? 'done' : (message.status ?? 'saved'),
        outcome: message.outcome,
        commit_sha: message.commitSha,
        error: message.error,
        created_at: message.createdAt,
      })),
  };
}

export const sendDeliveryMessage = (id: number, body: string) =>
  call((client) =>
    client.deliveries.createDeliveryMessage({ path: { deliveryId: id }, payload: { body } }),
  );

export async function getAgents(): Promise<ApiAgentsList> {
  const [me, agents] = await Promise.all([
    getCurrentUser(),
    call((client) => client.agents.listAgents({})),
  ]);
  const models = await getModels();
  return {
    github_app_slug: me.githubAppSlug,
    agents: agents.items.map((agent) => ({
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      model: models.runner.default_model,
      is_builtin: agent.builtIn,
    })),
  };
}

export async function getAgent(id: number): Promise<ApiAgentDetail> {
  const [agent, models] = await Promise.all([
    call((client) => client.agents.getAgent({ path: { agentId: id } })),
    getModels(),
  ]);
  return {
    agent: {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      model: models.runner.default_model,
      is_builtin: agent.builtIn,
      instructions: agent.instructionsOverride ?? '',
    },
    default_model: models.runner.default_model,
  };
}

export async function getSkills(): Promise<ApiSkillsList> {
  const skills = await call((client) => client.skills.listSkills({}));
  return {
    skills: skills.items.map((skill) => ({
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: null,
      source: null,
    })),
  };
}

export async function getSkill(id: number): Promise<ApiSkillDetail> {
  const skill = await call((client) => client.skills.getSkill({ path: { skillId: id } }));
  return {
    skill: {
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: null,
      source: null,
      instructions: skill.content,
      source_ref: null,
      source_hash: skill.contentHash,
      imported_at: null,
      files: [],
    },
  };
}

export async function getSkillCatalog(q: string, sort: string): Promise<ApiSkillCatalog> {
  const selectedSort = sort === 'hot' || sort === 'all-time' ? sort : 'trending';
  const catalog = await call((client) =>
    client.skills.getSkillCatalog({ urlParams: { q, sort: selectedSort } }),
  );
  return { configured: catalog.configured, skills: [...catalog.items], error: catalog.error };
}

export async function getSettings(): Promise<ApiSettings> {
  const [me, integrations, repositories, organizations] = await Promise.all([
    getCurrentUser(),
    call((client) => client.integrations.listIntegrations({})),
    call((client) => client.repositories.listRepositories({})),
    call((client) => client.organizations.listOrganizations({})),
  ]);
  const github = integrations.items.filter((integration) => integration.provider === 'github');
  return {
    github_app_slug: me.githubAppSlug,
    organizations: organizations.items.map((organization) => ({
      id: organization.id,
      name: organization.name,
      suspended:
        github.some((integration) => integration.organizationId === organization.id) &&
        github
          .filter((integration) => integration.organizationId === organization.id)
          .every((integration) => !integration.enabled),
      repos: repositories.items
        .filter((repository) => repository.organizationId === organization.id)
        .map((repository) => ({
          id: repository.id,
          owner: repository.owner,
          name: repository.name,
          provider: repository.provider,
          enabled: repository.settings.enabled,
          review_on_push: repository.settings.reviewOnPush,
          review_push_debounce_minutes: 0,
          process_profile: 'full_delivery',
          blocking_reviews: true,
          auto_fix: false,
          auto_merge: false,
          auto_resolve_conflicts: false,
          demo_videos: false,
          check_command: repository.settings.checkCommand,
          agents: repository.agents.map((agent) => ({ ...agent })),
          skills: repository.skills.map((skill) => ({ ...skill })),
        })),
    })),
  };
}

export async function getOrganizationMembers(organizationId: string): Promise<ApiOrgMembers> {
  const result = await call((client) =>
    client.organizations.listOrganizationMembers({ path: { organizationId } }),
  );
  return {
    org_id: result.organizationId,
    my_role: result.myRole,
    members: result.members.map((member) => ({ ...member, joined_at: member.joinedAt })),
    invitations: result.invitations.map((invitation) => ({
      ...invitation,
      expires_at: invitation.expiresAt,
    })),
  };
}

export const getInvitation = (id: string): Promise<ApiInvitationPreview> =>
  call((client) => client.organizations.getInvitation({ path: { invitationId: id } }));

export const acceptInvitation = (id: string): Promise<ApiInvitationAccepted> =>
  call((client) => client.organizations.acceptInvitation({ path: { invitationId: id } }));

export async function getIntegrations(): Promise<ApiIntegrations> {
  const [items, repositories, organizations] = await Promise.all([
    call((client) => client.integrations.listIntegrations({})),
    call((client) => client.repositories.listRepositories({})),
    call((client) => client.organizations.listOrganizations({})),
  ]);
  return {
    encryption_configured: items.credentialStorageConfigured,
    organizations: organizations.items.map((organization) => ({
      id: organization.id,
      name: organization.name,
    })),
    repos: repositories.items.map((repository) => ({
      id: repository.id,
      organization_id: repository.organizationId,
      owner: repository.owner,
      name: repository.name,
    })),
    connections: items.items
      .filter((integration) => integration.kind === 'mcp' || integration.kind === 'api')
      .map((integration) => {
        const config = isJsonObject(integration.config) ? integration.config : {};
        const authType = isString(config.authType) ? config.authType : 'none';
        const tools =
          isJsonArray(config.toolAllowlist) && config.toolAllowlist.every(isString)
            ? [...config.toolAllowlist]
            : null;
        return {
          id: integration.id,
          organization_id: integration.organizationId,
          name: integration.name,
          kind: integration.kind,
          url: isString(config.url) ? config.url : '',
          tools,
          has_auth: integration.hasCredentials,
          auth_type: authType,
          oauth_status: integration.authorizationStatus,
          repo_links: repositories.items
            .filter((repository) =>
              repository.integrations.some(
                (candidate) => candidate.id === integration.id && candidate.enabled,
              ),
            )
            .map((repository) => ({
              repository_id: repository.id,
              reviews: true,
              automations: true,
            })),
        };
      }),
  };
}

function automationSchedule(schedule: string) {
  if (schedule === '0 * * * *') return { kind: 'hourly' as const, time: null, day: null };
  const daily = schedule.match(/^(\d+) (\d+) \* \* \*$/);
  if (daily) {
    return {
      kind: 'daily' as const,
      time: `${daily[2]?.padStart(2, '0')}:${daily[1]?.padStart(2, '0')}`,
      day: null,
    };
  }
  const weekly = schedule.match(/^(\d+) (\d+) \* \* (\d)$/);
  return {
    kind: 'weekly' as const,
    time: weekly ? `${weekly[2]?.padStart(2, '0')}:${weekly[1]?.padStart(2, '0')}` : '09:00',
    day: weekly ? Number(weekly[3]) : 1,
  };
}

export async function getAutomations(): Promise<ApiAutomationsList> {
  const [automations, repositories] = await Promise.all([
    call((client) => client.automations.listAutomations({})),
    call((client) => client.repositories.listRepositories({})),
  ]);
  return {
    automations: automations.items.map((automation) => {
      const schedule = automationSchedule(automation.schedule);
      const repository = repositories.items.find((item) => item.id === automation.repositoryId);
      return {
        id: automation.id,
        name: automation.name,
        repository: repository
          ? { id: repository.id, owner: repository.owner, name: repository.name }
          : { id: 0, owner: '', name: '' },
        schedule_kind: schedule.kind,
        time_of_day: schedule.time,
        day_of_week: schedule.day,
        enabled: automation.enabled,
        runner_model: null,
        next_run_at: automation.nextRunAt ?? automation.updatedAt,
        last_run: null,
      };
    }),
    repos: repositories.items.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      organization_id: repository.organizationId,
    })),
  };
}

export async function getAutomation(id: number): Promise<ApiAutomationDetail> {
  const [automation, list] = await Promise.all([
    call((client) => client.automations.getAutomation({ path: { automationId: id } })),
    getAutomations(),
  ]);
  const summary = list.automations.find((item) => item.id === id);
  if (!summary) throw new ApiError('Unknown automation', 404);
  const prompt =
    isJsonObject(automation.inputTemplate) && isString(automation.inputTemplate.prompt)
      ? automation.inputTemplate.prompt
      : '';
  return { automation: { ...summary, prompt } };
}

export async function getAutomationRuns(id: number): Promise<ApiAutomationRunsList> {
  const [automation, runs] = await Promise.all([
    call((client) => client.automations.getAutomation({ path: { automationId: id } })),
    call((client) => client.automations.listAutomationRuns({ path: { automationId: id } })),
  ]);
  return {
    automation: { id: automation.id, name: automation.name },
    runs: runs.items.map((run) => ({
      id: run.id,
      status:
        run.status === 'succeeded' ? 'no_changes' : run.status === 'running' ? 'running' : 'failed',
      pr_number: null,
      error: null,
      created_at: run.createdAt,
    })),
  };
}

export async function getAutomationRun(id: number): Promise<ApiAutomationRunDetail> {
  const run = await call((client) => client.automations.getAutomationRun({ path: { runId: id } }));
  const automation = await call((client) =>
    client.automations.getAutomation({ path: { automationId: run.automationId } }),
  );
  return {
    run: {
      id: run.id,
      status:
        run.status === 'succeeded' ? 'no_changes' : run.status === 'running' ? 'running' : 'failed',
      pr_number: null,
      error: null,
      created_at: run.createdAt,
    },
    automation: { id: automation.id, name: automation.name, repo: '' },
    runs: [],
  };
}

export async function getRepositoryCode(id: number): Promise<ApiRepoCode> {
  const result = await call((client) =>
    client.repositories.getRepositoryCode({ path: { repositoryId: id } }),
  );
  return {
    repo: result.repository,
    supported: true,
    default_branch: result.defaultBranch,
    branches: [...result.branches],
  };
}

export const getRepositoryTree = async (
  id: number,
  ref: string,
  path: string,
): Promise<ApiRepoTree> => {
  const result = await call((client) =>
    client.repositories.getRepositoryTree({
      path: { repositoryId: id },
      urlParams: { ref, path },
    }),
  );
  return { path: result.path, entries: result.entries.map((entry) => ({ ...entry })) };
};

export async function getRepositoryFile(
  id: number,
  ref: string,
  path: string,
): Promise<ApiRepoFile> {
  const result = await call((client) =>
    client.repositories.getRepositoryFile({
      path: { repositoryId: id },
      urlParams: { ref, path },
    }),
  );
  return { ...result, too_large: result.tooLarge, content_base64: result.contentBase64 };
}

export const resources = { call };

export const createWorkItem = async (
  organizationId: string,
  title: string,
  repositoryIds: number[],
  description?: string,
) => {
  const details = description?.trim();
  const created = await call((client) =>
    client.workItems.createWorkItem({
      payload: {
        organizationId,
        repositoryIds,
        title,
        description: details ? details : title,
        origin: 'idea',
      },
    }),
  );
  return { ok: true, todo_id: created.id };
};

export const updateWorkItemTargets = (id: number, repositoryIds: number[]) =>
  call((client) =>
    client.workItems.updateWorkItem({
      path: { workItemId: id },
      payload: { repositoryIds },
    }),
  );

export const deleteWorkItem = (id: number) =>
  call((client) => client.workItems.deleteWorkItem({ path: { workItemId: id } }));

export async function startWorkItem(
  id: number,
  title: string,
  description: string,
  model?: string,
  attachments: Array<{ artifactId: number; name: string }> = [],
): Promise<void> {
  await call((client) =>
    client.workItems.updateWorkItem({
      path: { workItemId: id },
      payload: { title, description },
    }),
  );
  await call((client) =>
    client.workItems.startWorkItemFactoryRun({
      path: { workItemId: id },
      payload: { flow: 'planning', model, attachments },
    }),
  );
}

const attachmentUploadSchema = z
  .object({
    artifactId: z.number().int().positive(),
    name: z.string(),
    contentType: z.string(),
  })
  .strict();

export async function uploadWorkItemAttachment(file: File, organizationId: string) {
  const body = new FormData();
  body.append('file', file);
  body.append('organizationId', organizationId);
  return attachmentUploadSchema.parse(
    await protocolJson('/protocol/work-item-attachments', { method: 'POST', body }),
  );
}

export const restartPlanning = (id: number, model?: string) =>
  call((client) =>
    client.workItems.startWorkItemFactoryRun({
      path: { workItemId: id },
      payload: { flow: 'planning', model },
    }),
  );

export function selectWorkItemModel(id: number, model: string): Promise<string> {
  window.localStorage.setItem(`turbodiff.workItemModel.${id}`, model);
  return Promise.resolve(model);
}

export async function reviseWorkItem(id: number, note: string): Promise<void> {
  const workItem = await getWorkItemResource(id);
  await call((client) =>
    client.workItems.updateWorkItem({
      path: { workItemId: id },
      payload: { description: `${workItem.description}\n\n${note}` },
    }),
  );
  await restartPlanning(id);
}

export async function approveWorkItem(id: number): Promise<void> {
  const workItem = await getWorkItemResource(id);
  const artifact = await planArtifactForWorkItem(workItem);
  if (!artifact) throw new ApiError('No plan is awaiting approval', 409);
  await call((client) =>
    client.workItems.approveWorkItemPlan({
      path: { workItemId: id },
      payload: { artifactId: artifact.id },
    }),
  );
}

export const archiveWorkItem = (id: number, archived: boolean) =>
  call((client) =>
    client.workItems.updateWorkItem({
      path: { workItemId: id },
      payload: { status: archived ? 'completed' : 'open' },
    }),
  );

export const retryDelivery = (id: number) =>
  call((client) => client.deliveries.startDeliveryRun({ path: { deliveryId: id }, payload: {} }));

export async function reviewDelivery(id: number) {
  const delivery = await call((client) =>
    client.deliveries.getDelivery({ path: { deliveryId: id } }),
  );
  if (!delivery.change) throw new ApiError('There is no change to review', 409);
  return call((client) =>
    client.changes.createReviewRun({ path: { changeId: delivery.change!.id } }),
  );
}

export const createAgent = async (values: {
  name: string;
  slug: string;
  description: string;
  instructions: string;
}) => {
  const me = await getCurrentUser();
  return call((client) =>
    client.agents.createAgent({
      payload: {
        organizationId: me.activeOrganizationId,
        definitionKey: 'reviewer',
        slug: values.slug,
        name: values.name,
        description: values.description || null,
        instructionsOverride: values.instructions || null,
      },
    }),
  );
};

export const updateAgent = (
  id: number,
  values: { name: string; description: string; instructions: string },
) =>
  call((client) =>
    client.agents.updateAgent({
      path: { agentId: id },
      payload: {
        name: values.name,
        description: values.description || null,
        instructionsOverride: values.instructions || null,
      },
    }),
  );

export const deleteAgent = (id: number) =>
  call((client) => client.agents.deleteAgent({ path: { agentId: id } }));

export const createSkill = async (values: { name: string; slug: string; instructions: string }) => {
  const me = await getCurrentUser();
  return call((client) =>
    client.skills.createSkill({
      payload: {
        organizationId: me.activeOrganizationId,
        slug: values.slug,
        name: values.name,
        content: values.instructions,
      },
    }),
  );
};

export const updateSkill = (id: number, values: { name: string; instructions: string }) =>
  call((client) =>
    client.skills.updateSkill({
      path: { skillId: id },
      payload: { name: values.name, content: values.instructions },
    }),
  );

export const deleteSkill = (id: number) =>
  call((client) => client.skills.deleteSkill({ path: { skillId: id } }));

export const importSkill = async (reference: string, slug: string) => {
  const me = await getCurrentUser();
  const skill = await call((client) =>
    client.skills.importSkill({
      payload: { organizationId: me.activeOrganizationId, reference, slug },
    }),
  );
  return { ok: true, id: skill.id };
};

export const previewSkillImport = async (reference: string) => {
  const me = await getCurrentUser();
  const preview = await call((client) =>
    client.skills.previewSkillImport({
      payload: { organizationId: me.activeOrganizationId, reference },
    }),
  );
  return {
    name: preview.name,
    suggested_slug: preview.suggestedSlug,
    slug_taken: preview.slugTaken,
    description: preview.description,
    instructions: preview.instructions,
    files: [...preview.files],
    source: preview.source,
    source_ref: preview.sourceRef,
    hash: preview.hash,
    installs: preview.installs,
    audit: preview.audit?.map((verdict) => ({ ...verdict })) ?? null,
  };
};

function cron(values: {
  schedule_kind: 'hourly' | 'daily' | 'weekly';
  time_of_day: string | null;
  day_of_week: number | null;
}) {
  if (values.schedule_kind === 'hourly') return '0 * * * *';
  const [hour = '9', minute = '0'] = (values.time_of_day ?? '09:00').split(':');
  return values.schedule_kind === 'weekly'
    ? `${Number(minute)} ${Number(hour)} * * ${values.day_of_week ?? 1}`
    : `${Number(minute)} ${Number(hour)} * * *`;
}

export const createAutomation = async (values: {
  name: string;
  repository_id: number;
  prompt: string;
  schedule_kind: 'hourly' | 'daily' | 'weekly';
  time_of_day: string | null;
  day_of_week: number | null;
  runner_model: string | null;
  enabled: boolean;
}) => {
  const [agents, repositories] = await Promise.all([
    call((client) => client.agents.listAgents({})),
    call((client) => client.repositories.listRepositories({})),
  ]);
  const repository = repositories.items.find((item) => item.id === values.repository_id);
  if (!repository) throw new ApiError('The selected repository is unavailable', 409);
  const agent = agents.items.find(
    (item) =>
      item.organizationId === repository.organizationId &&
      item.definitionKey === 'implementer' &&
      item.enabled,
  );
  if (!agent) throw new ApiError('The implementer agent is unavailable', 409);
  return call((client) =>
    client.automations.createAutomation({
      payload: {
        organizationId: repository.organizationId,
        agentId: agent.id,
        repositoryId: values.repository_id,
        name: values.name,
        schedule: cron(values),
        timezone: 'UTC',
        inputTemplate: { prompt: values.prompt, model: values.runner_model },
        enabled: values.enabled,
      },
    }),
  );
};

export const updateAutomation = (
  id: number,
  values: {
    name: string;
    prompt: string;
    schedule_kind: 'hourly' | 'daily' | 'weekly';
    time_of_day: string | null;
    day_of_week: number | null;
    runner_model: string | null;
    enabled: boolean;
  },
) =>
  call((client) =>
    client.automations.updateAutomation({
      path: { automationId: id },
      payload: {
        name: values.name,
        schedule: cron(values),
        inputTemplate: { prompt: values.prompt, model: values.runner_model },
        enabled: values.enabled,
      },
    }),
  );

export const deleteAutomation = (id: number) =>
  call((client) => client.automations.deleteAutomation({ path: { automationId: id } }));

export const runAutomation = (id: number) =>
  call((client) => client.automations.runAutomation({ path: { automationId: id } }));

export const createIntegration = async (values: {
  organization_id: string;
  kind: string;
  name: string;
  url: string;
  auth_type: string;
  token: string;
  header_name: string;
  header_value: string;
  client_id: string;
  client_secret: string;
  token_endpoint: string;
  scope: string;
  tools: string;
}) => {
  const kind = values.kind === 'api' ? 'api' : 'mcp';
  const credential = values.token || values.client_secret || values.header_value || undefined;
  return call((client) =>
    client.integrations.createIntegration({
      payload: {
        organizationId: values.organization_id,
        kind,
        provider: kind,
        name: values.name,
        config: {
          url: values.url,
          authType: values.auth_type,
          headerName: values.header_name,
          clientId: values.client_id,
          tokenEndpoint: values.token_endpoint,
          scope: values.scope,
          toolAllowlist: values.tools
            .split(',')
            .map((tool) => tool.trim())
            .filter(Boolean),
        },
        credential,
      },
    }),
  );
};

export const deleteIntegration = (id: number) =>
  call((client) => client.integrations.deleteIntegration({ path: { integrationId: id } }));

export async function testIntegration(id: number): Promise<ApiConnectionTest> {
  const result = await call((client) =>
    client.integrations.testIntegration({ path: { integrationId: id } }),
  );
  return {
    ok: result.ok,
    detail: result.detail,
    tools: [...result.tools],
    reauth_required: result.reauthorizationRequired,
  };
}

export const setRepositoryIntegration = (
  repositoryId: number,
  integrationId: number,
  enabled: boolean,
) =>
  call((client) =>
    client.repositories.setRepositoryIntegration({
      path: { repositoryId, integrationId },
      payload: { enabled },
    }),
  );

export const updateRepositorySettings = (
  repositoryId: number,
  values: { enabled?: boolean; review_on_push?: boolean; check_command?: string | null },
) =>
  call((client) =>
    client.repositories.updateRepositorySettings({
      path: { repositoryId },
      payload: {
        enabled: values.enabled,
        reviewOnPush: values.review_on_push,
        checkCommand: values.check_command ?? undefined,
      },
    }),
  );

export const setRepositoryAgent = (repositoryId: number, agentId: number, enabled: boolean) =>
  call((client) =>
    client.repositories.setRepositoryAgent({
      path: { repositoryId, agentId },
      payload: { enabled },
    }),
  );

export const setRepositorySkill = (repositoryId: number, skillId: number, enabled: boolean) =>
  call((client) =>
    client.repositories.setRepositorySkill({
      path: { repositoryId, skillId },
      payload: { enabled },
    }),
  );

export const createCloneCredential = (repositoryId: number, scope: 'read' | 'write') =>
  call((client) =>
    client.repositories.createCloneCredential({
      path: { repositoryId },
      payload: { scope },
    }),
  );

export async function createProject(owner: string, name: string, description?: string) {
  const [me, integrations] = await Promise.all([
    getCurrentUser(),
    call((client) => client.integrations.listIntegrations({})),
  ]);
  let source = integrations.items.find(
    (integration) => integration.kind === 'artifact_store' && integration.enabled,
  );
  if (!source) {
    source = await call((client) =>
      client.integrations.createIntegration({
        payload: {
          organizationId: me.activeOrganizationId,
          kind: 'artifact_store',
          provider: 'cloudflare-artifacts',
          name: 'Cloudflare Artifacts',
        },
      }),
    );
  }
  const repository = await call((client) =>
    client.repositories.createRepository({
      payload: {
        organizationId: me.activeOrganizationId,
        sourceIntegrationId: source.id,
        owner,
        name,
        description,
      },
    }),
  );
  return {
    ok: true,
    repository_id: repository.id,
    repo: `${repository.owner}/${repository.name}`,
    default_branch: repository.defaultBranch,
    remote: repository.remote,
  };
}

export const saveRepositoryFile = async (
  repositoryId: number,
  input: {
    path: string;
    ref: string;
    base_sha: string | null;
    content: string;
    message: string;
    mode: 'commit' | 'pr';
  },
) => {
  const saved = await call((client) =>
    client.repositories.saveRepositoryFile({
      path: { repositoryId },
      payload: {
        path: input.path,
        ref: input.ref,
        baseSha: input.base_sha,
        content: input.content,
        message: input.message,
        mode: input.mode === 'pr' ? 'pull_request' : 'commit',
      },
    }),
  );
  return {
    ok: true,
    content_sha: saved.contentSha,
    commit_sha: saved.commitSha,
    branch: saved.branch,
    pr: saved.pullRequest,
  };
};

export const updateOrganizationMember = (
  organizationId: string,
  memberId: string,
  role: 'owner' | 'admin' | 'member',
) =>
  call((client) =>
    client.organizations.updateOrganizationMember({
      path: { organizationId, memberId },
      payload: { role },
    }),
  );

export const deleteOrganizationMember = (organizationId: string, memberId: string) =>
  call((client) =>
    client.organizations.deleteOrganizationMember({ path: { organizationId, memberId } }),
  );

export const createOrganizationInvitation = (
  organizationId: string,
  email: string,
  role: 'owner' | 'admin' | 'member',
) =>
  call((client) =>
    client.organizations.createOrganizationInvitation({
      path: { organizationId },
      payload: { email, role },
    }),
  );

export const createPushSubscription = (subscription: PushSubscriptionJSON) => {
  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
    throw new ApiError('Push subscription is incomplete', 400);
  }
  return call((client) =>
    client.platform.createPushSubscription({
      payload: {
        endpoint: subscription.endpoint!,
        keys: { p256dh: subscription.keys!.p256dh, auth: subscription.keys!.auth },
      },
    }),
  );
};

export const deletePushSubscription = (endpoint: string) =>
  call((client) => client.platform.deletePushSubscription({ payload: { endpoint } }));

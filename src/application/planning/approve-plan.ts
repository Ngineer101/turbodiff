import { approvePlanFeatures, getPlan, listReposForPlan } from '../../data/db.ts';

// Approval is application logic, not agent behavior: it turns a validated plan
// artifact into one independently executable feature per attached repository.
export async function approvePlan(
  planId: number,
  approver?: { login: string; id: number },
): Promise<number[] | null> {
  const plan = await getPlan(planId);
  if (!plan || plan.status !== 'plan_ready' || !plan.plan) return null;

  const repos = await listReposForPlan(planId);
  const acceptance = plan.acceptance ?? [];
  const spec =
    `${plan.plan}\n\n## Acceptance criteria\n\n` +
    (acceptance.length
      ? acceptance.map((criterion) => `- ${criterion}`).join('\n')
      : '(none specified)') +
    `\n\nImplement the plan above so that every acceptance criterion holds.`;

  const creator =
    plan.created_by_login && plan.created_by_id !== null
      ? { login: plan.created_by_login, id: plan.created_by_id }
      : undefined;

  const author = approver ?? creator;
  const coauthor = creator && author && creator.login !== author.login ? creator : undefined;

  return approvePlanFeatures(
    planId,
    repos.map((repo) => ({
      repositoryId: repo.id,
      title: plan.title,
      spec,
      acceptance: plan.acceptance,
      authorLogin: author?.login ?? null,
      authorId: author?.id ?? null,
      coauthorLogin: coauthor?.login ?? null,
      coauthorId: coauthor?.id ?? null,
      tier: plan.tier,
    })),
  );
}

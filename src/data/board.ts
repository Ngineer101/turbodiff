import { env } from 'cloudflare:workers';

// --- kanban board: todos (unstarted backlog cards) + task archiving ---

export interface TodoRow {
  id: number;
  installation_id: number;
  title: string;
  notes: string | null;
  created_by_login: string | null;
  created_by_id: number | null;
  plan_id: number | null; // set once started; the board then shows the plan
  created_at: string;
}

export async function listTodos(installationIds: number[]): Promise<TodoRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT * FROM todos
		 WHERE installation_id IN (${placeholders}) AND plan_id IS NULL
		 ORDER BY id DESC`,
  )
    .bind(...installationIds)
    .all<TodoRow>();
  return res.results;
}

export async function createTodo(
  installationId: number,
  title: string,
  notes: string | null,
  createdBy?: { login: string; id: number },
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO todos (installation_id, title, notes, created_by_login, created_by_id)
		 VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
  )
    .bind(installationId, title, notes, createdBy?.login ?? null, createdBy?.id ?? null)
    .first<{ id: number }>();
  return row!.id;
}

export async function getTodo(id: number): Promise<TodoRow | null> {
  return env.DB.prepare('SELECT * FROM todos WHERE id = ?1').bind(id).first<TodoRow>();
}

export async function deleteTodo(id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM todos WHERE id = ?1').bind(id).run();
}

export async function linkTodoToPlan(id: number, planId: number): Promise<void> {
  await env.DB.prepare('UPDATE todos SET plan_id = ?2 WHERE id = ?1').bind(id, planId).run();
}

export async function setPlanArchived(id: number, archived: boolean): Promise<void> {
  await env.DB.prepare('UPDATE plans SET archived = ?2 WHERE id = ?1')
    .bind(id, archived ? 1 : 0)
    .run();
}

import { sql } from 'drizzle-orm';
import { execute, queryOne, queryRows } from './database.ts';
import { bigintArray } from './sql.ts';

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
  return queryRows<TodoRow>(sql`
    SELECT * FROM app.todos
    WHERE installation_id = ANY(${bigintArray(installationIds)})
      AND plan_id IS NULL
    ORDER BY id DESC
  `);
}

export async function createTodo(
  installationId: number,
  title: string,
  notes: string | null,
  createdBy?: { login: string; id: number },
): Promise<number> {
  const row = await queryOne<{ id: number }>(sql`
    INSERT INTO app.todos (installation_id, title, notes, created_by_login, created_by_id)
    VALUES (
      ${installationId}, ${title}, ${notes},
      ${createdBy?.login ?? null}, ${createdBy?.id ?? null}
    )
    RETURNING id
  `);
  return row!.id;
}

export async function getTodo(id: number): Promise<TodoRow | null> {
  return queryOne<TodoRow>(sql`SELECT * FROM app.todos WHERE id = ${id}`);
}

export async function deleteTodo(id: number): Promise<void> {
  await execute(sql`DELETE FROM app.todos WHERE id = ${id}`);
}

export async function setPlanArchived(id: number, archived: boolean): Promise<void> {
  await execute(sql`UPDATE app.plans SET archived = ${archived} WHERE id = ${id}`);
}

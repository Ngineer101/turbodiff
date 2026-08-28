import { sql } from 'drizzle-orm';
import { execute, queryOne, queryRows } from './database.ts';

// --- cockpit chat: conversational turns with the fix
// sandbox's coding agent. One row per message; a user row's status tracks
// its turn through the queue ('queued' → 'running' → 'done'|'failed'),
// assistant rows are always 'done' and carry the turn's branch outcome.

export interface ChatMessageRow {
  id: number;
  feature_id: number;
  role: string; // 'user' | 'assistant'
  body: string;
  author: string | null; // login for user messages; null for assistant
  author_id: number | null; // GitHub/native user id for commit attribution
  status: string; // queued | running | done | failed (user rows)
  outcome: string | null; // assistant rows: changed | no_changes | tests_failed
  commit_sha: string | null; // assistant rows: the pushed commit
  error: string | null; // user rows that failed: short scrubbed reason
  created_at: string;
}

export async function createUserChatMessage(
  featureId: number,
  body: string,
  author: string,
  // GitHub/native user id completing the sender's noreply identity, so the
  // commit this turn pushes can carry them as git author.
  authorId?: number,
): Promise<number> {
  const row = await queryOne<{ id: number }>(sql`
    INSERT INTO app.chat_messages (feature_id, role, body, author, author_id, status)
    VALUES (${featureId}, 'user', ${body}, ${author}, ${authorId ?? null}, 'queued')
    RETURNING id
  `);
  return row!.id;
}

export async function getChatMessage(id: number): Promise<ChatMessageRow | null> {
  return queryOne<ChatMessageRow>(sql`SELECT * FROM app.chat_messages WHERE id = ${id}`);
}

export async function listChatMessages(featureId: number): Promise<ChatMessageRow[]> {
  return queryRows<ChatMessageRow>(sql`
    SELECT * FROM app.chat_messages WHERE feature_id = ${featureId} ORDER BY id ASC
  `);
}

export async function setChatMessageStatus(
  id: number,
  status: string,
  error?: string,
): Promise<void> {
  await execute(sql`
    UPDATE app.chat_messages SET status = ${status}, error = ${error ?? null} WHERE id = ${id}
  `);
}

export async function addAssistantChatMessage(
  featureId: number,
  body: string,
  outcome: string,
  commitSha?: string,
): Promise<number> {
  const row = await queryOne<{ id: number }>(sql`
    INSERT INTO app.chat_messages (feature_id, role, body, status, outcome, commit_sha)
    VALUES (${featureId}, 'assistant', ${body}, 'done', ${outcome}, ${commitSha ?? null})
    RETURNING id
  `);
  return row!.id;
}

// A user turn still in flight blocks new sends (one turn at a time — the
// same invariant the client's disabled input reflects).
export async function hasPendingChatTurn(featureId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(sql`
    SELECT id FROM app.chat_messages
    WHERE feature_id = ${featureId} AND role = 'user' AND status IN ('queued', 'running')
    LIMIT 1
  `);
  return row !== null;
}

// The last N messages, oldest first — the fresh-session prompt's context
// when no resumable CLI session survives.
export async function recentChatHistory(featureId: number, limit = 20): Promise<ChatMessageRow[]> {
  const rows = await queryRows<ChatMessageRow>(sql`
    SELECT * FROM app.chat_messages
    WHERE feature_id = ${featureId} ORDER BY id DESC LIMIT ${limit}
  `);
  return rows.reverse();
}

export async function setChatSessionId(featureId: number, sessionId: string | null): Promise<void> {
  await execute(sql`
    UPDATE app.features SET chat_session_id = ${sessionId} WHERE id = ${featureId}
  `);
}

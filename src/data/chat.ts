import { database } from './postgres.ts';

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
  const row = await database()
    .prepare(
      `INSERT INTO chat_messages (feature_id, role, body, author, author_id, status)
		 VALUES (?1, 'user', ?2, ?3, ?4, 'queued') RETURNING id`,
    )
    .bind(featureId, body, author, authorId ?? null)
    .first<{ id: number }>();
  return row!.id;
}

export async function getChatMessage(id: number): Promise<ChatMessageRow | null> {
  return database()
    .prepare('SELECT * FROM chat_messages WHERE id = ?1')
    .bind(id)
    .first<ChatMessageRow>();
}

export async function listChatMessages(featureId: number): Promise<ChatMessageRow[]> {
  const res = await database()
    .prepare('SELECT * FROM chat_messages WHERE feature_id = ?1 ORDER BY id ASC')
    .bind(featureId)
    .all<ChatMessageRow>();
  return res.results;
}

export async function setChatMessageStatus(
  id: number,
  status: string,
  error?: string,
): Promise<void> {
  await database()
    .prepare('UPDATE chat_messages SET status = ?2, error = ?3 WHERE id = ?1')
    .bind(id, status, error ?? null)
    .run();
}

export async function addAssistantChatMessage(
  featureId: number,
  body: string,
  outcome: string,
  commitSha?: string,
): Promise<number> {
  const row = await database()
    .prepare(
      `INSERT INTO chat_messages (feature_id, role, body, status, outcome, commit_sha)
		 VALUES (?1, 'assistant', ?2, 'done', ?3, ?4) RETURNING id`,
    )
    .bind(featureId, body, outcome, commitSha ?? null)
    .first<{ id: number }>();
  return row!.id;
}

// A user turn still in flight blocks new sends (one turn at a time — the
// same invariant the client's disabled input reflects).
export async function hasPendingChatTurn(featureId: number): Promise<boolean> {
  const row = await database()
    .prepare(
      `SELECT id FROM chat_messages
		 WHERE feature_id = ?1 AND role = 'user' AND status IN ('queued', 'running')
		 LIMIT 1`,
    )
    .bind(featureId)
    .first<{ id: number }>();
  return row !== null;
}

// The last N messages, oldest first — the fresh-session prompt's context
// when no resumable CLI session survives.
export async function recentChatHistory(featureId: number, limit = 20): Promise<ChatMessageRow[]> {
  const res = await database()
    .prepare('SELECT * FROM chat_messages WHERE feature_id = ?1 ORDER BY id DESC LIMIT ?2')
    .bind(featureId, limit)
    .all<ChatMessageRow>();
  return res.results.reverse();
}

export async function setChatSessionId(featureId: number, sessionId: string | null): Promise<void> {
  await database()
    .prepare('UPDATE features SET chat_session_id = ?2 WHERE id = ?1')
    .bind(featureId, sessionId)
    .run();
}

import { sql } from 'drizzle-orm';
import { queryOne, queryRows } from './postgres.ts';

export interface DeliveryMessageRow {
  id: number;
  delivery_id: number;
  organization_id: string;
  author_user_id: string | null;
  role: 'user' | 'assistant' | 'system';
  body: string;
  created_at: string;
}

export async function listDeliveryMessages(deliveryId: number): Promise<DeliveryMessageRow[]> {
  return queryRows<DeliveryMessageRow>(sql`
    SELECT * FROM app.delivery_messages WHERE delivery_id = ${deliveryId} ORDER BY id
  `);
}

export async function createDeliveryMessage(input: {
  delivery: { id: number; organization_id: string };
  authorUserId?: string | null;
  role: DeliveryMessageRow['role'];
  body: string;
}): Promise<DeliveryMessageRow> {
  const row = await queryOne<DeliveryMessageRow>(sql`
    INSERT INTO app.delivery_messages (delivery_id, organization_id, author_user_id, role, body)
    VALUES (
      ${input.delivery.id}, ${input.delivery.organization_id}, ${input.authorUserId ?? null},
      ${input.role}, ${input.body}
    )
    RETURNING *
  `);
  if (!row) throw new Error('delivery message insert returned no row');
  return row;
}

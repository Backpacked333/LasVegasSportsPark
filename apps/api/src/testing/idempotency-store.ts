import type { Db } from '@sportspark/db';
import { sql } from 'kysely';

/**
 * Whether any stored idempotency response contains `text` (§4.14: a one-time secret such as an
 * invitation, claim, export or calendar feed token must never rest in the idempotency store).
 */
export async function idempotencyStoreContains(db: Db, text: string): Promise<boolean> {
  const result = await sql<{ n: number }>`
    select count(*)::int as n from idempotency_keys
    where response_body is not null and strpos(response_body::text, ${text}) > 0
  `.execute(db);
  return (result.rows[0]?.n ?? 0) > 0;
}

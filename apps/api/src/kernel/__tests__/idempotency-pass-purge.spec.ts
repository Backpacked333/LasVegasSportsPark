import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing';

const MIGRATION = join(
  __dirname,
  '../../../../../packages/db/migrations/0012_core_idempotency_pass_reference_purge.sql',
);

/**
 * R2-CLIENTS-2-02 (§4.14, §4.9): migration 0012 strips the plain pass reference from pass-issue
 * answers stored before POST /v1/passes withheld it, and touches no other stored answer.
 */
describe('migration 0012: stored pass references are purged (R2-CLIENTS-2-02, §4.14)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ clockStart: '2026-10-31T12:00:00Z' });
  });
  afterAll(async () => {
    await t?.close();
  });

  const store = async (body: Record<string, unknown>) => {
    const key = `k-${newId()}`;
    await t.db
      .insertInto('idempotency_keys')
      .values({
        organization_id: t.organizationId,
        scope_key: 'test',
        idempotency_key: key,
        request_hash: 'h',
        status: 'completed',
        response_status: 201,
        response_body: json(body),
        operation_id: null,
        completed_at: new Date('2026-10-31T11:00:00Z'),
        expires_at: new Date('2026-11-01T11:00:00Z'),
      })
      .execute();
    return key;
  };
  const bodyOf = async (key: string) =>
    (
      await t.db
        .selectFrom('idempotency_keys')
        .select('response_body')
        .where('idempotency_key', '=', key)
        .executeTakeFirstOrThrow()
    ).response_body;

  it('§4.14: a stored pass-issue answer loses its reference and keeps the pass; other answers are unchanged', async () => {
    const passId = newId();
    const issued = await store({
      id: passId,
      pass: { id: passId, status: 'active' },
      reference: 'PASS-SECRET-1234',
    });
    const other = await store({ id: newId(), reference: 'ORDER-REF-1', status: 'open' });
    await sql.raw(readFileSync(MIGRATION, 'utf8')).execute(t.db);
    expect(await bodyOf(issued)).toEqual({ id: passId, pass: { id: passId, status: 'active' } });
    expect(JSON.stringify(await bodyOf(issued))).not.toContain('PASS-SECRET');
    expect(await bodyOf(other)).toMatchObject({ reference: 'ORDER-REF-1' });
  });
});

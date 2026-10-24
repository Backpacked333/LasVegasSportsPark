import { newId } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, isExclusionViolation, isUniqueViolation, tstzrange } from './helpers';
import { createTestDatabase, seedOrganization, type TestDatabase } from './testing';

describe('core schema invariants', () => {
  let t: TestDatabase;
  let organizationId: string;
  let facilityId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    ({ organizationId, facilityId } = await seedOrganization(t.db));
  });
  afterAll(async () => {
    await t.close();
  });

  it('parses bigint, timestamptz, and jsonb columns to usable JavaScript values', async () => {
    const row = await sql<{ big: number; ts: Date; doc: { a: number } }>`
      select 9007199254740991::bigint as big, now() as ts, '{"a":1}'::jsonb as doc
    `.execute(t.db);
    expect(row.rows[0]?.big).toBe(9007199254740991);
    expect(row.rows[0]?.ts).toBeInstanceOf(Date);
    expect(row.rows[0]?.doc).toEqual({ a: 1 });
  });

  it('audit records are append-only', async () => {
    const id = newId();
    await t.db
      .insertInto('audit_records')
      .values({
        id,
        organization_id: organizationId,
        actor: json({ kind: 'system', actorLabel: 'test' }),
        action: 'test.action',
        target_type: 'test',
        target_id: 'x',
        before_revision: null,
        after_revision: null,
        reason: null,
        correlation_id: null,
        operation_id: null,
      })
      .execute();
    await expect(
      t.db.updateTable('audit_records').set({ action: 'tampered' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(t.db.deleteFrom('audit_records').where('id', '=', id).execute()).rejects.toThrow(
      /append-only/,
    );
  });

  it('facility references cannot cross organizations (composite foreign key)', async () => {
    const other = await seedOrganization(t.db);
    await expect(
      t.db
        .insertInto('operational_exceptions')
        .values({
          id: newId(),
          organization_id: organizationId,
          facility_id: other.facilityId,
          category: 'test',
          severity: 'info',
          title: 'cross-org',
          affected_type: null,
          affected_id: null,
          owner_queue: 'ops',
          deadline_at: null,
          acknowledged_at: null,
          resolved_at: null,
          closed_at: null,
          resolution: null,
          dedupe_key: null,
        })
        .execute(),
    ).rejects.toThrow(/foreign key/);
    await t.db
      .insertInto('operational_exceptions')
      .values({
        id: newId(),
        organization_id: organizationId,
        facility_id: facilityId,
        category: 'test',
        severity: 'info',
        title: 'same-org',
        affected_type: null,
        affected_id: null,
        owner_queue: 'ops',
        deadline_at: null,
        acknowledged_at: null,
        resolved_at: null,
        closed_at: null,
        resolution: null,
        dedupe_key: 'dedupe-1',
      })
      .execute();
  });

  it('open exceptions deduplicate by key while allowing re-raise after closure', async () => {
    const insert = () =>
      t.db
        .insertInto('operational_exceptions')
        .values({
          id: newId(),
          organization_id: organizationId,
          facility_id: null,
          category: 'test',
          severity: 'warning',
          title: 'dup',
          affected_type: null,
          affected_id: null,
          owner_queue: 'ops',
          deadline_at: null,
          acknowledged_at: null,
          resolved_at: null,
          closed_at: null,
          resolution: null,
          dedupe_key: 'dedupe-2',
        })
        .execute();
    await insert();
    await expect(insert()).rejects.toSatisfy(isUniqueViolation);
    await t.db
      .updateTable('operational_exceptions')
      .set({ status: 'closed', closed_at: new Date() })
      .where('dedupe_key', '=', 'dedupe-2')
      .execute();
    await insert();
  });

  it('idempotency keys are unique per organization and scope', async () => {
    const row = {
      organization_id: organizationId,
      scope_key: 'account:a',
      idempotency_key: 'key-1234567',
      request_hash: 'h',
      status: 'in_progress' as const,
      response_status: null,
      response_body: null,
      operation_id: null,
      completed_at: null,
      expires_at: new Date(Date.now() + 60_000),
    };
    await t.db.insertInto('idempotency_keys').values(row).execute();
    await expect(t.db.insertInto('idempotency_keys').values(row).execute()).rejects.toSatisfy(
      isUniqueViolation,
    );
    await t.db
      .insertInto('idempotency_keys')
      .values({ ...row, scope_key: 'account:b' })
      .execute();
  });

  it('btree_gist exclusion constraints are available for reservation integrity', async () => {
    await sql`
      create table reservation_probe (
        id uuid primary key,
        organization_id uuid not null,
        unit text not null,
        during tstzrange not null,
        exclude using gist (organization_id with =, unit with =, during with &&)
      )
    `.execute(t.db);
    await t.db
      .insertInto('reservation_probe' as never)
      .values({
        id: newId(),
        organization_id: organizationId,
        unit: 'pitch-1',
        during: tstzrange('2026-10-23T18:00:00Z', '2026-10-23T19:10:00Z'),
      } as never)
      .execute();
    await expect(
      t.db
        .insertInto('reservation_probe' as never)
        .values({
          id: newId(),
          organization_id: organizationId,
          unit: 'pitch-1',
          during: tstzrange('2026-10-23T19:00:00Z', '2026-10-23T20:00:00Z'),
        } as never)
        .execute(),
    ).rejects.toSatisfy(isExclusionViolation);
  });

  it('outbox claim with FOR UPDATE SKIP LOCKED returns each pending event once', async () => {
    for (let i = 0; i < 3; i += 1) {
      await t.db
        .insertInto('outbox_events')
        .values({
          id: newId(),
          organization_id: organizationId,
          event_type: 'test.event',
          aggregate_type: 'test',
          aggregate_id: String(i),
          payload: json({ i }),
          correlation_id: null,
          causation_id: null,
          operation_id: null,
          last_error: null,
          locked_by: null,
          locked_until: null,
          dispatched_at: null,
          failure_owner: null,
        })
        .execute();
    }
    const claim = async (worker: string) =>
      t.db.transaction().execute(async (trx) => {
        const rows = await sql<{ id: string }>`
          with claimed as (
            select id from outbox_events
            where status = 'pending' and available_at <= now()
              and (locked_until is null or locked_until < now())
            order by available_at
            limit 2
            for update skip locked
          )
          update outbox_events o
          set locked_by = ${worker}, locked_until = now() + interval '30 seconds'
          from claimed where o.id = claimed.id
          returning o.id
        `.execute(trx);
        return rows.rows.map((r) => r.id);
      });
    const a = await claim('w1');
    const b = await claim('w2');
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(new Set([...a, ...b]).size).toBe(3);
  });
});

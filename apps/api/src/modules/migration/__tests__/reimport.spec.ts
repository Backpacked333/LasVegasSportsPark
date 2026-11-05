import type { StagedRow } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  stagedCredit,
  stagedHousehold,
  stagedObligation,
  stagedPerson,
  stagedRelationship,
} from '../testing/migration-fixtures';
import {
  countRows,
  get,
  grantLegacyAuthority,
  importSnapshot,
  key,
  migrationTestApp,
  post,
  rowsOf,
  staff,
  stageAndValidate,
  type Actor,
} from './support';

/** A representative family snapshot from the legacy system (neutral staging contract). */
function familySnapshot(): StagedRow[] {
  return [
    stagedPerson('P-100', {
      givenName: 'Maria',
      familyName: 'Lopez',
      dateOfBirth: '1986-05-04',
      email: 'maria@example.test',
      phone: '(702) 555-0100',
    }),
    stagedPerson('P-101', { givenName: 'Leo', familyName: 'Lopez', dateOfBirth: '2016-09-03' }),
    stagedPerson('P-102', {
      givenName: 'Ana',
      familyName: 'Lopez',
      dateOfBirth: '2018-01-20',
      kind: 'child',
    }),
    stagedHousehold('H-10', 'Lopez household', ['P-100', 'P-101', 'P-102']),
    stagedRelationship('R-1', { actorExternalId: 'P-100', subjectExternalId: 'P-101' }),
    stagedRelationship('R-2', { actorExternalId: 'P-100', subjectExternalId: 'P-102' }),
    {
      entityType: 'program',
      externalId: 'PRG-7',
      payload: { name: 'Junior Academy', activityType: 'soccer', status: 'active' },
    },
    stagedObligation('OB-1', { debtorExternalId: 'P-100', amountMinor: 12_500 }),
    stagedCredit('CR-1', { ownerExternalId: 'P-100', amountMinor: 2_000 }),
    // History: retained, never executed (§5.4).
    { entityType: 'order', externalId: 'ORD-55', payload: { totalMinor: 40_000, currency: 'USD' } },
    {
      entityType: 'refund',
      externalId: 'RF-9',
      payload: { amountMinor: 1_000, currency: 'USD', status: 'settled' },
    },
    {
      entityType: 'account',
      externalId: 'ACC-100',
      payload: { loginIdentifier: 'maria@example.test' },
    },
  ];
}

const TABLES = [
  'persons',
  'contact_points',
  'households',
  'household_memberships',
  'relationships',
  'access_grants',
  'programs',
  'enrollments',
  'obligations',
  'credits',
  'journals',
  'payment_attempts',
  'receipts',
  'refund_attempts',
  'notifications',
  'notification_recipients',
  'delivery_attempts',
] as const;

async function snapshotCounts(t: TestApp): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) out[table] = await countRows(t, table);
  return out;
}

describe('SPK-AT-024: a migration snapshot imported twice', () => {
  let t: TestApp;
  let operator: Actor;
  let first: Awaited<ReturnType<typeof importSnapshot>>;
  let afterFirst: Record<string, number>;

  beforeAll(async () => {
    t = await migrationTestApp();
    operator = await staff(t, ['general_manager']);
    await grantLegacyAuthority(t);
    first = await importSnapshot(t, operator, familySnapshot());
    await t.app.get(OutboxDispatcher).runOnce(500);
    afterFirst = await snapshotCounts(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-AT-024 / §5.4: the first import creates each record through its owning module, retains history, and charges or notifies no one', async () => {
    expect(first.status).toBe('applied');
    expect(first.outcomeCounts).toEqual({
      created: 9,
      matched: 0,
      updated: 0,
      skipped: 3,
      exception: 0,
    });
    const rows = await rowsOf(t, operator, first.id);
    const byId = new Map(rows.map((r) => [r.externalId, r]));
    expect(byId.get('ORD-55')?.reasons.map((r) => r.code)).toEqual(['retained_as_history']);
    expect(byId.get('ACC-100')?.reasons.map((r) => r.code)).toEqual(['credentials_never_imported']);
    // Persons, household, relationships, program, opening balances.
    expect(afterFirst.persons).toBe(1 + 3); // the operator plus three imported people
    expect(afterFirst.households).toBe(1);
    expect(afterFirst.household_memberships).toBe(3);
    expect(afterFirst.relationships).toBe(2);
    expect(afterFirst.access_grants).toBe(10);
    expect(afterFirst.programs).toBe(1);
    expect(afterFirst.obligations).toBe(1);
    expect(afterFirst.credits).toBe(1);
    // No payment execution and no customer-facing notification (§5.4).
    expect(afterFirst.enrollments).toBe(0);
    expect(afterFirst.payment_attempts).toBe(0);
    expect(afterFirst.receipts).toBe(0);
    expect(afterFirst.refund_attempts).toBe(0);
    expect(afterFirst.notifications).toBe(0);
    expect(afterFirst.delivery_attempts).toBe(0);
    const obligation = await t.db
      .selectFrom('obligations')
      .selectAll()
      .where('organization_id', '=', t.organizationId)
      .executeTakeFirstOrThrow();
    expect(obligation).toMatchObject({
      amount_minor: 12_500,
      currency: 'USD',
      status: 'open',
      source_kind: 'manual',
    });
    const person = await t.db
      .selectFrom('persons')
      .select(['kind', 'given_name'])
      .where('id', '=', byId.get('P-101')?.internalId as string)
      .executeTakeFirstOrThrow();
    expect(person).toEqual({ kind: 'child', given_name: 'Leo' });
    // Grants carry import provenance and exactly the staged permissions (never collect implied).
    const grants = await t.db
      .selectFrom('access_grants')
      .select(['permission', 'source'])
      .where('organization_id', '=', t.organizationId)
      .execute();
    expect(new Set(grants.map((g) => g.source))).toEqual(new Set(['import']));
    expect(grants.some((g) => g.permission === 'collect')).toBe(false);
    // Contact values are imported unverified: never keys, never logins.
    const contact = await t.db
      .selectFrom('contact_points')
      .select(['value', 'verified_at'])
      .where('person_id', '=', byId.get('P-100')?.internalId as string)
      .where('kind', '=', 'email')
      .executeTakeFirstOrThrow();
    expect(contact).toEqual({ value: 'maria@example.test', verified_at: null });
    // Contact values are compared as identity stores them: no duplicate on the post-create sync.
    expect(afterFirst.contact_points).toBe(2);
    expect(await countRows(t, 'accounts')).toBe(1); // only the operator's own account
  });

  it('SPK-AT-024: the same snapshot imported again matches every record, creates nothing, and changes no count', async () => {
    const second = await importSnapshot(t, operator, familySnapshot());
    expect(second.checksum).toBe(first.checksum);
    expect(second.sameChecksumBatchIds).toEqual([first.id]);
    expect(second.outcomeCounts).toEqual({
      created: 0,
      matched: 9,
      updated: 0,
      skipped: 3,
      exception: 0,
    });
    await t.app.get(OutboxDispatcher).runOnce(500);
    expect(await snapshotCounts(t)).toEqual(afterFirst);

    // Stable identities: each external id still reaches the same internal record.
    const [firstRows, secondRows] = [
      await rowsOf(t, operator, first.id),
      await rowsOf(t, operator, second.id),
    ];
    const firstIds = new Map(firstRows.map((r) => [r.externalId, r.internalId]));
    for (const row of secondRows) expect(row.internalId).toBe(firstIds.get(row.externalId) ?? null);
    const mapping = await get(
      t,
      '/v1/external-mappings?sourceSystem=legacy-registration&externalId=P-100',
      operator,
    );
    expect(mapping.status).toBe(200);
    expect(mapping.body.items).toHaveLength(1);
    expect(mapping.body.items[0]).toMatchObject({
      entityType: 'person',
      status: 'linked',
      internalId: firstIds.get('P-100'),
      firstSeenBatchId: first.id,
      lastSeenBatchId: second.id,
    });
  });

  it('SPK-AT-024: no customer-facing outbox event and no payment attempt exists after both imports', async () => {
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('organization_id', '=', t.organizationId)
      .execute();
    const types = new Set(events.map((e) => e.event_type));
    expect([...types].filter((type) => type.startsWith('communications.'))).toEqual([]);
    expect([...types].filter((type) => /payment|refund_requested|installment/.test(type))).toEqual(
      [],
    );
    expect(await countRows(t, 'payment_attempts')).toBe(0);
    expect(await countRows(t, 'notifications')).toBe(0);
    // Every outbox event was dispatched (handlers ran) and none produced a notice.
    const pending = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('organization_id', '=', t.organizationId)
      .where('status', '<>', 'dispatched')
      .execute();
    expect(pending).toEqual([]);
  });

  it('§4.9: applying an applied batch again changes nothing; the same key replays the stored response', async () => {
    const replayKey = key();
    const again = await post(t, `/v1/import-batches/${first.id}/apply`, operator, {}, replayKey);
    expect(again.status).toBe(200);
    expect(again.body.outcomeCounts).toEqual(first.outcomeCounts);
    const replay = await post(t, `/v1/import-batches/${first.id}/apply`, operator, {}, replayKey);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const conflict = await post(
      t,
      `/v1/import-batches/${first.id}/abort`,
      operator,
      { reason: 'x', expectedRevision: 1 },
      replayKey,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await snapshotCounts(t)).toEqual(afterFirst);
  });

  it('§4.8: the apply is a durable operation readable by its requester', async () => {
    const operation = await get(t, `/v1/operations/${first.appliedOperationId}`, operator);
    expect(operation.status).toBe(200);
    expect(operation.body).toMatchObject({
      kind: 'migration.apply_batch',
      status: 'succeeded',
      result: { batchId: first.id, counts: first.outcomeCounts },
    });
  });

  it('§5.4 / §5.6: a changed snapshot updates what the legacy system still owns and sends opening-balance changes to finance review', async () => {
    const changed = familySnapshot().map((row) => {
      if (row.externalId === 'P-101')
        return stagedPerson('P-101', {
          givenName: 'Leonardo',
          familyName: 'Lopez',
          dateOfBirth: '2016-09-03',
        });
      if (row.externalId === 'OB-1')
        return stagedObligation('OB-1', { debtorExternalId: 'P-100', amountMinor: 9_000 });
      return row;
    });
    const validated = await stageAndValidate(t, operator, changed);
    expect(validated.plannedCounts).toEqual({
      created: 0,
      matched: 7,
      updated: 1,
      skipped: 3,
      exception: 1,
    });
    const rows = await rowsOf(t, operator, validated.id);
    const obligationRow = rows.find((r) => r.externalId === 'OB-1');
    expect(obligationRow?.plannedOutcome).toBe('exception');
    expect(obligationRow?.reasons.map((r) => r.code)).toEqual(['opening_balance_changed']);
    const exceptions = await get(t, `/v1/import-exceptions?batchId=${validated.id}`, operator);
    expect(exceptions.body.items).toHaveLength(1);
    expect(exceptions.body.items[0]).toMatchObject({
      kind: 'ambiguous_balance',
      reviewOwnerRole: 'finance_operator',
      status: 'open',
    });
    const finance = await staff(t, ['finance_operator']);
    const decided = await post(
      t,
      `/v1/import-exceptions/${exceptions.body.items[0].id}/decide`,
      finance,
      {
        decision: 'defer',
        reason: 'Finance corrects the balance in the legacy ledger first.',
        expectedRevision: exceptions.body.items[0].revision,
      },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const batch = await get(t, `/v1/import-batches/${validated.id}`, operator);
    const reviewed = await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
      expectedRevision: batch.body.revision,
    });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const applied = await post(t, `/v1/import-batches/${validated.id}/apply`, operator, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.outcomeCounts).toEqual({
      created: 0,
      matched: 7,
      updated: 1,
      skipped: 3,
      exception: 1,
    });
    const firstRows = await rowsOf(t, operator, first.id);
    const person = await t.db
      .selectFrom('persons')
      .select('given_name')
      .where('id', '=', firstRows.find((r) => r.externalId === 'P-101')?.internalId as string)
      .executeTakeFirst();
    expect(person?.given_name).toBe('Leonardo');
    // The opening balance is never rewritten by an import.
    const obligation = await t.db
      .selectFrom('obligations')
      .select('amount_minor')
      .where('organization_id', '=', t.organizationId)
      .executeTakeFirstOrThrow();
    expect(obligation.amount_minor).toBe(12_500);
    expect(await countRows(t, 'payment_attempts')).toBe(0);
  });
});

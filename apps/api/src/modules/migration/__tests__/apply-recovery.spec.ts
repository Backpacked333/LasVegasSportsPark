import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../../testing';
import { createProgramFixture } from '../../catalog';
import { PeopleService } from '../../identity';
import { applyCorrelationId, importPrincipal } from '../migration.shared';
import { ImportTargets } from '../services/import-targets';
import { stagedCredit, stagedHousehold, stagedPerson } from '../testing/migration-fixtures';
import {
  countRows,
  exceptionsOf,
  expectPgError,
  get,
  grantLegacyAuthority,
  migrationTestApp,
  post,
  rowsOf,
  stageAndValidate,
  staff,
  type Actor,
} from './support';

const ACTOR = { kind: 'system', actorLabel: 'crashed-worker' };

describe('apply recovery and the per-source apply lock (§4.7 invariants 5 and 11, §4.12)', () => {
  let t: TestApp;
  let operator: Actor;

  beforeAll(async () => {
    t = await migrationTestApp();
    operator = await staff(t, ['system_administrator']);
    await grantLegacyAuthority(t);
  });
  afterAll(async () => {
    await t.close();
  });

  async function reviewed(
    rows: Parameters<typeof stageAndValidate>[2],
    sourceSystem = 'legacy-registration',
  ) {
    const validated = await stageAndValidate(t, operator, rows, { sourceSystem });
    const res = await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
      expectedRevision: validated.revision,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { id: string; revision: number };
  }

  async function runningOperation(): Promise<string> {
    const id = newId();
    await t.db
      .insertInto('operations')
      .values({
        id,
        organization_id: t.organizationId,
        kind: 'migration.apply_batch',
        status: 'running',
        requested_by: json(ACTOR),
        correlation_id: null,
        input: null,
        result: null,
        error: null,
        completed_at: null,
      })
      .execute();
    return id;
  }

  it('SPK-AT-024 / SPK-AT-023: an apply interrupted after the owning module created a record resumes without creating it again', async () => {
    const batch = await reviewed([
      stagedPerson('CR-1', { givenName: 'Crash', familyName: 'Survivor' }),
    ]);
    // Simulate the crash: the mapping was reserved, identity created the person (and audited it
    // with the mapping's correlation id), then the process died before the mapping was linked.
    const mappingId = newId();
    await t.db
      .insertInto('external_mappings')
      .values({
        id: mappingId,
        organization_id: t.organizationId,
        source_system: 'legacy-registration',
        entity_type: 'person',
        external_id: 'CR-1',
        person_id: null,
        household_id: null,
        relationship_id: null,
        program_id: null,
        obligation_id: null,
        credit_id: null,
        applied_payload_hash: null,
        first_seen_batch_id: batch.id,
        last_seen_batch_id: batch.id,
        provenance: json({ batchId: batch.id }),
        linked_at: null,
      })
      .execute();
    const created = await t.app.get(PeopleService).createPerson(
      importPrincipal(t.organizationId, batch.id),
      {
        kind: 'adult',
        givenName: 'Crash',
        familyName: 'Survivor',
        dateOfBirth: '1984-03-02',
        contactPoints: [],
      },
      applyCorrelationId(mappingId),
    );
    await t.db
      .updateTable('import_batches')
      .set({
        apply_started_at: t.clock.now(),
        apply_lock_operation_id: await runningOperation(),
        apply_lock_until: new Date(t.clock.now().getTime() + 60_000),
      })
      .where('id', '=', batch.id)
      .execute();
    const persons = await countRows(t, 'persons');

    // While the crashed apply's lease is valid, nobody else applies.
    const blocked = await post(t, `/v1/import-batches/${batch.id}/apply`, operator, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({ code: 'APPLY_IN_PROGRESS' });
    // An aborted or re-validated batch would pretend the created person does not exist (§5.8).
    const current = await get(t, `/v1/import-batches/${batch.id}`, operator);
    const abort = await post(t, `/v1/import-batches/${batch.id}/abort`, operator, {
      reason: 'x',
      expectedRevision: current.body.revision,
    });
    expect(abort.status).toBe(409);

    // After the lease, applying again resumes and links the record the interrupted apply created.
    t.clock.advance(16 * 60_000);
    const resumed = await post(t, `/v1/import-batches/${batch.id}/apply`, operator, {});
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.outcomeCounts).toEqual({
      created: 1,
      matched: 0,
      updated: 0,
      skipped: 0,
      exception: 0,
    });
    expect(await countRows(t, 'persons')).toBe(persons);
    const [row] = await rowsOf(t, operator, batch.id);
    expect(row).toMatchObject({ outcome: 'created', internalId: created.id });
    expect(row?.reasons.map((r) => r.code)).toEqual(['recovered_after_interruption']);
  });

  it('§4.7 invariant 11: two batches of one source system never apply at the same time', async () => {
    const first = await reviewed([stagedPerson('LK-1')], 'locked-source');
    const second = await reviewed([stagedPerson('LK-2')], 'locked-source');
    await t.db
      .updateTable('import_batches')
      .set({
        apply_started_at: t.clock.now(),
        apply_lock_operation_id: await runningOperation(),
        apply_lock_until: new Date(t.clock.now().getTime() + 60_000),
      })
      .where('id', '=', first.id)
      .execute();
    const refused = await post(t, `/v1/import-batches/${second.id}/apply`, operator, {});
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({
      code: 'SOURCE_APPLY_IN_PROGRESS',
      sourceSystem: 'locked-source',
    });
    // The refused attempt left nothing behind: no operation, no apply start.
    const after = await get(t, `/v1/import-batches/${second.id}`, operator);
    expect(after.body.applyStartedAt).toBeNull();
    // Another source system is independent.
    const other = await reviewed([stagedPerson('LK-3')], 'another-source');
    expect((await post(t, `/v1/import-batches/${other.id}/apply`, operator, {})).body.status).toBe(
      'applied',
    );
  });

  it('§5.4: a row whose record cannot be created any more becomes an apply-phase exception, not a silent drop', async () => {
    const batch = await reviewed([
      {
        entityType: 'program',
        externalId: 'PRG-late',
        payload: { name: 'Late Clash League', activityType: 'soccer' },
      },
    ]);
    // Between review and apply, staff create a program with the same name natively.
    await createProgramFixture(t, { name: 'Late Clash League' });
    const applied = await post(t, `/v1/import-batches/${batch.id}/apply`, operator, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.outcomeCounts).toEqual({
      created: 0,
      matched: 0,
      updated: 0,
      skipped: 0,
      exception: 1,
    });
    const exceptions = await exceptionsOf(t, operator, batch.id);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      kind: 'conflict',
      status: 'open',
      reviewOwnerRole: 'system_administrator',
    });
    expect(exceptions[0]?.reasons.map((r) => r.code)).toEqual(['program_name_exists']);
    const raw = await t.db
      .selectFrom('import_exceptions')
      .select('phase')
      .where('id', '=', exceptions[0]?.id as string)
      .executeTakeFirstOrThrow();
    expect(raw.phase).toBe('apply');
  });

  /**
   * Holds the first apply inside `method` (before the owning module opens its transaction), lets
   * the lease run out, applies again, then releases the first apply.
   */
  async function takeOverWhileCreating(
    method: 'issueOpeningCredit' | 'createHousehold',
    rows: Parameters<typeof stageAndValidate>[2],
    sourceSystem: string,
  ) {
    const batch = await reviewed(rows, sourceSystem);
    const targets = t.app.get(ImportTargets);
    const original = (targets[method] as (...args: unknown[]) => Promise<string>).bind(targets);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const spy = vi
      .spyOn(targets, method as 'issueOpeningCredit')
      .mockImplementationOnce(async (...args: unknown[]) => {
        entered();
        await gate;
        return original(...args);
      });
    const firstApply = post(t, `/v1/import-batches/${batch.id}/apply`, operator, {}).then(
      (res) => res,
    );
    await inside;
    // While the first apply's lease is valid, nobody else applies.
    const early = await post(t, `/v1/import-batches/${batch.id}/apply`, operator, {});
    expect(early.status).toBe(409);
    expect(early.body.details).toMatchObject({ code: 'APPLY_IN_PROGRESS' });
    // The first apply stalls past its lease; a second apply takes the batch over and finishes.
    t.clock.advance(16 * 60_000);
    const second = await post(t, `/v1/import-batches/${batch.id}/apply`, operator, {});
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.status).toBe('applied');
    release();
    const first = await firstApply;
    spy.mockRestore();
    return { batch, first, second, rows: await rowsOf(t, operator, batch.id) };
  }

  it('SPK-AT-024 / §4.7 invariants 5 and 7 (support-migration-05): an apply that lost its lock while creating never issues an opening credit twice', async () => {
    const { first, rows } = await takeOverWhileCreating(
      'issueOpeningCredit',
      [
        stagedPerson('TO-1'),
        stagedCredit('TO-CR', { ownerExternalId: 'TO-1', amountMinor: 2_500 }),
      ],
      'takeover-credit',
    );
    // The stale apply stops; finance refused its second credit for the same imported balance.
    expect(first.status).toBe(409);
    expect(first.body.details).toMatchObject({ code: 'APPLY_LOCK_LOST' });
    const owner = rows.find((r) => r.externalId === 'TO-1')?.internalId as string;
    const credits = await t.db
      .selectFrom('credits')
      .selectAll()
      .where('organization_id', '=', t.organizationId)
      .where('owner_person_id', '=', owner)
      .execute();
    expect(credits).toHaveLength(1);
    const credit = credits[0]!;
    const mapping = await t.db
      .selectFrom('external_mappings')
      .select(['id', 'credit_id', 'status'])
      .where('source_system', '=', 'takeover-credit')
      .where('external_id', '=', 'TO-CR')
      .executeTakeFirstOrThrow();
    expect(mapping).toMatchObject({ status: 'linked', credit_id: credit.id });
    expect(credit).toMatchObject({
      original_minor: 2_500,
      source_kind: 'adjustment',
      source_id: mapping.id,
    });
    // The database itself refuses a second credit for the same source fact.
    await expectPgError(
      t.db
        .insertInto('credits')
        .values({
          ...credit,
          id: newId(),
          permitted_uses: json(credit.permitted_uses),
          issued_by: json(credit.issued_by),
          approved_by: credit.approved_by === null ? null : json(credit.approved_by),
        })
        .execute(),
      '23505',
    );
  });

  it('SPK-AT-024 / §4.7 invariant 5 (support-migration-05): a household the stale apply created anyway is never silent — it is an owned exception and a reconciliation discrepancy', async () => {
    const { batch, first, rows } = await takeOverWhileCreating(
      'createHousehold',
      [stagedPerson('TO-P'), stagedHousehold('TO-H', 'Taken Over Household', ['TO-P'])],
      'takeover-household',
    );
    expect(first.status).toBe(409);
    expect(first.body.details).toMatchObject({ code: 'APPLY_LOCK_LOST' });
    const linked = rows.find((r) => r.externalId === 'TO-H')?.internalId as string;
    const households = await t.db
      .selectFrom('households')
      .select('id')
      .where('organization_id', '=', t.organizationId)
      .where('name', '=', 'Taken Over Household')
      .execute();
    // Identity has no import key for households: the stale apply's household exists, unlinked.
    expect(households).toHaveLength(2);
    const orphan = households.find((h) => h.id !== linked)?.id as string;
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue', 'status', 'details'])
      .where('organization_id', '=', t.organizationId)
      .where('affected_id', '=', orphan)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({
      category: 'migration.orphaned_creation',
      owner_queue: 'migration',
      status: 'open',
      details: expect.objectContaining({ entityType: 'household', internalId: orphan }),
    });
    const report = await post(
      t,
      `/v1/import-batches/${batch.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    expect(report.body.status).toBe('discrepancy');
    expect(report.body.discrepancies).toContainEqual(
      expect.objectContaining({
        level: 'record_identity',
        entityType: 'household',
        code: 'unlinked_creation',
        externalId: 'TO-H',
        internalId: orphan,
      }),
    );
  });

  it('SPK-AT-024 (MIG-02): an apply interrupted after reserving a record id resumes and creates exactly the reserved record, once', async () => {
    const batch = await reviewed(
      [stagedPerson('RS-1', { givenName: 'Reserved', familyName: 'Person' })],
      'reserved-source',
    );
    // The crash: the mapping reserved its record id and committed; the row's unit of work (the
    // identity import command, the link and the outcome) never committed.
    const reserved = newId();
    await t.db
      .insertInto('external_mappings')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        source_system: 'reserved-source',
        entity_type: 'person',
        external_id: 'RS-1',
        person_id: null,
        household_id: null,
        relationship_id: null,
        program_id: null,
        obligation_id: null,
        credit_id: null,
        reserved_record_id: reserved,
        applied_payload_hash: null,
        first_seen_batch_id: batch.id,
        last_seen_batch_id: batch.id,
        provenance: json({ batchId: batch.id }),
        linked_at: null,
      })
      .execute();
    await t.db
      .updateTable('import_batches')
      .set({
        apply_started_at: t.clock.now(),
        apply_lock_operation_id: await runningOperation(),
        apply_lock_until: new Date(t.clock.now().getTime() + 60_000),
      })
      .where('id', '=', batch.id)
      .execute();
    const persons = await countRows(t, 'persons');
    t.clock.advance(16 * 60_000);
    const resumed = await post(t, `/v1/import-batches/${batch.id}/apply`, operator, {});
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.outcomeCounts).toMatchObject({ created: 1, exception: 0 });
    expect(await countRows(t, 'persons')).toBe(persons + 1);
    const [row] = await rowsOf(t, operator, batch.id);
    expect(row).toMatchObject({ outcome: 'created', internalId: reserved });
    const person = await t.db
      .selectFrom('persons')
      .select(['id', 'source', 'given_name'])
      .where('id', '=', reserved)
      .executeTakeFirstOrThrow();
    expect(person).toEqual({ id: reserved, source: 'import', given_name: 'Reserved' });
    const mapping = await t.db
      .selectFrom('external_mappings')
      .select(['status', 'person_id', 'reserved_record_id'])
      .where('source_system', '=', 'reserved-source')
      .where('external_id', '=', 'RS-1')
      .executeTakeFirstOrThrow();
    expect(mapping).toEqual({
      status: 'linked',
      person_id: reserved,
      reserved_record_id: reserved,
    });
  });
});

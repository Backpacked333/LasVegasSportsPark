import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { AuditWriter } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createProgramFixture } from '../../catalog';
import { batchChecksum, payloadHash } from '../staging/checksum';
import { stagedObligation, stagedPerson, stagedRelationship } from '../testing/migration-fixtures';
import {
  customer,
  exceptionsOf,
  get,
  grantLegacyAuthority,
  importSnapshot,
  migrationTestApp,
  post,
  rowsOf,
  stageAndValidate,
  stageBody,
  staff,
  type Actor,
} from './support';

describe('import validation and review queues (§5.4)', () => {
  let t: TestApp;
  let operator: Actor;
  let support: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await migrationTestApp();
    operator = await staff(t, ['general_manager']);
    support = await staff(t, ['support_operator']);
    finance = await staff(t, ['finance_operator']);
    await grantLegacyAuthority(t);
  });
  afterAll(async () => {
    await t.close();
  });

  const decide = (actor: Actor, exception: { id: string; revision: number }, body: object) =>
    post(t, `/v1/import-exceptions/${exception.id}/decide`, actor, {
      expectedRevision: exception.revision,
      reason: 'reviewed against the paper registration form',
      ...body,
    });

  /** The batch's Today cards (`migration.import_review`), oldest first. */
  const reviewCards = (batchId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue', 'status', 'title', 'resolution'])
      .where('organization_id', '=', t.organizationId)
      .where('affected_type', '=', 'import_batch')
      .where('affected_id', '=', batchId)
      .orderBy('opened_at')
      .orderBy('id')
      .execute();

  /** A promise that stays pending until `open()`; `reached` resolves when someone waits on it. */
  function gate() {
    let open!: () => void;
    let arrive!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (arrive = resolve));
    return {
      reached,
      open,
      pass: async () => {
        arrive();
        await opened;
      },
    };
  }

  /** Tracks whether a request has settled; starts it now. */
  function tracked<T>(request: PromiseLike<T>) {
    const state = { done: false, promise: Promise.resolve(request) };
    void state.promise.then(
      () => (state.done = true),
      () => (state.done = true),
    );
    return state;
  }

  /**
   * Holds the first command that audits `action` inside its open transaction — after it wrote and
   * took its row locks, before it commits — until `open()`. Under TEST_DATABASE_URL `holder()` is
   * that transaction's backend pid.
   */
  function holdAtAudit(action: string) {
    const audit = t.app.get(AuditWriter);
    const record = audit.record.bind(audit);
    const held = gate();
    let armed = true;
    let holder: number | undefined;
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (trx, entry) => {
      if (armed && entry.action === action) {
        armed = false;
        if (t.database.concurrent) {
          const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
          holder = rows[0]?.pid;
        }
        await held.pass();
      }
      return record(trx, entry);
    });
    return { ...held, holder: () => holder, restore: () => spy.mockRestore() };
  }

  /**
   * TEST_DATABASE_URL: returns once `work` has settled or waits for a lock the held transaction
   * holds (so the two commands are truly concurrent). PGlite serializes transactions: `work` runs
   * once the held one commits, so there is nothing to wait for.
   */
  async function untilBlockedBy(holder: () => number | undefined, work: { done: boolean }) {
    if (!t.database.concurrent) return;
    for (let polls = 0; !work.done; polls += 1) {
      if (polls > 2000) throw new Error('the command neither finished nor waited for the lock');
      const pid = holder();
      if (pid !== undefined) {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from pg_stat_activity
          where ${pid} = any(pg_blocking_pids(pid))`.execute(t.db);
        if ((rows[0]?.n ?? 0) > 0) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('§5.4: ambiguous relationships enter the support review queue and are never imported as authority without a decision', async () => {
    const rows = [
      stagedPerson('A-1', { dateOfBirth: '1980-01-01' }),
      stagedPerson('A-2', { dateOfBirth: '1982-01-01' }),
      stagedPerson('C-1', { dateOfBirth: '2015-06-01' }),
      stagedPerson('C-2', { dateOfBirth: '2016-06-01' }),
      // Inferred from a shared household: not authority (§4.5).
      stagedRelationship('RE-inferred', {
        actorExternalId: 'A-2',
        subjectExternalId: 'C-1',
        basis: 'inferred',
      }),
      // Pickup permission always needs review.
      stagedRelationship('RE-collect', {
        actorExternalId: 'A-1',
        subjectExternalId: 'C-2',
        permissions: ['view', 'collect'],
      }),
      // Conflicting evidence for the same two people.
      stagedRelationship('RE-a', {
        actorExternalId: 'A-1',
        subjectExternalId: 'C-1',
        kind: 'guardian',
      }),
      stagedRelationship('RE-b', {
        actorExternalId: 'A-1',
        subjectExternalId: 'C-1',
        kind: 'delegate',
        permissions: ['view'],
      }),
      // Guardianship over an adult.
      stagedRelationship('RE-adult', { actorExternalId: 'A-1', subjectExternalId: 'A-2' }),
    ];
    const validated = await stageAndValidate(t, operator, rows);
    expect(validated.status).toBe('validated');
    expect(validated.plannedCounts).toEqual({
      created: 4,
      matched: 0,
      updated: 0,
      skipped: 0,
      exception: 5,
    });
    const exceptions = await exceptionsOf(t, operator, validated.id);
    expect(
      exceptions
        .map((e) => [e.externalId, e.kind, e.reviewOwnerRole, e.reasons.map((r) => r.code)])
        .sort(),
    ).toEqual([
      ['RE-a', 'ambiguous_relationship', 'support_operator', ['conflicting_evidence']],
      ['RE-adult', 'ambiguous_relationship', 'support_operator', ['guardian_of_adult']],
      ['RE-b', 'ambiguous_relationship', 'support_operator', ['conflicting_evidence']],
      ['RE-collect', 'ambiguous_relationship', 'support_operator', ['permission_requires_review']],
      ['RE-inferred', 'ambiguous_relationship', 'support_operator', ['basis_requires_review']],
    ]);

    // The review cannot complete while any exception is open.
    const early = await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
      expectedRevision: validated.revision,
    });
    expect(early.status).toBe(409);
    expect(early.body.details).toMatchObject({ code: 'OPEN_EXCEPTIONS', open: 5 });

    const byExternal = new Map(exceptions.map((e) => [e.externalId, e]));
    // Finance does not own the relationship queue.
    const wrongQueue = await decide(finance, byExternal.get('RE-collect')!, { decision: 'reject' });
    expect(wrongQueue.status).toBe(403);
    // A review narrows permissions; it never adds one that was not staged.
    const widened = await decide(support, byExternal.get('RE-collect')!, {
      decision: 'accept',
      resolution: { permissions: ['view', 'pay'] },
    });
    expect(widened.status).toBe(400);
    const accepted = await decide(support, byExternal.get('RE-collect')!, {
      decision: 'accept',
      resolution: { permissions: ['view'] },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({
      status: 'decided',
      decision: 'accept',
      resolution: { permissions: ['view'] },
    });
    // Stale revision: the decision was taken on an older version of the exception.
    const stale = await decide(support, byExternal.get('RE-collect')!, { decision: 'reject' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    expect(
      (await decide(support, byExternal.get('RE-inferred')!, { decision: 'reject' })).status,
    ).toBe(200);
    expect((await decide(support, byExternal.get('RE-a')!, { decision: 'accept' })).status).toBe(
      200,
    );
    expect((await decide(support, byExternal.get('RE-b')!, { decision: 'reject' })).status).toBe(
      200,
    );
    expect(
      (await decide(operator, byExternal.get('RE-adult')!, { decision: 'defer' })).status,
    ).toBe(200);

    const batch = await get(t, `/v1/import-batches/${validated.id}`, operator);
    const reviewed = await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
      expectedRevision: batch.body.revision,
    });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect(reviewed.body.status).toBe('reviewed');
    const applied = await post(t, `/v1/import-batches/${validated.id}/apply`, operator, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.outcomeCounts).toEqual({
      created: 6,
      matched: 0,
      updated: 0,
      skipped: 2,
      exception: 1,
    });

    const applyRows = await rowsOf(t, operator, validated.id);
    const id = (externalId: string) =>
      applyRows.find((r) => r.externalId === externalId)?.internalId as string;
    expect(applyRows.find((r) => r.externalId === 'RE-adult')?.outcome).toBe('exception');
    const grants = await t.db
      .selectFrom('access_grants')
      .select(['actor_person_id', 'subject_person_id', 'permission'])
      .where('organization_id', '=', t.organizationId)
      .where('subject_person_id', 'in', [id('C-1'), id('C-2'), id('A-2')])
      .execute();
    const held = grants.map(
      (g) =>
        `${g.actor_person_id === id('A-1') ? 'A-1' : 'A-2'}>${g.subject_person_id === id('C-1') ? 'C-1' : g.subject_person_id === id('C-2') ? 'C-2' : 'A-2'}:${g.permission}`,
    );
    // RE-collect accepted with view only; RE-a accepted (guardian, five permissions); nothing for
    // the rejected, deferred or inferred evidence; never collect.
    expect(held.sort()).toEqual(
      [
        'A-1>C-2:view',
        'A-1>C-1:view',
        'A-1>C-1:register',
        'A-1>C-1:pay',
        'A-1>C-1:receive_messages',
        'A-1>C-1:complete_forms',
      ].sort(),
    );
  });

  it('§5.4: ambiguous balances enter the finance queue; finance approves the opening amount or rejects it', async () => {
    const rows = [
      stagedPerson('F-1'),
      stagedObligation('OB-neg', { debtorExternalId: 'F-1', amountMinor: -500 }),
      stagedObligation('OB-disputed', {
        debtorExternalId: 'F-1',
        amountMinor: 7_000,
        disputed: true,
      }),
      stagedObligation('OB-parts', {
        debtorExternalId: 'F-1',
        amountMinor: 3_000,
        originalAmountMinor: 10_000,
        paidMinor: 6_000,
      }),
      stagedObligation('OB-zero', { debtorExternalId: 'F-1', amountMinor: 0 }),
      {
        entityType: 'refund' as const,
        externalId: 'RF-pending',
        payload: { amountMinor: 1_500, currency: 'USD', status: 'pending' },
      },
    ];
    const validated = await stageAndValidate(t, operator, rows);
    const exceptions = await exceptionsOf(t, operator, validated.id);
    expect(exceptions.map((e) => [e.externalId, e.kind, e.reviewOwnerRole]).sort()).toEqual([
      ['OB-disputed', 'ambiguous_balance', 'finance_operator'],
      ['OB-neg', 'ambiguous_balance', 'finance_operator'],
      ['OB-parts', 'ambiguous_balance', 'finance_operator'],
      ['RF-pending', 'ambiguous_balance', 'finance_operator'],
    ]);
    const byExternal = new Map(exceptions.map((e) => [e.externalId, e]));
    expect(byExternal.get('OB-parts')?.reasons.map((r) => r.code)).toEqual([
      'balance_components_disagree',
    ]);
    // Support does not own the finance queue.
    expect(
      (await decide(support, byExternal.get('OB-parts')!, { decision: 'accept' })).status,
    ).toBe(403);
    const approved = await decide(finance, byExternal.get('OB-parts')!, {
      decision: 'accept',
      resolution: { amountMinor: 4_000 },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await decide(finance, byExternal.get('OB-neg')!, { decision: 'reject' })).status).toBe(
      200,
    );
    expect(
      (await decide(finance, byExternal.get('OB-disputed')!, { decision: 'defer' })).status,
    ).toBe(200);
    expect(
      (await decide(finance, byExternal.get('RF-pending')!, { decision: 'accept' })).status,
    ).toBe(200);
    const batch = await get(t, `/v1/import-batches/${validated.id}`, operator);
    expect(
      (
        await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
          expectedRevision: batch.body.revision,
        })
      ).status,
    ).toBe(200);
    const applied = await post(t, `/v1/import-batches/${validated.id}/apply`, operator, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.outcomeCounts).toEqual({
      created: 2,
      matched: 0,
      updated: 0,
      skipped: 3,
      exception: 1,
    });
    const applyRows = await rowsOf(t, operator, validated.id);
    const obligation = await t.db
      .selectFrom('obligations')
      .select(['amount_minor', 'debtor_person_id'])
      .where('id', '=', applyRows.find((r) => r.externalId === 'OB-parts')?.internalId as string)
      .executeTakeFirstOrThrow();
    expect(obligation).toEqual({
      amount_minor: 4_000,
      debtor_person_id: applyRows.find((r) => r.externalId === 'F-1')?.internalId,
    });
    expect(applyRows.find((r) => r.externalId === 'OB-zero')?.reasons.map((r) => r.code)).toEqual([
      'nothing_owed',
    ]);
    expect(applyRows.find((r) => r.externalId === 'RF-pending')?.outcome).toBe('skipped');
    expect(await t.db.selectFrom('refund_attempts').select('id').execute()).toEqual([]);
    // Validation raised an owned Today card for the rows awaiting review; the completed review
    // settled it, and the apply (no exception left open) raised none (R2-LIFECYCLES-07).
    expect(await reviewCards(validated.id)).toEqual([
      {
        category: 'migration.import_review',
        owner_queue: 'migration',
        status: 'resolved',
        title: 'Import batch from legacy-registration has 4 rows awaiting review',
        resolution: { settlement: 'review_completed', batchId: validated.id },
      },
    ]);
  });

  it('§5.4: validation errors are reviewable row outcomes; dependent rows wait for their dependency; only rejection or deferral is possible', async () => {
    const rows = [
      {
        entityType: 'person' as const,
        externalId: 'V-1',
        payload: { familyName: 'NoGivenName', dateOfBirth: '1990-01-01' },
      },
      stagedPerson('V-2', { dateOfBirth: '2016-01-01', kind: 'adult' }),
      stagedPerson('V-3', { dateOfBirth: '1979-02-02' }),
      stagedRelationship('V-R', { actorExternalId: 'V-3', subjectExternalId: 'V-1' }),
      stagedRelationship('V-R2', { actorExternalId: 'V-3', subjectExternalId: 'NOT-STAGED' }),
    ];
    const validated = await stageAndValidate(t, operator, rows);
    const vrows = await rowsOf(t, operator, validated.id);
    const codes = (externalId: string) =>
      vrows.find((r) => r.externalId === externalId)?.reasons.map((r) => r.code);
    expect(codes('V-1')).toEqual(['invalid_payload']);
    expect(codes('V-2')).toEqual(['kind_contradicts_date_of_birth']);
    expect(codes('V-R')).toEqual(['dependency_unresolved']);
    expect(codes('V-R2')).toEqual(['reference_not_found']);
    const exceptions = await exceptionsOf(t, operator, validated.id);
    expect(new Set(exceptions.map((e) => `${e.kind}:${e.reviewOwnerRole}`))).toEqual(
      new Set(['validation:system_administrator']),
    );
    const v1 = exceptions.find((e) => e.externalId === 'V-1')!;
    const accept = await decide(operator, v1, { decision: 'accept' });
    expect(accept.status).toBe(400);
  });

  it('§5.6: a category SportsPark is authoritative for is never imported as a second writer', async () => {
    // A second organization has no legacy authority assignment: SportsPark is authoritative.
    const other = await seedOrganization(t.db);
    const gm = await staff(t, ['general_manager'], { organizationId: other.organizationId });
    const validated = await stageAndValidate(t, gm, [stagedPerson('S-1')]);
    const exceptions = await exceptionsOf(t, gm, validated.id);
    expect(exceptions.map((e) => [e.kind, e.reasons.map((r) => r.code)])).toEqual([
      ['conflict', ['sportspark_authoritative']],
    ]);
  });

  it('§5.4: staging accepts CSV, seals the checksum at validation, verifies declared checksums and row counts, and stages large snapshots in chunks', async () => {
    const csv = [
      'external_id,givenName,familyName,dateOfBirth,email',
      'CSV-1,"Jo, Jr.",Smith,1975-03-04,jo@example.test',
      'CSV-2,Sam,"O""Neil",2017-07-07,',
    ].join('\r\n');
    const staged = await post(t, '/v1/import-batches', operator, {
      ...stageBody([], { controlTotals: { counts: { person: 2 }, amounts: [] } }),
      csv: [{ entityType: 'person', content: csv }],
    });
    expect(staged.status, JSON.stringify(staged.body)).toBe(201);
    expect(staged.body).toMatchObject({ status: 'received', rowCount: 2, checksum: null });
    const validated = await post(t, `/v1/import-batches/${staged.body.id}/validate`, operator, {});
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);
    const expected = batchChecksum([
      {
        entityType: 'person',
        externalId: 'CSV-1',
        payloadHash: payloadHash({
          givenName: 'Jo, Jr.',
          familyName: 'Smith',
          dateOfBirth: '1975-03-04',
          email: 'jo@example.test',
        }),
      },
      {
        entityType: 'person',
        externalId: 'CSV-2',
        payloadHash: payloadHash({
          givenName: 'Sam',
          familyName: 'O"Neil',
          dateOfBirth: '2017-07-07',
        }),
      },
    ]);
    expect(validated.body.checksum).toBe(expected);
    expect(validated.body.validationSummary.controlTotals).toMatchObject({ balanced: true });
    // Appending after the batch is sealed is refused.
    const late = await post(t, `/v1/import-batches/${staged.body.id}/rows`, operator, {
      rows: [stagedPerson('CSV-3')],
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_TRANSITION');

    // Chunked staging with a declared checksum and row count.
    const all = [stagedPerson('K-1'), stagedPerson('K-2'), stagedPerson('K-3')];
    const checksum = batchChecksum(
      all.map((r) => ({
        entityType: r.entityType,
        externalId: r.externalId,
        payloadHash: payloadHash(r.payload),
      })),
    );
    const chunked = await post(
      t,
      '/v1/import-batches',
      operator,
      stageBody(all.slice(0, 2), {
        checksum,
        rowCount: 3,
        controlTotals: { counts: { person: 3 }, amounts: [] },
      }),
    );
    expect(chunked.status).toBe(201);
    const incomplete = await post(
      t,
      `/v1/import-batches/${chunked.body.id}/validate`,
      operator,
      {},
    );
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.details).toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    const duplicate = await post(t, `/v1/import-batches/${chunked.body.id}/rows`, operator, {
      rows: [stagedPerson('K-2')],
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.details).toMatchObject({ code: 'DUPLICATE_EXTERNAL_ID' });
    const rest = await post(t, `/v1/import-batches/${chunked.body.id}/rows`, operator, {
      rows: all.slice(2),
    });
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    expect(rest.body.rowCount).toBe(3);
    const sealed = await post(t, `/v1/import-batches/${chunked.body.id}/validate`, operator, {});
    expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
    expect(sealed.body.checksum).toBe(checksum);

    // A snapshot that lists the same external record twice is refused outright.
    const twice = await post(
      t,
      '/v1/import-batches',
      operator,
      stageBody([stagedPerson('D-1'), stagedPerson('D-1')]),
    );
    expect(twice.status).toBe(400);
    expect(twice.body.details).toMatchObject({ code: 'DUPLICATE_EXTERNAL_ID' });
  });

  it('§4.6 ImportBatch machine: apply needs a review; re-validation withdraws a review; abort is final; an applied batch cannot be aborted', async () => {
    const validated = await stageAndValidate(t, operator, [stagedPerson('M-1')]);
    const early = await post(t, `/v1/import-batches/${validated.id}/apply`, operator, {});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_TRANSITION');
    const reviewed = await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
      expectedRevision: validated.revision,
    });
    expect(reviewed.body.status).toBe('reviewed');
    const revalidated = await post(t, `/v1/import-batches/${validated.id}/validate`, operator, {});
    expect(revalidated.status).toBe(200);
    expect(revalidated.body).toMatchObject({ status: 'validated', reviewedAt: null });
    const staleAbort = await post(t, `/v1/import-batches/${validated.id}/abort`, operator, {
      reason: 'wrong snapshot',
      expectedRevision: validated.revision,
    });
    expect(staleAbort.status).toBe(409);
    expect(staleAbort.body.code).toBe('STALE_REVISION');
    const aborted = await post(t, `/v1/import-batches/${validated.id}/abort`, operator, {
      reason: 'wrong snapshot',
      expectedRevision: revalidated.body.revision,
    });
    expect(aborted.status).toBe(200);
    expect(aborted.body).toMatchObject({ status: 'aborted', abortReason: 'wrong snapshot' });
    const afterAbort = await post(t, `/v1/import-batches/${validated.id}/validate`, operator, {});
    expect(afterAbort.status).toBe(409);

    const done = await stageAndValidate(t, operator, [stagedPerson('M-2')]);
    await post(t, `/v1/import-batches/${done.id}/review`, operator, {
      expectedRevision: done.revision,
    });
    const applied = await post(t, `/v1/import-batches/${done.id}/apply`, operator, {});
    expect(applied.body.status).toBe('applied');
    const abortApplied = await post(t, `/v1/import-batches/${done.id}/abort`, operator, {
      reason: 'too late',
      expectedRevision: applied.body.revision,
    });
    expect(abortApplied.status).toBe(409);
    expect(abortApplied.body.code).toBe('INVALID_TRANSITION');
  });

  it('§4.6 ImportException machine: re-validation withdraws an exception whose cause is gone; a received batch can be aborted', async () => {
    const waiting = await stageAndValidate(t, operator, [
      stagedRelationship('W-R', { actorExternalId: 'W-A', subjectExternalId: 'W-C' }),
    ]);
    const before = await exceptionsOf(t, operator, waiting.id);
    expect(before.map((e) => [e.kind, e.status, e.reasons.map((r) => r.code)])).toEqual([
      ['validation', 'open', ['reference_not_found', 'reference_not_found']],
    ]);
    // The two people arrive with another batch of the same source.
    await importSnapshot(t, operator, [
      stagedPerson('W-A', { dateOfBirth: '1979-01-01' }),
      stagedPerson('W-C', { dateOfBirth: '2014-01-01' }),
    ]);
    const again = await post(t, `/v1/import-batches/${waiting.id}/validate`, operator, {});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({
      status: 'validated',
      plannedCounts: { created: 1, exception: 0 },
      exceptions: { open: 0, decided: 0, withdrawn: 1 },
    });
    expect((await exceptionsOf(t, operator, waiting.id)).map((e) => e.status)).toEqual([
      'withdrawn',
    ]);
    const third = await post(t, `/v1/import-batches/${waiting.id}/validate`, operator, {});
    expect(third.body).toMatchObject({
      status: 'validated',
      exceptions: { open: 0, withdrawn: 1 },
    });

    const staged = await post(t, '/v1/import-batches', operator, stageBody([stagedPerson('W-X')]));
    const aborted = await post(t, `/v1/import-batches/${staged.body.id}/abort`, operator, {
      reason: 'staged by mistake',
      expectedRevision: staged.body.revision,
    });
    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
    expect(aborted.body.status).toBe('aborted');
  });

  it('§4.6 R2-LIFECYCLES-07: aborting a batch withdraws its open exceptions, so no review queue keeps an item nothing can settle; a decision taken first stands', async () => {
    const validated = await stageAndValidate(t, operator, [
      stagedPerson('AB-A', { dateOfBirth: '1980-01-01' }),
      stagedPerson('AB-C', { dateOfBirth: '2015-01-01' }),
      stagedRelationship('AB-R1', {
        actorExternalId: 'AB-A',
        subjectExternalId: 'AB-C',
        basis: 'inferred',
      }),
      stagedRelationship('AB-R2', { actorExternalId: 'AB-A', subjectExternalId: 'AB-missing' }),
      stagedObligation('AB-OB', { debtorExternalId: 'AB-A', amountMinor: -500 }),
    ]);
    const raised = await exceptionsOf(t, operator, validated.id);
    expect(raised.map((e) => [e.externalId, e.reviewOwnerRole, e.status]).sort()).toEqual([
      ['AB-OB', 'finance_operator', 'open'],
      ['AB-R1', 'support_operator', 'open'],
      ['AB-R2', 'system_administrator', 'open'],
    ]);
    // Validation announced the rows awaiting review on Today.
    expect(await reviewCards(validated.id)).toMatchObject([
      {
        status: 'open',
        title: 'Import batch from legacy-registration has 3 rows awaiting review',
      },
    ]);
    const byExternal = new Map(raised.map((e) => [e.externalId, e]));
    // Finance settles its item before the batch is abandoned: that decision is kept.
    const rejected = await decide(finance, byExternal.get('AB-OB')!, { decision: 'reject' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const current = await get(t, `/v1/import-batches/${validated.id}`, operator);

    const aborted = await post(t, `/v1/import-batches/${validated.id}/abort`, operator, {
      reason: 'the export was taken from the wrong season',
      expectedRevision: current.body.revision,
    });
    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
    expect(aborted.body).toMatchObject({
      status: 'aborted',
      exceptions: { open: 0, decided: 1, withdrawn: 2 },
    });

    // The review owners' queues no longer list them (SCR-S-48 reads status=open).
    for (const role of ['support_operator', 'system_administrator', 'finance_operator']) {
      const queue = await get(
        t,
        `/v1/import-exceptions?batchId=${validated.id}&status=open&reviewOwnerRole=${role}`,
        operator,
      );
      expect(queue.status).toBe(200);
      expect(queue.body.items, role).toEqual([]);
    }
    const after = await exceptionsOf(t, operator, validated.id);
    expect(after.map((e) => [e.externalId, e.status]).sort()).toEqual([
      ['AB-OB', 'decided'],
      ['AB-R1', 'withdrawn'],
      ['AB-R2', 'withdrawn'],
    ]);
    const withdrawn = await t.db
      .selectFrom('import_exceptions')
      .select(['status', 'withdrawn_at', 'revision'])
      .where('organization_id', '=', t.organizationId)
      .where('batch_id', '=', validated.id)
      .where('status', '=', 'withdrawn')
      .execute();
    expect(withdrawn).toHaveLength(2);
    for (const row of withdrawn) {
      expect(row.withdrawn_at?.toISOString()).toBe(t.clock.now().toISOString());
      expect(row.revision).toBe(2);
    }
    // A withdrawn exception is final: deciding it is an invalid transition, not a stuck item.
    const late = await decide(
      support,
      after.find((e) => e.externalId === 'AB-R1')!,
      {
        decision: 'reject',
      },
    );
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_TRANSITION');
    // The abort's audit record carries its reason and how many exceptions it withdrew.
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['reason', 'details'])
      .where('organization_id', '=', t.organizationId)
      .where('action', '=', 'migration.abort_batch')
      .where('target_id', '=', validated.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      reason: 'the export was taken from the wrong season',
      details: { withdrawnExceptions: 2 },
    });
    // Today no longer says rows await review: the abort resolved the card in its transaction.
    expect(await reviewCards(validated.id)).toEqual([
      {
        category: 'migration.import_review',
        owner_queue: 'migration',
        status: 'resolved',
        title: 'Import batch from legacy-registration has 3 rows awaiting review',
        resolution: { settlement: 'batch_aborted', batchId: validated.id },
      },
    ]);
    const settled = await t.db
      .selectFrom('audit_records')
      .select(['actor', 'reason'])
      .where('organization_id', '=', t.organizationId)
      .where('action', '=', 'exceptions.resolved')
      .where('correlation_id', '=', aborted.headers['x-correlation-id'] as string)
      .execute();
    expect(settled).toMatchObject([
      {
        actor: { kind: 'system', actorLabel: 'migration.import_review' },
        reason: 'The import batch was aborted: its open exceptions were withdrawn.',
      },
    ]);
  });

  /** A validated batch with one open support exception (an inferred relationship). */
  async function batchWithOneException(prefix: string) {
    const validated = await stageAndValidate(t, operator, [
      stagedPerson(`${prefix}-A`, { dateOfBirth: '1980-01-01' }),
      stagedPerson(`${prefix}-C`, { dateOfBirth: '2015-01-01' }),
      stagedRelationship(`${prefix}-R`, {
        actorExternalId: `${prefix}-A`,
        subjectExternalId: `${prefix}-C`,
        basis: 'inferred',
      }),
    ]);
    const [exception] = await exceptionsOf(t, operator, validated.id);
    expect(exception?.status).toBe('open');
    return { validated, exception: exception! };
  }

  it('§4.6 / §4.9 R2-LIFECYCLES-07: a decision in flight when the abort arrives commits first; the abort waits for it and withdraws nothing (PGlite and TEST_DATABASE_URL)', async () => {
    const { validated, exception } = await batchWithOneException('RD');
    const held = holdAtAudit('migration.decide_exception');
    try {
      const deciding = tracked(decide(support, exception, { decision: 'reject' }));
      await held.reached;
      // The decision has written the exception and holds the batch row, uncommitted.
      const aborting = tracked(
        post(t, `/v1/import-batches/${validated.id}/abort`, operator, {
          reason: 'superseded by a later export',
          expectedRevision: validated.revision,
        }),
      );
      await untilBlockedBy(held.holder, aborting);
      held.open();
      const [decided, aborted] = await Promise.all([deciding.promise, aborting.promise]);
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
      expect(aborted.body.exceptions).toEqual({ open: 0, decided: 1, withdrawn: 0 });
    } finally {
      held.restore();
    }
    const [after] = await exceptionsOf(t, operator, validated.id);
    expect(after).toMatchObject({ status: 'decided', revision: exception.revision + 1 });
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('organization_id', '=', t.organizationId)
      .where('action', '=', 'migration.abort_batch')
      .where('target_id', '=', validated.id)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ withdrawnExceptions: 0 });
    expect(await reviewCards(validated.id)).toMatchObject([
      { status: 'resolved', resolution: { settlement: 'batch_aborted' } },
    ]);
  });

  it('§4.6 / §4.9 R2-LIFECYCLES-07: an abort in flight when a decision arrives commits first; the decision waits and is refused — the exception it read was withdrawn (PGlite and TEST_DATABASE_URL)', async () => {
    const { validated, exception } = await batchWithOneException('RW');
    const held = holdAtAudit('migration.abort_batch');
    try {
      const aborting = tracked(
        post(t, `/v1/import-batches/${validated.id}/abort`, operator, {
          reason: 'superseded by a later export',
          expectedRevision: validated.revision,
        }),
      );
      await held.reached;
      // The abort has withdrawn the exception and holds the batch row, uncommitted.
      const deciding = tracked(decide(support, exception, { decision: 'reject' }));
      await untilBlockedBy(held.holder, deciding);
      held.open();
      const [aborted, decided] = await Promise.all([aborting.promise, deciding.promise]);
      expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
      expect(aborted.body.exceptions).toEqual({ open: 0, decided: 0, withdrawn: 1 });
      // The reviewer decided the revision it had read; the withdrawal moved it on (§4.9).
      expect(decided.status, JSON.stringify(decided.body)).toBe(409);
      expect(decided.body.code).toBe('STALE_REVISION');
    } finally {
      held.restore();
    }
    const [after] = await exceptionsOf(t, operator, validated.id);
    expect(after).toMatchObject({ status: 'withdrawn', revision: exception.revision + 1 });
    // Re-read, the exception is final: deciding it is an invalid transition.
    const retried = await decide(support, after!, { decision: 'reject' });
    expect(retried.status).toBe(409);
    expect(retried.body.code).toBe('INVALID_TRANSITION');
    const row = await t.db
      .selectFrom('import_exceptions')
      .select(['decision', 'decided_at'])
      .where('organization_id', '=', t.organizationId)
      .where('id', '=', exception.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ decision: null, decided_at: null });
    const decisions = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('organization_id', '=', t.organizationId)
      .where('action', '=', 'migration.decide_exception')
      .where('target_id', '=', exception.id)
      .execute();
    expect(decisions).toEqual([]);
  });

  it('§5.11 / SPK-UX-006 R2-LIFECYCLES-07: an apply that leaves exceptions raises a Today card of its own; the last decision settles it, even when the last two decisions race (PGlite and TEST_DATABASE_URL)', async () => {
    const validated = await stageAndValidate(t, operator, [
      stagedPerson('AP-F'),
      stagedObligation('AP-OB', { debtorExternalId: 'AP-F', amountMinor: -500 }),
      ...['One', 'Two', 'Three'].map((n) => ({
        entityType: 'program' as const,
        externalId: `AP-PRG-${n}`,
        payload: { name: `Apply Card League ${n}`, activityType: 'soccer' },
      })),
    ]);
    const [balance] = await exceptionsOf(t, operator, validated.id);
    expect((await decide(finance, balance!, { decision: 'reject' })).status).toBe(200);
    const current = await get(t, `/v1/import-batches/${validated.id}`, operator);
    const reviewed = await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
      expectedRevision: current.body.revision,
    });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    // Between review and apply, staff create programs with the same names natively.
    for (const n of ['One', 'Two', 'Three']) {
      await createProgramFixture(t, { name: `Apply Card League ${n}` });
    }
    t.clock.advance(60_000);
    const applied = await post(t, `/v1/import-batches/${validated.id}/apply`, operator, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.exceptions).toEqual({ open: 3, decided: 1, withdrawn: 0 });
    // The validation card was settled by the review, so the apply's card is new and says so.
    expect(await reviewCards(validated.id)).toMatchObject([
      {
        status: 'resolved',
        title: 'Import batch from legacy-registration has 1 rows awaiting review',
        resolution: { settlement: 'review_completed' },
      },
      {
        status: 'open',
        title: 'Applied import batch from legacy-registration left 3 rows for review',
        resolution: null,
      },
    ]);
    const conflicts = (await exceptionsOf(t, operator, validated.id)).filter(
      (e) => e.status === 'open',
    );
    expect(conflicts.map((e) => e.kind)).toEqual(['conflict', 'conflict', 'conflict']);
    const [first, second, third] = conflicts;
    expect((await decide(operator, first!, { decision: 'defer' })).status).toBe(200);
    expect((await reviewCards(validated.id))[1]?.status).toBe('open');

    // The last two decisions race: the one held open has counted one exception still open.
    const held = holdAtAudit('migration.decide_exception');
    try {
      const deciding = tracked(decide(operator, second!, { decision: 'reject' }));
      await held.reached;
      const last = tracked(decide(operator, third!, { decision: 'reject' }));
      await untilBlockedBy(held.holder, last);
      held.open();
      const results = await Promise.all([deciding.promise, last.promise]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
    } finally {
      held.restore();
    }
    expect((await exceptionsOf(t, operator, validated.id)).map((e) => e.status).sort()).toEqual([
      'decided',
      'decided',
      'decided',
      'decided',
    ]);
    expect((await reviewCards(validated.id))[1]).toMatchObject({
      status: 'resolved',
      resolution: { settlement: 'apply_exceptions_decided', batchId: validated.id },
    });
  });

  it('§4.10 / §4.14: batches are protected records — cross-organization, customers and staff without migration authority get NOT_FOUND; the role matrix holds', async () => {
    const validated = await stageAndValidate(t, operator, [stagedPerson('Z-1')]);
    const parent = await customer(t);
    expect((await get(t, `/v1/import-batches/${validated.id}`, parent)).status).toBe(404);
    expect((await post(t, `/v1/import-batches/${validated.id}/apply`, parent, {})).status).toBe(
      404,
    );
    const coach = await staff(t, ['coach']);
    expect((await get(t, `/v1/import-batches/${validated.id}`, coach)).status).toBe(404);
    const other = await seedOrganization(t.db);
    const otherGm = await staff(t, ['general_manager'], { organizationId: other.organizationId });
    expect((await get(t, `/v1/import-batches/${validated.id}`, otherGm)).status).toBe(404);
    expect((await post(t, `/v1/import-batches/${validated.id}/validate`, otherGm, {})).status).toBe(
      404,
    );
    // Readers in the owning areas may read; only migration operators stage, validate or apply.
    expect((await get(t, `/v1/import-batches/${validated.id}`, finance)).status).toBe(200);
    expect((await post(t, `/v1/import-batches/${validated.id}/validate`, finance, {})).status).toBe(
      404,
    );
    const desk = await staff(t, ['front_desk']);
    expect(
      (await post(t, '/v1/import-batches', desk, stageBody([stagedPerson('Z-2')]))).status,
    ).toBe(403);
    expect(
      (await post(t, '/v1/import-batches', parent, stageBody([stagedPerson('Z-3')]))).status,
    ).toBe(403);
    const sysadmin = await staff(t, ['system_administrator']);
    expect(
      (await post(t, '/v1/import-batches', sysadmin, stageBody([stagedPerson('Z-4')]))).status,
    ).toBe(201);
    expect((await get(t, '/v1/import-exceptions', parent)).status).toBe(404);
    expect((await get(t, '/v1/external-mappings', coach)).status).toBe(404);
  });
});

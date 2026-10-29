import { newId, systemPrincipal } from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork, databaseConstraintOf } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { LedgerService } from '../ledger/ledger.service';
import { FakeAccountingProvider } from '../providers/fake-accounting.provider';
import { RECONCILE_ACCOUNTING_JOB } from '../services/accounting/accounting-export.service';
import { createObligationFixture } from '../testing/finance-fixtures';
import { adult, financeTestApp, post, staff, type Actor } from './support';

type Json = Record<string, unknown>;
const DAY = 86_400_000;

async function refusedBy(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const c = databaseConstraintOf(error);
    return c ? `${c.code}:${c.constraint ?? ''}` : (pgErrorCode(error) ?? String(error));
  }
  throw new Error('expected the database to refuse the statement');
}

describe('accounting export (FIN-07; §3.16 Accounting, SPK-PAY-010/011, DEC-016, DEC-081, DEC-022)', () => {
  let t: TestApp;
  let fo1: Actor;
  let fo2: Actor;
  let gm: Actor;
  let fake: FakeAccountingProvider;

  beforeAll(async () => {
    t = await financeTestApp();
    fo1 = await staff(t, ['finance_operator']);
    fo2 = await staff(t, ['finance_operator']);
    gm = await staff(t, ['general_manager']);
    fake = t.app.get(FakeAccountingProvider);
    fake.reset();
  });
  afterAll(async () => {
    await t.close();
  });

  /** A fresh day with one obligation posted on it (receivable against deferred revenue). */
  async function dayWithEntries(amountMinor = 5_000) {
    t.clock.advance(DAY);
    const start = new Date(t.clock.now().getTime() - 60_000);
    const debtor = await adult(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: debtor.personId,
      amountMinor,
    });
    return {
      obligationId,
      period: {
        periodStart: start.toISOString(),
        periodEnd: new Date(start.getTime() + DAY / 2).toISOString(),
      },
    };
  }

  async function approvedMapping(ledgerAccount: string, ref: string): Promise<Json> {
    const proposed = await post(t, '/v1/accounting-mappings', fo1.header, {
      ledgerAccount,
      externalAccountRef: ref,
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const approved = await post(
      t,
      `/v1/accounting-mappings/${proposed.body.id}/approve`,
      gm.header,
      { expectedRevision: proposed.body.revision },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    return approved.body as Json;
  }

  async function prepared(period: Json): Promise<Json & { id: string; revision: number }> {
    const res = await post(t, '/v1/accounting-export-batches', fo1.header, period);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Json & { id: string; revision: number };
  }

  async function submit(batch: { id: string; revision: number }) {
    return post(t, `/v1/accounting-export-batches/${batch.id}/submit`, fo1.header, {
      expectedRevision: batch.revision,
    });
  }

  it('DEC-016, DEC-081: with accounting disabled no mapping is proposed and no batch prepared; reads continue', async () => {
    const refused = await post(t, '/v1/accounting-mappings', fo1.header, {
      ledgerAccount: 'customer_receivable',
      externalAccountRef: '1200',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'accounting',
      applicabilityReferences: ['DEC-016', 'DEC-081'],
    });
    const batch = await post(t, '/v1/accounting-export-batches', fo1.header, {
      periodStart: '2026-11-01T00:00:00Z',
      periodEnd: '2026-11-02T00:00:00Z',
    });
    expect(batch.status).toBe(403);
    expect((await t.http.get('/v1/accounting-mappings').set(gm.header)).status).toBe(200);
    expect((await t.http.get('/v1/accounting-export-batches').set(fo1.header)).status).toBe(200);
    // Customers and desk staff never read or export.
    const desk = await staff(t, ['front_desk']);
    expect((await t.http.get('/v1/accounting-export-batches').set(desk.header)).status).toBe(403);
    await t.enableCapability('accounting');
  });

  it('the proposer cannot approve their own mapping (database check)', async () => {
    const proposed = await post(t, '/v1/accounting-mappings', fo1.header, {
      ledgerAccount: 'cash_on_hand',
      externalAccountRef: '1010 Cash drawers',
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ status: 'proposed', proposedByPersonId: fo1.personId });
    const self = await post(t, `/v1/accounting-mappings/${proposed.body.id}/approve`, fo1.header, {
      expectedRevision: proposed.body.revision,
    });
    expect(self.status).toBe(409);
    expect(self.body.details).toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    // The database refuses it whoever writes it.
    expect(
      await refusedBy(
        t.db
          .updateTable('accounting_mappings')
          .set({
            status: 'approved',
            approved_by_person_id: fo1.personId,
            approved_at: new Date(),
          })
          .where('id', '=', proposed.body.id as string)
          .execute(),
      ),
    ).toBe('23514:accounting_mappings_four_eyes');
    // Another finance operator approves it; a second approved mapping of the account is refused.
    const approved = await post(
      t,
      `/v1/accounting-mappings/${proposed.body.id}/approve`,
      fo2.header,
      { expectedRevision: proposed.body.revision },
    );
    expect(approved.body).toMatchObject({ status: 'approved', approvedByPersonId: fo2.personId });
    const rival = await post(t, '/v1/accounting-mappings', fo1.header, {
      ledgerAccount: 'cash_on_hand',
      externalAccountRef: '1011 Other',
    });
    const conflict = await post(t, `/v1/accounting-mappings/${rival.body.id}/approve`, fo2.header, {
      expectedRevision: rival.body.revision,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.details).toMatchObject({ code: 'MAPPING_ALREADY_APPROVED' });
    const withdrawn = await post(t, `/v1/accounting-mappings/${rival.body.id}/retire`, fo1.header, {
      reason: 'Duplicate proposal',
      expectedRevision: rival.body.revision,
    });
    expect(withdrawn.body.status).toBe('retired');
    const list = await t.http
      .get('/v1/accounting-mappings?ledgerAccount=cash_on_hand&status=approved')
      .set(gm.header);
    expect((list.body.items as Json[]).map((m) => m.id)).toEqual([proposed.body.id]);
  });

  it('SPK-PAY-011: an entry with an unmapped account blocks preparation and names the account', async () => {
    await approvedMapping('customer_receivable', '1200 Receivables');
    const { period } = await dayWithEntries();
    const blocked = await post(t, '/v1/accounting-export-batches', fo1.header, period);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toEqual({
      code: 'ACCOUNTING_MAPPING_REQUIRED',
      accounts: ['deferred_revenue'],
    });
    expect(await t.db.selectFrom('accounting_export_batches').select('id').execute()).toEqual([]);
    await approvedMapping('deferred_revenue', '2400 Deferred revenue');
    const batch = await prepared(period);
    expect(batch).toMatchObject({
      status: 'prepared',
      lineCount: 2,
      totals: [{ currency: 'USD', debitMinor: 5_000, creditMinor: 5_000 }],
    });
    expect((batch.lines as Json[]).map((l) => [l.ledgerAccount, l.externalAccountRef])).toEqual([
      ['customer_receivable', '1200 Receivables'],
      ['deferred_revenue', '2400 Deferred revenue'],
    ]);
    expect(batch.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    // At most once: nothing of the period is left for a second batch.
    const again = await post(t, '/v1/accounting-export-batches', fo1.header, period);
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ code: 'NOTHING_TO_EXPORT' });
    // A canceled batch gives its entries back.
    const canceled = await post(t, `/v1/accounting-export-batches/${batch.id}/cancel`, fo1.header, {
      reason: 'Wrong period',
    });
    expect(canceled.body).toMatchObject({ status: 'canceled', cancelReason: 'Wrong period' });
    expect((canceled.body.lines as Json[]).every((l) => l.live === false)).toBe(true);
    const redo = await prepared(period);
    expect(redo.lineCount).toBe(2);
    await post(t, `/v1/accounting-export-batches/${redo.id}/cancel`, fo1.header, {
      reason: 'tidy',
    });
  });

  it('SPK-PAY-010: a correction posted after export goes into the next batch and the exported batch is unchanged', async () => {
    const { obligationId, period } = await dayWithEntries(7_500);
    const first = await prepared(period);
    const sent = await submit(first);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ status: 'accepted', providerReference: expect.any(String) });
    const exported = await t.http.get(`/v1/accounting-export-batches/${first.id}`).set(gm.header);
    // A correction: the obligation's posting is reversed later (SPK-PAY-010, never an edit).
    t.clock.advance(DAY);
    await t.app.get(UnitOfWork).run(({ trx }) =>
      t.app.get(LedgerService).reverse(trx, {
        organizationId: t.organizationId,
        sourceType: 'obligation',
        sourceId: obligationId,
        purpose: 'obligation_created',
        reversalPurpose: 'obligation_canceled',
        description: 'Charged in error',
        actor: systemPrincipal(t.organizationId, 'test'),
      }),
    );
    const nextPeriod = {
      periodStart: period.periodStart,
      periodEnd: new Date(t.clock.now().getTime() + 60_000).toISOString(),
    };
    const second = await prepared(nextPeriod);
    expect(second.lineCount).toBe(2);
    expect(
      (second.lines as Json[]).map((l) => [l.ledgerAccount, l.debitMinor, l.creditMinor]),
    ).toEqual([
      ['customer_receivable', 0, 7_500],
      ['deferred_revenue', 7_500, 0],
    ]);
    const still = await t.http.get(`/v1/accounting-export-batches/${first.id}`).set(gm.header);
    expect(still.body).toEqual(exported.body);
    await post(t, `/v1/accounting-export-batches/${second.id}/cancel`, fo1.header, {
      reason: 'tidy',
    });
  });

  it('a rejected batch frees its entries for a new batch; the connection records each key once', async () => {
    const { period } = await dayWithEntries(1_200);
    const batch = await prepared(period);
    fake.scriptSubmissions('reject');
    const rejected = await submit(batch);
    expect(rejected.body).toMatchObject({ status: 'rejected', providerReference: null });
    expect((rejected.body.lines as Json[]).every((l) => l.live === false)).toBe(true);
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue'])
      .where('category', '=', 'finance.accounting_export_rejected')
      .where('affected_id', '=', batch.id)
      .executeTakeFirstOrThrow();
    expect(exception.owner_queue).toBe('finance_operator');
    // Submitting a decided batch again is refused by the machine.
    const twice = await submit({ id: batch.id, revision: rejected.body.revision as number });
    expect(twice.status).toBe(409);
    const retry = await prepared(period);
    const accepted = await submit(retry);
    expect(accepted.body.status).toBe('accepted');
  });

  it('§4.11, §4.12: a lost answer is unknown, and the job reconciles it without a second batch', async () => {
    // The connection kept the batch but its answer was lost.
    const kept = await prepared((await dayWithEntries(2_000)).period);
    fake.scriptSubmissions('timeout_accepted');
    const unknown = await submit(kept);
    expect(unknown.body).toMatchObject({ status: 'unknown', lastError: expect.any(String) });
    // The request never arrived: the job resubmits with the same key.
    const lost = await prepared((await dayWithEntries(2_100)).period);
    fake.scriptSubmissions('timeout_lost');
    expect((await submit(lost)).body.status).toBe('unknown');
    const recordedBefore = fake.recordedBatches();
    const summaries = await t.runPeriodicJobs([RECONCILE_ACCOUNTING_JOB]);
    expect(summaries[0]).toMatchObject({ ran: true, failed: false });
    const keptAfter = await t.http.get(`/v1/accounting-export-batches/${kept.id}`).set(gm.header);
    expect(keptAfter.body).toMatchObject({
      status: 'accepted',
      providerReference: expect.any(String),
    });
    const lostAfter = await t.http.get(`/v1/accounting-export-batches/${lost.id}`).set(gm.header);
    expect(lostAfter.body.status).toBe('accepted');
    expect(fake.recordedBatches()).toBe(recordedBefore + 1);
    const keys = fake.submissions.map((s) => s.idempotencyKey);
    const lostKey = fake.submissions.find((s) => s.batchId === lost.id)?.idempotencyKey;
    expect(keys.filter((k) => k === lostKey)).toHaveLength(2);
  });

  it('§4.12: a batch left submitted by a stopped process is asked about once it is stale, never before', async () => {
    const batch = await prepared((await dayWithEntries(3_300)).period);
    // A process committed `submitted` and stopped before calling the connection.
    await t.db
      .updateTable('accounting_export_batches')
      .set({ status: 'submitted', submitted_at: t.clock.now(), revision: batch.revision + 1 })
      .where('id', '=', batch.id)
      .execute();
    await t.runPeriodicJobs([RECONCILE_ACCOUNTING_JOB]);
    expect(
      (await t.http.get(`/v1/accounting-export-batches/${batch.id}`).set(gm.header)).body.status,
    ).toBe('submitted');
    t.clock.advance(301_000); // past FINANCE_ACCOUNTING_SUBMIT_STALE_SECONDS (300)
    await t.runPeriodicJobs([RECONCILE_ACCOUNTING_JOB]);
    expect(
      (await t.http.get(`/v1/accounting-export-batches/${batch.id}`).set(gm.header)).body.status,
    ).toBe('accepted');
  });

  it('§4.7 invariant 5: the database exports an entry at most once and never edits or deletes an export line', async () => {
    const { period } = await dayWithEntries(900);
    const batch = await prepared(period);
    const line = await t.db
      .selectFrom('accounting_export_lines')
      .selectAll()
      .where('batch_id', '=', batch.id)
      .orderBy('line_number')
      .executeTakeFirstOrThrow();
    const other = await prepared((await dayWithEntries(901)).period);
    expect(
      await refusedBy(
        t.db
          .insertInto('accounting_export_lines')
          .values({
            ...line,
            id: newId(),
            batch_id: other.id,
            line_number: 99,
            created_at: new Date(),
          })
          .execute(),
      ),
    ).toBe('23505:accounting_export_lines_live_entry_idx');
    expect(
      await refusedBy(
        t.db
          .updateTable('accounting_export_lines')
          .set({ external_account_ref: 'changed' })
          .where('id', '=', line.id)
          .execute(),
      ),
    ).toMatch(/^23001/);
    expect(
      await refusedBy(
        t.db
          .updateTable('accounting_export_lines')
          .set({ live: false })
          .where('id', '=', line.id)
          .execute(),
      ),
    ).toMatch(/^23001/);
    expect(
      await refusedBy(
        t.db.deleteFrom('accounting_export_lines').where('id', '=', line.id).execute(),
      ),
    ).toMatch(/^23001/);
    expect(
      await refusedBy(
        t.db
          .updateTable('accounting_export_batches')
          .set({ status: 'accepted' })
          .where('id', '=', batch.id)
          .execute(),
      ),
    ).toBe('23514:accounting_export_batches_machine');
    for (const b of [batch, other]) {
      await post(t, `/v1/accounting-export-batches/${b.id}/cancel`, fo1.header, { reason: 'tidy' });
    }
  });

  it('DEC-016: once disabled, preparation and submission stop; cancel and reconciliation continue', async () => {
    const batch = await prepared((await dayWithEntries(450)).period);
    await t.disableCapability('accounting');
    try {
      expect((await submit(batch)).status).toBe(403);
      const canceled = await post(
        t,
        `/v1/accounting-export-batches/${batch.id}/cancel`,
        fo1.header,
        {
          reason: 'Accounting connection paused',
        },
      );
      expect(canceled.body.status).toBe('canceled');
      expect((await t.runPeriodicJobs([RECONCILE_ACCOUNTING_JOB]))[0]?.failed).toBe(false);
    } finally {
      await t.enableCapability('accounting');
    }
  });
});

import type { TimelineEntry } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, PeriodicJobRegistry, PeriodicJobRunner, UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  PaymentReceived,
  createCapturedPaymentFixture,
  createObligationFixture,
} from '../../finance';
import { createPersonFixture } from '../../identity';
import {
  BACKFILL_TIMELINE_JOB,
  TimelineBackfillService,
} from '../services/timeline-backfill.service';
import { INDEXED_EVENT_TYPES } from '../services/timeline-indexer.service';
import {
  adultCustomer,
  childOf,
  drainOutbox,
  get,
  offering,
  post,
  registerAndPay,
  staffMember,
  supportTestApp,
  type Actor,
} from './support';

/**
 * SUP-03 (SPK-SUPPORT-001 timeline, §4.12 replayable facts, SPK-AT-023): the timeline index is
 * rebuilt from the kernel's outbox history by `support.backfill_timeline`; cash tenders come from
 * finance; every source pages with its own keyset.
 */
describe('timeline backfill and paged sources (SUP-03)', () => {
  let t: TestApp;
  let operator: Actor;
  let runner: PeriodicJobRunner;

  beforeAll(async () => {
    t = await supportTestApp();
    operator = await staffMember(t, ['support_operator']);
    runner = t.app.get(PeriodicJobRunner);
  });
  afterAll(async () => {
    await t.close();
  });

  const timelineOf = async (personId: string, query = '?limit=200') => {
    const res = await get(t, `/v1/customers/${personId}/timeline${query}`, operator);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      entries: TimelineEntry[];
      nextCursor: string | null;
      sources: Array<{ source: string; status: string; count: number }>;
    };
  };
  const indexRows = () =>
    t.db
      .selectFrom('timeline_references')
      .select(['source_event_id', 'person_id', 'record_type', 'record_id'])
      .where('organization_id', '=', t.organizationId)
      .orderBy('id')
      .execute();
  /** The indexed events are marked dispatched as if delivered before support's handlers existed. */
  const deliverWithoutSupport = async () => {
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'dispatched', dispatched_at: t.clock.now() })
      .where('organization_id', '=', t.organizationId)
      .where('status', '=', 'pending')
      .where('event_type', 'in', [...INDEXED_EVENT_TYPES])
      .execute();
    await drainOutbox(t);
  };
  const backfill = async (options: { restart?: boolean } = {}) => {
    await t.app.get(TimelineBackfillService).request(t.organizationId, options);
    const [summary] = await runner.runOnce([BACKFILL_TIMELINE_JOB], { ignoreInterval: true });
    expect(summary).toMatchObject({ ran: true, failed: false });
    return summary!;
  };

  it('is registered every 300 seconds, owned by the support operator queue (§4.12)', () => {
    expect(t.app.get(PeriodicJobRegistry).get(BACKFILL_TIMELINE_JOB)).toMatchObject({
      intervalSeconds: 300,
      failureOwner: 'support_operator',
    });
  });

  it('SPK-SUPPORT-001: events committed before support indexed them appear on the timeline after the backfill', async () => {
    const parent = await adultCustomer(t);
    const child = await childOf(t, [parent]);
    const paid = await registerAndPay(t, parent, child, await offering(t, 8_000));
    await deliverWithoutSupport();
    const before = await timelineOf(parent.personId);
    expect(before.entries.map((e) => e.kind)).not.toContain('payment.succeeded');

    const summary = await backfill();
    expect(summary.processed).toBeGreaterThan(0);
    const cursor = await t.db
      .selectFrom('support_timeline_backfill_cursors')
      .selectAll()
      .where('organization_id', '=', t.organizationId)
      .executeTakeFirstOrThrow();
    expect(cursor.completed_at).not.toBeNull();
    const after = await timelineOf(parent.personId);
    expect(after.entries.find((e) => e.kind === 'payment.succeeded')).toMatchObject({
      personId: parent.personId,
      record: { type: 'payment_attempt', id: paid.paymentAttemptId },
      amount: { amountMinor: 8_000, currency: 'USD' },
    });
  });

  it('a second backfill run indexes nothing twice', async () => {
    const before = await indexRows();
    expect(before.length).toBeGreaterThan(0);
    const again = await backfill({ restart: true });
    expect(again.processed).toBeGreaterThan(0);
    expect(await indexRows()).toEqual(before);
    // The live handlers replaying the same events add nothing either.
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null, available_at: t.clock.now() })
      .where('organization_id', '=', t.organizationId)
      .where('event_type', 'in', [...INDEXED_EVENT_TYPES])
      .execute();
    await drainOutbox(t);
    expect(await indexRows()).toEqual(before);
    // A completed backfill with no new request does nothing.
    const [idle] = await runner.runOnce([BACKFILL_TIMELINE_JOB], { ignoreInterval: true });
    expect(idle).toMatchObject({ ran: true, failed: false, processed: 0, remaining: 0 });
  });

  it('a cash tender appears on the payer’s timeline; a person with 250 payments pages through all of them', async () => {
    // A cash tender (finance's receipt without a payment attempt), read from finance (FIN-02).
    const payer = await createPersonFixture(t, { kind: 'adult' });
    const desk = await staffMember(t, ['front_desk']);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: payer,
      amountMinor: 3_500,
    });
    const tender = await post(t, '/v1/cash-tenders', desk, {
      obligationId,
      facilityId: t.facilityId,
      tenderKind: 'cash',
      amountMinor: 3_500,
      currency: 'USD',
      evidence: { reference: 'DRAWER-7', notes: 'Paid at the desk' },
    });
    expect(tender.status, JSON.stringify(tender.body)).toBe(201);
    await drainOutbox(t);
    const withTender = await timelineOf(payer);
    expect(withTender.sources.find((s) => s.source === 'finance.cash_tenders')).toMatchObject({
      status: 'ok',
      count: 1,
    });
    const cash = withTender.entries.find((e) => e.record.type === 'cash_tender');
    expect(cash).toMatchObject({
      category: 'payment',
      kind: 'cash_tender.recorded',
      personId: payer,
      record: { id: tender.body.id },
      amount: { amountMinor: 3_500, currency: 'USD' },
      facilityId: t.facilityId,
    });
    // Never the tender's evidence or who recorded it (§4.14).
    const text = JSON.stringify(withTender);
    expect(text).not.toContain('DRAWER-7');
    expect(text).not.toContain(desk.personId);

    // 250 provider payments, each announced by finance's payment_received event.
    const busy = await createPersonFixture(t, { kind: 'adult' });
    const uow = t.app.get(UnitOfWork);
    const outbox = t.app.get(Outbox);
    const payments: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      const p = await createCapturedPaymentFixture(t, {
        payerPersonId: busy,
        amountMinor: 100 + i,
      });
      payments.push(p.paymentAttemptId);
      await uow.run(({ trx }) =>
        outbox.enqueue(trx, PaymentReceived, {
          organizationId: t.organizationId,
          aggregateType: 'payment_attempt',
          aggregateId: p.paymentAttemptId,
          payload: {
            organizationId: t.organizationId,
            receiptId: p.receiptId,
            paymentAttemptId: p.paymentAttemptId,
            cashTenderId: null,
            obligationId: p.obligationId,
            amountMinor: 100 + i,
            allocatedMinor: 100 + i,
            excessMinor: 0,
            currency: 'USD',
          },
        }),
      );
      t.clock.advance(1_000);
    }
    await deliverWithoutSupport();
    await backfill();
    const seen: string[] = [];
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const res = await timelineOf(
        busy,
        `?limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.entries.length).toBeLessThanOrEqual(60);
      ids.push(...res.entries.map((e) => e.id));
      seen.push(
        ...res.entries.filter((e) => e.record.type === 'payment_attempt').map((e) => e.record.id),
      );
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(ids).size).toBe(ids.length);
    expect(seen).toHaveLength(250);
    expect(new Set(seen)).toEqual(new Set(payments));
    // Newest first across pages.
    const newestFirst = [...payments].reverse();
    expect(seen).toEqual(newestFirst);
  }, 120_000);
});

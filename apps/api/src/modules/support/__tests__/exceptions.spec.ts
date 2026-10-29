import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationalExceptions } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createCapturedPaymentFixture } from '../../finance';
import { createPersonFixture } from '../../identity';
import {
  get,
  key,
  otherOrganization,
  patch,
  post,
  staffMember,
  supportTestApp,
  type Actor,
} from './support';

/**
 * Operational exception workflow (§4.4 Exception, SPK-UX-006, §5.11): acknowledge, resolve and
 * close through the kernel with audit records and resolution history, queue scope and service
 * levels, and the guarantee that the affected record is never changed.
 */
describe('operational exceptions (SPK-UX-006)', () => {
  let t: TestApp;
  let manager: Actor;
  let operator: Actor;
  let desk: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await supportTestApp();
    manager = await staffMember(t, ['general_manager']);
    operator = await staffMember(t, ['support_operator']);
    desk = await staffMember(t, ['front_desk']);
    finance = await staffMember(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  const raise = async (
    input: Partial<Parameters<OperationalExceptions['raise']>[1]> = {},
    organizationId = t.organizationId,
  ) =>
    (
      await t.db.transaction().execute((trx) =>
        t.app.get(OperationalExceptions).raise(trx, {
          organizationId,
          facilityId: null,
          category: 'communications.delivery_failed',
          severity: 'warning',
          title: 'A notice could not be delivered',
          ownerQueue: 'front_desk',
          ...input,
        }),
      )
    ).id;

  it('SPK-UX-006: acknowledge → resolve → close each go through the kernel, are audited and form the resolution history', async () => {
    const id = await raise();
    const ack = await post(t, `/v1/exceptions/${id}/acknowledge`, operator, {
      expectedRevision: 1,
    });
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    expect(ack.body).toMatchObject({ status: 'acknowledged', revision: 2 });
    expect(ack.body.acknowledgedAt).not.toBeNull();
    t.clock.advance(10 * 60_000);
    const resolved = await post(t, `/v1/exceptions/${id}/resolve`, operator, {
      expectedRevision: 2,
      reason: 'Reached the parent by phone',
      resolution: { contacted: 'phone' },
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body).toMatchObject({ status: 'resolved', resolution: { contacted: 'phone' } });
    const closed = await post(t, `/v1/exceptions/${id}/close`, manager, {
      expectedRevision: 3,
      reason: 'Confirmed with the desk',
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', nextActions: [] });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'actor', 'reason', 'before_revision', 'after_revision'])
      .where('target_type', '=', 'operational_exception')
      .where('target_id', '=', id)
      .orderBy('occurred_at')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'exceptions.acknowledged',
      'exceptions.resolved',
      'exceptions.closed',
    ]);
    expect(audit.map((a) => (a.actor as { accountId: string }).accountId)).toEqual([
      operator.accountId,
      operator.accountId,
      manager.accountId,
    ]);
    expect(audit[1]).toMatchObject({
      reason: 'Reached the parent by phone',
      before_revision: 2,
      after_revision: 3,
    });
    expect(closed.body.history.map((h: { action: string }) => h.action)).toEqual([
      'exceptions.opened',
      'exceptions.acknowledged',
      'exceptions.resolved',
      'exceptions.closed',
    ]);
    expect(closed.body.history[2]).toMatchObject({ reason: 'Reached the parent by phone' });
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'support.exception_transitioned')
      .where('aggregate_id', '=', id)
      .orderBy('occurred_at')
      .execute();
    expect(events.map((e) => (e.payload as { to: string }).to)).toEqual([
      'acknowledged',
      'resolved',
      'closed',
    ]);
  });

  it('kernel lifecycle: refused transitions and stale revisions; an exception may be closed directly', async () => {
    const id = await raise();
    const stale = await post(t, `/v1/exceptions/${id}/acknowledge`, operator, {
      expectedRevision: 5,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const closed = await post(t, `/v1/exceptions/${id}/close`, operator, {
      reason: 'Duplicate alert',
    });
    expect(closed.status).toBe(200);
    const reack = await post(t, `/v1/exceptions/${id}/acknowledge`, operator, {});
    expect(reack.status).toBe(409);
    expect(reack.body.code).toBe('INVALID_TRANSITION');
    const missingReason = await post(t, `/v1/exceptions/${id}/resolve`, operator, {});
    expect(missingReason.status).toBe(400);
  });

  it('§4.9: an acknowledgment replays with the same key and records one audit entry', async () => {
    const id = await raise();
    const idem = key();
    const first = await post(t, `/v1/exceptions/${id}/acknowledge`, operator, {}, idem);
    const replay = await post(t, `/v1/exceptions/${id}/acknowledge`, operator, {}, idem);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const audit = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('target_id', '=', id)
      .execute();
    expect(audit).toHaveLength(1);
  });

  it('SPK-UX-006: closing an exception about a payment never changes the payment', async () => {
    const payer = await createPersonFixture(t, { kind: 'adult' });
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: payer,
      amountMinor: 3300,
    });
    const snapshot = async () => ({
      attempt: await t.db
        .selectFrom('payment_attempts')
        .selectAll()
        .where('id', '=', payment.paymentAttemptId)
        .executeTakeFirstOrThrow(),
      refundable: await t.db
        .selectFrom('payment_refundables')
        .selectAll()
        .where('payment_attempt_id', '=', payment.paymentAttemptId)
        .executeTakeFirstOrThrow(),
      obligation: await t.db
        .selectFrom('obligations')
        .selectAll()
        .where('id', '=', payment.obligationId)
        .executeTakeFirstOrThrow(),
    });
    const before = await snapshot();
    const id = await raise({
      category: 'finance.payment_evidence_conflict',
      severity: 'critical',
      title: 'Contradictory payment evidence',
      affectedType: 'payment_attempt',
      affectedId: payment.paymentAttemptId,
      ownerQueue: 'finance_operator',
    });
    const closed = await post(t, `/v1/exceptions/${id}/close`, manager, {
      reason: 'Closing the alert does not settle anything',
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      underlyingRecordUnchanged: true,
      affected: { type: 'payment_attempt', id: payment.paymentAttemptId },
    });
    expect(await snapshot()).toEqual(before);
  });

  it('authorization: managing needs the kernel exceptions.manage or ownership of the queue (K-10); queues outside the viewer scope are refused; other organizations are not found', async () => {
    const id = await raise();
    // The desk owns the front_desk queue: it sees the exception and, since K-10
    // (exceptions.manage_own_queue), settles it with its own role.
    expect((await get(t, `/v1/exceptions/${id}`, desk)).status).toBe(200);
    const deskAck = await post(t, `/v1/exceptions/${id}/acknowledge`, desk, {});
    expect(deskAck.status, JSON.stringify(deskAck.body)).toBe(200);
    // A finance operator neither sees nor manages the front desk's queue.
    expect((await get(t, `/v1/exceptions/${id}`, finance)).status).toBe(403);
    expect((await get(t, '/v1/exceptions?queue=front_desk', finance)).status).toBe(403);
    const elsewhere = await otherOrganization(t);
    const foreignManager = await staffMember(t, ['general_manager'], {
      organizationId: elsewhere.organizationId,
    });
    expect((await get(t, `/v1/exceptions/${id}`, foreignManager)).status).toBe(404);
    const foreignAck = await post(t, `/v1/exceptions/${id}/acknowledge`, foreignManager, {});
    expect(foreignAck.status).toBe(404);
    const foreignId = await raise({}, elsewhere.organizationId);
    expect((await get(t, `/v1/exceptions/${foreignId}`, manager)).status).toBe(404);
    const coach = await staffMember(t, ['coach']);
    expect((await get(t, '/v1/exceptions', coach)).status).toBe(403);
  });

  it('GET /exceptions filters by queue and status and pages without repeats', async () => {
    const queue = `desk_${Date.now()}`;
    await post(t, '/v1/exception-queues', manager, { name: queue, owningRoles: ['front_desk'] });
    const raised = [];
    for (let i = 0; i < 5; i += 1) {
      raised.push(await raise({ ownerQueue: queue, title: `Queue item ${i}` }));
      t.clock.advance(1000);
    }
    await post(t, `/v1/exceptions/${raised[4]}/close`, manager, { reason: 'done' });
    const firstPage = await get(t, `/v1/exceptions?queue=${queue}&limit=2`, desk);
    expect(firstPage.status, JSON.stringify(firstPage.body)).toBe(200);
    expect(firstPage.body.items).toHaveLength(2);
    const rest = await get(
      t,
      `/v1/exceptions?queue=${queue}&limit=10&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
      desk,
    );
    const open = [...firstPage.body.items, ...rest.body.items].map((e: { id: string }) => e.id);
    // Newest first: the order of the kernel's exception list (K-10), which support reads (SUP-02).
    expect(open).toEqual(raised.slice(0, 4).reverse());
    const closed = await get(t, `/v1/exceptions?queue=${queue}&status=closed`, desk);
    expect(closed.body.items.map((e: { id: string }) => e.id)).toEqual([raised[4]]);
  });

  it('§5.11: a configured queue names its owning roles and service levels; deadlines and overdue follow them', async () => {
    const queue = `refund_review_${Date.now()}`;
    const created = await post(t, '/v1/exception-queues', manager, {
      name: queue,
      owningRoles: ['finance_operator', 'front_desk'],
      acknowledgeWithinMinutes: 15,
      resolveWithinMinutes: 60,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const openedAt = t.clock.now();
    const id = await raise({ ownerQueue: queue, category: 'finance.refund_review' });
    const view = await get(t, `/v1/exceptions/${id}`, desk);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      deadlineAt: new Date(openedAt.getTime() + 60 * 60_000).toISOString(),
      acknowledgeBy: new Date(openedAt.getTime() + 15 * 60_000).toISOString(),
      overdue: false,
    });
    t.clock.advance(20 * 60_000);
    expect((await get(t, `/v1/exceptions/${id}`, finance)).body.overdue).toBe(true);
    // Retiring the queue returns ownership to the role convention (no role is named `refund_review_…`).
    const retired = await patch(t, `/v1/exception-queues/${created.body.id}`, manager, {
      status: 'retired',
      expectedRevision: 1,
    });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect((await get(t, `/v1/exceptions/${id}`, desk)).status).toBe(403);
    expect((await get(t, `/v1/exceptions/${id}`, operator)).status).toBe(200); // oversight role
  });

  it('exception queues: managers define them; names are unique; edits need the current revision', async () => {
    const name = `evening_${Date.now()}`;
    const created = await post(t, '/v1/exception-queues', manager, {
      name,
      owningRoles: ['front_desk'],
    });
    expect(created.status).toBe(201);
    const duplicate = await post(t, '/v1/exception-queues', manager, {
      name,
      owningRoles: ['scheduler'],
    });
    expect(duplicate.status).toBe(409);
    const byDesk = await post(t, '/v1/exception-queues', desk, {
      name: 'x_queue',
      owningRoles: ['front_desk'],
    });
    expect(byDesk.status).toBe(403);
    const inverted = await post(t, '/v1/exception-queues', manager, {
      name: `inverted_${Date.now()}`,
      owningRoles: ['front_desk'],
      acknowledgeWithinMinutes: 90,
      resolveWithinMinutes: 30,
    });
    expect(inverted.status).toBe(400);
    const updated = await patch(t, `/v1/exception-queues/${created.body.id}`, manager, {
      owningRoles: ['front_desk', 'scheduler'],
      expectedRevision: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ owningRoles: ['front_desk', 'scheduler'], revision: 2 });
    const stale = await patch(t, `/v1/exception-queues/${created.body.id}`, manager, {
      description: 'late edit',
      expectedRevision: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const listed = await get(t, '/v1/exception-queues', desk);
    expect(listed.status).toBe(200);
    expect(listed.body.map((q: { name: string }) => q.name)).toContain(name);
  });
});

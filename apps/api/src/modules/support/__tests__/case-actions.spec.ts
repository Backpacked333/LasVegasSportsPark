import { errors } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { createCapturedPaymentFixture, RefundsService } from '../../finance';
import { createOrganizationPeople, type OrganizationPeople } from '../../identity';
import { MigrationModule, createAuthorityAssignmentFixture } from '../../migration';
import { SupportModule } from '../support.module';
import {
  CLOCK_START,
  drainOutbox,
  get,
  key,
  otherOrganization,
  post,
  staffMember,
  supportTestApp,
  type Actor,
} from './support';

/**
 * SPK-SUPPORT-003: support actions use the owning module's normal authorized commands; a note
 * never substitutes for a refund, a permission change or a transfer.
 */
describe('case actions (SPK-SUPPORT-003)', () => {
  let t: TestApp;
  let operator: Actor;
  let manager: Actor;
  let people: OrganizationPeople;

  beforeAll(async () => {
    t = await supportTestApp();
    operator = await staffMember(t, ['support_operator']);
    manager = await staffMember(t, ['general_manager']);
    people = await createOrganizationPeople(t);
  });
  afterAll(async () => {
    await t.close();
  });

  const openCase = async (actor: Actor, subjectPersonId: string | null = people.adult.personId) => {
    const res = await post(t, '/v1/cases', actor, {
      category: 'payment',
      title: 'Duplicate charge',
      ...(subjectPersonId ? { subjectPersonId } : {}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };

  const financeState = async (paymentAttemptId: string, obligationId: string) => ({
    refundable: await t.db
      .selectFrom('payment_refundables')
      .select(['captured_minor', 'refunded_minor', 'reserved_minor'])
      .where('payment_attempt_id', '=', paymentAttemptId)
      .executeTakeFirstOrThrow(),
    refunds: await t.db
      .selectFrom('refund_attempts')
      .select(['id', 'status'])
      .where('payment_attempt_id', '=', paymentAttemptId)
      .execute(),
    obligation: await t.db
      .selectFrom('obligations')
      .select(['status', 'allocated_minor', 'revision'])
      .where('id', '=', obligationId)
      .executeTakeFirstOrThrow(),
    journals: Number(
      (
        await t.db
          .selectFrom('journals')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    ),
  });

  it('SPK-SUPPORT-003: a support note does not change finance state, and cannot stand in for the refund when resolving', async () => {
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: people.adult.personId,
      amountMinor: 4000,
    });
    const caseId = await openCase(operator);
    const before = await financeState(payment.paymentAttemptId, payment.obligationId);
    const note = await post(t, `/v1/cases/${caseId}/notes`, operator, {
      body: 'Refunded $20 to the card on file — customer happy.',
    });
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    expect(note.body.events.at(-1)).toMatchObject({ kind: 'note' });
    await drainOutbox(t);
    expect(await financeState(payment.paymentAttemptId, payment.obligationId)).toEqual(before);
    const resolve = await post(t, `/v1/cases/${caseId}/transition`, operator, {
      event: 'resolve',
      expectedRevision: 1,
      resolution: { kind: 'action_taken', summary: 'Refunded' },
    });
    expect(resolve.status).toBe(409);
    expect(resolve.body).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      nextAction: 'link_authorized_action',
      details: { code: 'ACTION_REQUIRED' },
    });
  });

  it('SPK-SUPPORT-003: finance refuses a refund the operator is not authorized for; the attempt is recorded as failed and nothing moves', async () => {
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: people.adult.personId,
      amountMinor: 3000,
    });
    const caseId = await openCase(operator);
    const before = await financeState(payment.paymentAttemptId, payment.obligationId);
    // support_operator does not hold finance.refund (finance operator, GM, sysadmin do).
    const res = await post(t, `/v1/cases/${caseId}/request-refund`, operator, {
      paymentAttemptId: payment.paymentAttemptId,
      amountMinor: 1000,
      reason: 'Customer asked for a partial refund',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCESS_DENIED');
    expect(await financeState(payment.paymentAttemptId, payment.obligationId)).toEqual(before);
    const detail = await get(t, `/v1/cases/${caseId}`, operator);
    expect(detail.body.actions).toHaveLength(1);
    expect(detail.body.actions[0]).toMatchObject({
      actionId: 'finance.refund',
      via: 'helper',
      status: 'failed',
      error: { code: 'ACCESS_DENIED' },
      commandOperationId: null,
    });
    const op = await t.db
      .selectFrom('operations')
      .select(['kind', 'status'])
      .where('id', '=', detail.body.actions[0].supportOperationId)
      .executeTakeFirstOrThrow();
    expect(op).toEqual({ kind: 'support.request_refund', status: 'failed' });
  });

  it('SPK-SUPPORT-003 / §4.7 invariant 5: a refund requested from a case runs finance.refund once and links its operation; a replay refunds nothing more', async () => {
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: people.adult.personId,
      amountMinor: 5000,
    });
    const caseId = await openCase(manager);
    const idem = key();
    const body = {
      paymentAttemptId: payment.paymentAttemptId,
      amountMinor: 2000,
      reason: 'Charged twice for the same week',
    };
    const res = await post(t, `/v1/cases/${caseId}/request-refund`, manager, body, idem);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const refunds = await t.db
      .selectFrom('refund_attempts')
      .select(['id', 'status', 'operation_id', 'amount_minor'])
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .execute();
    expect(refunds).toHaveLength(1);
    const refund = refunds[0]!;
    expect(refund.amount_minor).toBe(2000);
    expect(res.body.action).toMatchObject({
      actionId: 'finance.refund',
      via: 'helper',
      status: 'succeeded',
      commandOperationId: refund.operation_id,
      record: { type: 'refund_attempt', id: refund.id },
      input: { paymentAttemptId: payment.paymentAttemptId, amountMinor: 2000 },
    });
    expect(res.body.case.events.at(-1)).toMatchObject({
      kind: 'action_link',
      caseActionId: res.body.action.id,
    });
    const replay = await post(t, `/v1/cases/${caseId}/request-refund`, manager, body, idem);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.action.id).toBe(res.body.action.id);
    const after = await t.db
      .selectFrom('refund_attempts')
      .select('id')
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .execute();
    expect(after).toHaveLength(1);
    // The finance invariant still applies: refunding beyond the refundable funds is refused.
    const over = await post(t, `/v1/cases/${caseId}/request-refund`, manager, {
      ...body,
      amountMinor: 4000,
    });
    expect(over.status).toBeGreaterThanOrEqual(400);
    const detail = await get(t, `/v1/cases/${caseId}`, manager);
    expect(detail.body.actions.map((a: { status: string }) => a.status)).toEqual([
      'succeeded',
      'failed',
    ]);
    // With a succeeded authorized command linked, "action taken" is a truthful resolution.
    const resolved = await post(t, `/v1/cases/${caseId}/transition`, manager, {
      event: 'resolve',
      expectedRevision: detail.body.revision,
      resolution: { kind: 'action_taken', summary: 'Refunded the duplicate week' },
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  });

  it('§4.12: when the refund outcome cannot be learned the action stays unknown with an owned exception, and a retry never requests a second refund', async () => {
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: people.adult.personId,
      amountMinor: 2500,
    });
    const caseId = await openCase(manager);
    const refunds = t.app.get(RefundsService);
    const spy = vi
      .spyOn(refunds, 'request')
      .mockRejectedValueOnce(new Error('connection reset after the request was sent'));
    const idem = key();
    const body = {
      paymentAttemptId: payment.paymentAttemptId,
      amountMinor: 500,
      reason: 'Late fee waived',
    };
    const first = await post(t, `/v1/cases/${caseId}/request-refund`, manager, body, idem);
    expect(first.status).toBe(500);
    const detail = await get(t, `/v1/cases/${caseId}`, manager);
    const action = detail.body.actions[0];
    expect(action).toMatchObject({ status: 'unknown', error: { code: 'OUTCOME_UNKNOWN' } });
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue', 'affected_id', 'status'])
      .where('affected_id', '=', action.id)
      .executeTakeFirstOrThrow();
    expect(exception).toEqual({
      category: 'support.helper_outcome_unknown',
      owner_queue: 'finance_operator',
      affected_id: action.id,
      status: 'open',
    });
    const op = await t.db
      .selectFrom('operations')
      .select('status')
      .where('id', '=', action.supportOperationId)
      .executeTakeFirstOrThrow();
    expect(op.status).toBe('recovery_required');
    // §4.9: the command committed (the unknown outcome above) before the 500, so a retry with the
    // same key replays the stored 500 instead of running the command again.
    const replay = await post(t, `/v1/cases/${caseId}/request-refund`, manager, body, idem);
    expect(replay.status).toBe(500);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // Once the stored response has expired (simulated by removing it), the same key reaches the
    // command again, which refuses instead of refunding again.
    await t.db.deleteFrom('idempotency_keys').where('idempotency_key', '=', idem).execute();
    const retry = await post(t, `/v1/cases/${caseId}/request-refund`, manager, body, idem);
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('REFUND_PENDING');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    // A reviewer confirms with finance that no refund exists: CaseActionMachine unknown → failed.
    const settled = await post(t, `/v1/cases/${caseId}/actions/${action.id}/settle`, manager, {
      outcome: 'failed',
      reason: 'Finance confirms no refund was reserved for this payment',
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.action).toMatchObject({
      status: 'failed',
      error: { code: 'NO_EFFECT_CONFIRMED' },
    });
    const after = await t.db
      .selectFrom('operational_exceptions')
      .select('status')
      .where('affected_id', '=', action.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('resolved');
    expect(
      (
        await t.db
          .selectFrom('operations')
          .select('status')
          .where('id', '=', action.supportOperationId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('failed');
    const again = await post(t, `/v1/cases/${caseId}/actions/${action.id}/settle`, manager, {
      outcome: 'failed',
      reason: 'twice',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    // With the question answered, a new request (new key) runs finance.refund normally.
    const fresh = await post(t, `/v1/cases/${caseId}/request-refund`, manager, body);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect(fresh.body.action.status).toBe('succeeded');
  });

  it('support-migration-09 / §4.7 invariant 12: a case cannot be closed while an action outcome is unknown, in the service and in the database', async () => {
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: people.adult.personId,
      amountMinor: 2500,
    });
    const caseId = await openCase(manager);
    const refunds = t.app.get(RefundsService);
    const spy = vi
      .spyOn(refunds, 'request')
      .mockRejectedValueOnce(new Error('connection reset after the request was sent'));
    const first = await post(t, `/v1/cases/${caseId}/request-refund`, manager, {
      paymentAttemptId: payment.paymentAttemptId,
      amountMinor: 500,
      reason: 'Late fee waived',
    });
    expect(first.status).toBe(500);
    spy.mockRestore();
    const detail = await get(t, `/v1/cases/${caseId}`, manager);
    const action = detail.body.actions[0];
    expect(action.status).toBe('unknown');
    const resolved = await post(t, `/v1/cases/${caseId}/transition`, manager, {
      event: 'resolve',
      expectedRevision: detail.body.revision,
      resolution: {
        kind: 'information_provided',
        summary: 'Told the customer finance is checking',
      },
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const close = await post(t, `/v1/cases/${caseId}/transition`, manager, {
      event: 'close',
      expectedRevision: resolved.body.revision,
    });
    expect(close.status).toBe(409);
    expect(close.body).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'ACTION_OUTCOME_UNKNOWN', caseActionIds: [action.id] },
    });
    // The database refuses the same close, whatever the caller.
    await expect(
      t.db
        .updateTable('cases')
        .set({ status: 'closed', revision: resolved.body.revision + 1 })
        .where('id', '=', caseId)
        .execute(),
    ).rejects.toThrow(/settle it before closing/);
    // Once the outcome is recorded the case closes normally.
    const settled = await post(t, `/v1/cases/${caseId}/actions/${action.id}/settle`, manager, {
      outcome: 'failed',
      reason: 'Finance confirms no refund was reserved for this payment',
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const closed = await post(t, `/v1/cases/${caseId}/transition`, manager, {
      event: 'close',
      expectedRevision: settled.body.case.revision,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.status).toBe('closed');
  });

  it('CaseActionMachine unknown → succeeded: only with the evidence of the command the helper ran, never a note', async () => {
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: people.adult.personId,
      amountMinor: 2500,
    });
    const caseId = await openCase(manager);
    const refunds = t.app.get(RefundsService);
    const original = refunds.request.bind(refunds);
    // Finance executes the refund, but the answer is lost before support records it.
    const spy = vi.spyOn(refunds, 'request').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('socket hang up after finance committed');
    });
    const first = await post(t, `/v1/cases/${caseId}/request-refund`, manager, {
      paymentAttemptId: payment.paymentAttemptId,
      amountMinor: 700,
      reason: 'Parking fee refund',
    });
    expect(first.status).toBe(500);
    spy.mockRestore();
    const action = (await get(t, `/v1/cases/${caseId}`, manager)).body.actions[0];
    expect(action.status).toBe('unknown');
    const refund = await t.db
      .selectFrom('refund_attempts')
      .select(['id', 'operation_id'])
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .executeTakeFirstOrThrow();
    // Evidence from another operator's command does not settle it.
    const otherOp = await post(t, '/v1/cases', operator, { category: 'other', title: 'x' });
    const otherAudit = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('target_id', '=', otherOp.body.id)
      .executeTakeFirstOrThrow();
    const wrongEvidence = await post(
      t,
      `/v1/cases/${caseId}/actions/${action.id}/settle`,
      manager,
      {
        outcome: 'succeeded',
        auditRecordId: otherAudit.id,
        reason: 'x',
      },
    );
    expect(wrongEvidence.status).toBe(403);
    const noEvidence = await post(t, `/v1/cases/${caseId}/actions/${action.id}/settle`, manager, {
      outcome: 'succeeded',
      reason: 'Customer says the money arrived',
    });
    expect(noEvidence.status).toBe(400);
    const settled = await post(t, `/v1/cases/${caseId}/actions/${action.id}/settle`, operator, {
      outcome: 'succeeded',
      operationId: refund.operation_id,
      reason: 'Finance shows the refund settled',
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.action).toMatchObject({
      status: 'succeeded',
      commandOperationId: refund.operation_id,
      record: { type: 'refund_attempt', id: refund.id },
    });
  });

  it('a refusal raised after finance already reserved the refund is recorded unknown, never failed', async () => {
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: people.adult.personId,
      amountMinor: 1800,
    });
    const caseId = await openCase(manager);
    const refunds = t.app.get(RefundsService);
    const original = refunds.request.bind(refunds);
    const spy = vi.spyOn(refunds, 'request').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw errors.resourceConflict('a later step was refused');
    });
    const res = await post(t, `/v1/cases/${caseId}/request-refund`, manager, {
      paymentAttemptId: payment.paymentAttemptId,
      amountMinor: 300,
      reason: 'Locker fee',
    });
    spy.mockRestore();
    expect(res.status).toBe(409);
    const action = (await get(t, `/v1/cases/${caseId}`, manager)).body.actions[0];
    expect(action.status).toBe('unknown');
  });

  it('SPK-SUPPORT-003: the operator links a permission change they ran (audit record), only their own and only of the named command', async () => {
    const caseId = await openCase(operator, people.child.personId);
    const grantId = people.guardianGrants.collect as string;
    const revoked = await post(t, `/v1/access-grants/${grantId}/revoke`, operator, {
      reason: 'Court order received at the desk',
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'identity.revoke_access')
      .where('target_id', '=', grantId)
      .executeTakeFirstOrThrow();
    const unknownAction = await post(t, `/v1/cases/${caseId}/actions`, operator, {
      actionId: 'identity.teleport',
      auditRecordId: audit.id,
    });
    expect(unknownAction.status).toBe(400);
    const wrongAction = await post(t, `/v1/cases/${caseId}/actions`, operator, {
      actionId: 'identity.grant_access',
      auditRecordId: audit.id,
    });
    expect(wrongAction.status).toBe(400);
    expect(wrongAction.body.details).toMatchObject({ code: 'ACTION_MISMATCH' });
    const someoneElse = await post(t, `/v1/cases/${caseId}/actions`, manager, {
      actionId: 'identity.revoke_access',
      auditRecordId: audit.id,
    });
    expect(someoneElse.status).toBe(403);
    expect(someoneElse.body.details).toMatchObject({ code: 'NOT_OPERATORS_COMMAND' });
    const supportAction = await post(t, `/v1/cases/${caseId}/actions`, operator, {
      actionId: 'support.work_case',
      auditRecordId: audit.id,
    });
    expect(supportAction.status).toBe(400);
    const linked = await post(t, `/v1/cases/${caseId}/actions`, operator, {
      actionId: 'identity.revoke_access',
      auditRecordId: audit.id,
      note: 'Collect permission revoked per the order',
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect(linked.body.action).toMatchObject({
      actionId: 'identity.revoke_access',
      via: 'linked',
      status: 'succeeded',
      auditRecordId: audit.id,
      record: { type: 'access_grant', id: grantId },
    });
    const again = await post(t, `/v1/cases/${caseId}/actions`, operator, {
      actionId: 'identity.revoke_access',
      auditRecordId: audit.id,
    });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ code: 'ACTION_ALREADY_LINKED' });
    // Evidence from another organization is not found.
    const elsewhere = await otherOrganization(t);
    const foreign = await staffMember(t, ['support_operator'], {
      organizationId: elsewhere.organizationId,
    });
    const foreignCase = await post(t, '/v1/cases', foreign, { category: 'access', title: 'x' });
    const crossOrg = await post(t, `/v1/cases/${foreignCase.body.id}/actions`, foreign, {
      actionId: 'identity.revoke_access',
      auditRecordId: audit.id,
    });
    expect(crossOrg.status).toBe(404);
  });

  it('SPK-SUPPORT-003: a command with a durable operation is linked by its operation, which must record that action', async () => {
    const caseId = await openCase(operator);
    const composed = await post(t, '/v1/notifications', operator, {
      kind: 'payment_attention',
      title: 'About your refund',
      body: 'We have started your refund.',
      audience: { subjectPersonIds: [people.adult.personId] },
    });
    expect(composed.status, JSON.stringify(composed.body)).toBe(201);
    const sent = await post(t, `/v1/notifications/${composed.body.id}/send`, operator, {});
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    const operationId = sent.body.operationId as string;
    const wrong = await post(t, `/v1/cases/${caseId}/actions`, operator, {
      actionId: 'communications.compose',
      operationId,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.details).toMatchObject({ code: 'ACTION_NOT_IN_OPERATION' });
    const linked = await post(t, `/v1/cases/${caseId}/actions`, operator, {
      actionId: 'communications.send',
      operationId,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect(linked.body.action).toMatchObject({
      status: 'succeeded',
      commandOperationId: operationId,
      record: { type: 'notification', id: composed.body.id },
    });
  });

  it('resend-notification: communications resends to the case subject with the operator principal, re-resolving recipients from current permissions', async () => {
    const composed = await post(t, '/v1/notifications', operator, {
      kind: 'schedule_changed',
      title: 'Saturday game moved to 10:00',
      body: 'Your Saturday game now starts at 10:00 on pitch 2.',
      audience: { subjectPersonIds: [people.adult.personId] },
    });
    await post(t, `/v1/notifications/${composed.body.id}/send`, operator, {});
    await drainOutbox(t);
    const caseId = await openCase(operator);
    const res = await post(t, `/v1/cases/${caseId}/resend-notification`, operator, {
      notificationId: composed.body.id,
      reason: 'Customer says the message never arrived',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.action).toMatchObject({
      actionId: 'communications.send',
      via: 'helper',
      status: 'succeeded',
      record: { type: 'notification' },
    });
    const resentId = res.body.action.record.id as string;
    expect(resentId).not.toBe(composed.body.id);
    const resent = await t.db
      .selectFrom('notifications')
      .select(['status', 'audience', 'operation_id', 'title'])
      .where('id', '=', resentId)
      .executeTakeFirstOrThrow();
    expect(resent).toMatchObject({
      status: 'queued',
      title: 'Saturday game moved to 10:00',
      audience: expect.objectContaining({ subjectPersonIds: [people.adult.personId] }),
    });
    expect(res.body.action.commandOperationId).toBe(resent.operation_id);
    // A case about someone the notification never addressed cannot be used to send it to them.
    const otherCase = await openCase(operator, people.staff.personId);
    const notAddressed = await post(t, `/v1/cases/${otherCase}/resend-notification`, operator, {
      notificationId: composed.body.id,
      reason: 'x',
    });
    expect(notAddressed.status).toBe(400);
    expect(notAddressed.body.details).toMatchObject({ code: 'NOT_ADDRESSED_TO_SUBJECT' });
    const noSubject = await openCase(operator, null);
    const missing = await post(t, `/v1/cases/${noSubject}/resend-notification`, operator, {
      notificationId: composed.body.id,
      reason: 'x',
    });
    expect(missing.status).toBe(400);
    // The front desk holds the communications compose authority as well.
    const desk = await staffMember(t, ['front_desk']);
    const deskCase = await openCase(desk);
    const viaDesk = await post(t, `/v1/cases/${deskCase}/resend-notification`, desk, {
      notificationId: composed.body.id,
      reason: 'Front desk resend',
    });
    expect(viaDesk.status).toBe(201);
  });
});

/**
 * §4.7 invariant 11 / §5.6: the refund helper runs finance's normal command with all of its
 * guards (SPK-SUPPORT-003), including the record authority finance checks in-process.
 */
describe('case actions under legacy refund authority (§4.7 invariant 11, §5.6)', () => {
  let t: TestApp;
  let manager: Actor;
  let people: OrganizationPeople;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [SupportModule, MigrationModule],
      principalResolver: 'module',
      clockStart: CLOCK_START,
    });
    manager = await staffMember(t, ['general_manager']);
    people = await createOrganizationPeople(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('§4.7 invariant 11 / §5.6: request-refund is refused while the legacy system is authoritative for refunds; the action is failed and nothing moves', async () => {
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: people.adult.personId,
      amountMinor: 4000,
    });
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'refund',
      authoritativeSystem: 'legacy',
    });
    const opened = await post(t, '/v1/cases', manager, {
      category: 'payment',
      title: 'Duplicate charge',
      subjectPersonId: people.adult.personId,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const caseId = opened.body.id as string;
    const res = await post(t, `/v1/cases/${caseId}/request-refund`, manager, {
      paymentAttemptId: payment.paymentAttemptId,
      amountMinor: 1000,
      reason: 'Charged twice',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      code: 'ACCESS_DENIED',
      nextAction: 'write_in_authoritative_system',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'refund' },
    });
    const refunds = await t.db
      .selectFrom('refund_attempts')
      .select('id')
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .execute();
    expect(refunds).toEqual([]);
    const refundable = await t.db
      .selectFrom('payment_refundables')
      .select(['reserved_minor', 'refunded_minor'])
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .executeTakeFirstOrThrow();
    expect(refundable).toEqual({ reserved_minor: 0, refunded_minor: 0 });
    const detail = await get(t, `/v1/cases/${caseId}`, manager);
    expect(detail.body.actions).toHaveLength(1);
    expect(detail.body.actions[0]).toMatchObject({
      actionId: 'finance.refund',
      via: 'helper',
      status: 'failed',
      error: { code: 'ACCESS_DENIED' },
    });
    const op = await t.db
      .selectFrom('operations')
      .select('status')
      .where('id', '=', detail.body.actions[0].supportOperationId)
      .executeTakeFirstOrThrow();
    expect(op.status).toBe('failed');
  });
});

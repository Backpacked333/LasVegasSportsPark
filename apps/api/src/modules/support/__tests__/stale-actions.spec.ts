import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OperationsService,
  PeriodicJobRegistry,
  PeriodicJobRunner,
  UnitOfWork,
} from '../../../kernel';
import type { TestApp } from '../../../testing';
import { RefundsService, createCapturedPaymentFixture } from '../../finance';
import { createOrganizationPeople, type OrganizationPeople } from '../../identity';
import {
  CASE_ACTION_STALE_CATEGORY,
  CaseActionsService,
  SETTLE_STALE_CASE_ACTIONS_JOB,
} from '../services/case-actions.service';
import { DEFAULT_SUPPORT_POLICY } from '../support.policy';
import { drainOutbox, get, key, post, staffMember, supportTestApp, type Actor } from './support';

/** The technical default of SUPPORT_STALE_ACTION_SECONDS (support.settings.ts). */
const STALE_MS = 900_000;

/**
 * SUP-04 (SPK-SUPPORT-002, §4.11 "unknown kept explicit until reconciled", §4.12): helper
 * requests left `requested` are settled from the owning module's outcome by
 * `support.settle_stale_case_actions`, and a case is not resolved or closed past a related
 * operation that waits for recovery without an audited acknowledgment.
 */
describe('stale helper requests and open recovery (SUP-04)', () => {
  let t: TestApp;
  let manager: Actor;
  let people: OrganizationPeople;
  let runner: PeriodicJobRunner;

  beforeAll(async () => {
    t = await supportTestApp();
    manager = await staffMember(t, ['general_manager']);
    people = await createOrganizationPeople(t);
    runner = t.app.get(PeriodicJobRunner);
  });
  afterAll(async () => {
    await t.close();
  });

  const openCase = async (extra: object = {}) => {
    const res = await post(t, '/v1/cases', manager, {
      category: 'payment',
      title: 'Duplicate charge',
      subjectPersonId: people.adult.personId,
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; revision: number };
  };
  const helperState = async (caseActionId: string) => {
    const action = await t.db
      .selectFrom('case_actions')
      .select([
        'status',
        'error',
        'support_operation_id',
        'command_operation_id',
        'audit_record_id',
      ])
      .where('id', '=', caseActionId)
      .executeTakeFirstOrThrow();
    const operation = await t.db
      .selectFrom('operations')
      .select('status')
      .where('id', '=', action.support_operation_id as string)
      .executeTakeFirstOrThrow();
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue', 'status'])
      .where('affected_id', '=', caseActionId)
      .orderBy('opened_at')
      .execute();
    return { ...action, operation: operation.status, exceptions };
  };
  const runJob = async () => {
    const [summary] = await runner.runOnce([SETTLE_STALE_CASE_ACTIONS_JOB], {
      ignoreInterval: true,
    });
    expect(summary).toMatchObject({ ran: true, failed: false });
    return summary!;
  };
  /** Requests a refund whose outcome the process fails to record (it dies after finance). */
  const leaveRequested = async (options: { financeAnswers: boolean }) => {
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: people.adult.personId,
      amountMinor: 3000,
    });
    const supportCase = await openCase();
    const actions = t.app.get(CaseActionsService);
    const refunds = t.app.get(RefundsService);
    const lost = vi
      .spyOn(actions as unknown as { complete: () => Promise<unknown> }, 'complete')
      .mockRejectedValue(new Error('connection lost while recording the outcome'));
    const unanswered = options.financeAnswers
      ? null
      : vi
          .spyOn(refunds, 'request')
          .mockRejectedValueOnce(new Error('connection reset before the request was sent'));
    const res = await post(t, `/v1/cases/${supportCase.id}/request-refund`, manager, {
      paymentAttemptId: payment.paymentAttemptId,
      amountMinor: 1000,
      reason: 'Charged twice',
    });
    lost.mockRestore();
    unanswered?.mockRestore();
    expect(res.status).toBe(500);
    const action = (await get(t, `/v1/cases/${supportCase.id}`, manager)).body.actions[0];
    expect(action.status).toBe('requested');
    return { caseId: supportCase.id, actionId: action.id as string, payment };
  };

  it('is registered every 300 seconds, owned by the support operator queue (§4.12)', () => {
    expect(t.app.get(PeriodicJobRegistry).get(SETTLE_STALE_CASE_ACTIONS_JOB)).toMatchObject({
      intervalSeconds: 300,
      failureOwner: 'support_operator',
    });
  });

  it('a refund helper left requested is settled from the refund attempt’s outcome', async () => {
    const { caseId, actionId, payment } = await leaveRequested({ financeAnswers: true });
    const refund = await t.db
      .selectFrom('refund_attempts')
      .select(['id', 'operation_id', 'status'])
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .executeTakeFirstOrThrow();
    // Not stale yet: the job reads nothing.
    expect((await runJob()).processed).toBe(0);
    expect((await helperState(actionId)).status).toBe('requested');

    t.clock.advance(STALE_MS + 1000);
    expect((await runJob()).processed).toBe(1);
    const state = await helperState(actionId);
    expect(state).toMatchObject({
      status: 'succeeded',
      command_operation_id: refund.operation_id,
      operation: 'succeeded',
      exceptions: [],
    });
    expect(state.audit_record_id).not.toBeNull();
    const detail = await get(t, `/v1/cases/${caseId}`, manager);
    expect(detail.body.actions[0]).toMatchObject({
      status: 'succeeded',
      record: { type: 'refund_attempt', id: refund.id },
    });
    expect(detail.body.events.at(-1)).toMatchObject({
      kind: 'action_link',
      actor: { actorLabel: SETTLE_STALE_CASE_ACTIONS_JOB },
    });
    // The delayed follow-up of the request then finds the outcome recorded and does nothing.
    t.clock.advance(DEFAULT_SUPPORT_POLICY.helperOutcomeGraceMinutes * 60_000);
    await drainOutbox(t);
    expect(await helperState(actionId)).toMatchObject({ status: 'succeeded', exceptions: [] });
    // Recording it again changes nothing.
    expect((await runJob()).processed).toBe(0);
  });

  it('without an owning-module outcome the request stays requested with one support.case_action_stale exception', async () => {
    const { actionId } = await leaveRequested({ financeAnswers: false });
    t.clock.advance(STALE_MS + 1000);
    await runJob();
    await runJob();
    expect(await helperState(actionId)).toMatchObject({
      status: 'requested',
      operation: 'running',
      exceptions: [
        { category: CASE_ACTION_STALE_CATEGORY, owner_queue: 'finance_operator', status: 'open' },
      ],
    });
    // The grace-period follow-up makes it unknown with the finance-owned exception, which
    // supersedes the stale-request exception.
    t.clock.advance(DEFAULT_SUPPORT_POLICY.helperOutcomeGraceMinutes * 60_000);
    await drainOutbox(t);
    expect(await helperState(actionId)).toMatchObject({
      status: 'unknown',
      operation: 'recovery_required',
      exceptions: [
        { category: CASE_ACTION_STALE_CATEGORY, status: 'resolved' },
        { category: 'support.helper_outcome_unknown', status: 'open' },
      ],
    });
  });

  it('a case linked to a recovery_required operation cannot be resolved without acknowledgment; with it the acknowledgment is audited', async () => {
    const uow = t.app.get(UnitOfWork);
    const operations = t.app.get(OperationsService);
    const operationId = await uow.run(async ({ trx }) => {
      const id = await operations.create(trx, {
        organizationId: t.organizationId,
        kind: 'finance.checkout',
        requestedBy: systemPrincipal(t.organizationId, 'tests'),
        status: 'running',
      });
      await operations.transition(trx, id, 'recovery_required', {
        error: {
          code: 'FULFILLMENT_INCOMPLETE',
          message: 'Payment captured, enrollment not created',
        },
      });
      return id;
    });
    const supportCase = await openCase({
      relatedRecords: [{ type: 'operation', id: operationId }],
    });
    const resolve = (extra: object) =>
      post(t, `/v1/cases/${supportCase.id}/transition`, manager, {
        event: 'resolve',
        expectedRevision: supportCase.revision,
        resolution: { kind: 'information_provided', summary: 'Explained the delay' },
        ...extra,
      });
    const refused = await resolve({});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        code: 'RELATED_RECORD_IN_RECOVERY',
        operations: [{ operationId, kind: 'finance.checkout', status: 'recovery_required' }],
      },
    });
    // An acknowledgment records why.
    const noReason = await resolve({ acknowledgeOpenRecovery: true });
    expect(noReason.status).toBe(400);
    const reason = 'Finance is recovering the checkout; the customer was told when to expect it';
    const resolved = await resolve({ acknowledgeOpenRecovery: true, reason });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.events.at(-1)).toMatchObject({
      kind: 'status',
      toStatus: 'resolved',
      details: { acknowledgedOpenRecovery: [operationId] },
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason', 'details'])
      .where('target_id', '=', supportCase.id)
      .where('action', '=', 'support.work_case')
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        reason,
        details: expect.objectContaining({
          event: 'resolve',
          acknowledgedOpenRecovery: [operationId],
        }),
      }),
    ]);
    // Closing asks again while the recovery is still open.
    const close = await post(t, `/v1/cases/${supportCase.id}/transition`, manager, {
      event: 'close',
      expectedRevision: resolved.body.revision,
    });
    expect(close.status).toBe(409);
    expect(close.body.details.code).toBe('RELATED_RECORD_IN_RECOVERY');
    // Once the owning module recovers the operation the case closes without acknowledgment.
    await uow.run(({ trx }) =>
      operations.transition(trx, operationId, 'succeeded', { result: { recovered: true } }),
    );
    const closed = await post(
      t,
      `/v1/cases/${supportCase.id}/transition`,
      manager,
      { event: 'close', expectedRevision: resolved.body.revision },
      key(),
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });
});

import { newId, systemPrincipal } from '@sportspark/contracts';
import { json, pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditWriter, databaseConstraintOf } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { NotificationsService } from '../../communications';
import type { FakeAssistantProvider } from '../providers/fake-assistant.provider';
import {
  CLOCK_START,
  adultCustomer,
  automationTestApp,
  countRows,
  drainOutbox,
  get,
  key,
  otherOrganization,
  post,
  staffMember,
  type Actor,
} from './automation';

interface Rec {
  id: string;
  revision: number;
  status: string;
  apply: { operationId: string | null; state: string };
}

/**
 * AUT-03 (§4.11 "unknown kept explicit until reconciled", §4.12, §4.7 invariant 5, SPK-AUTO-003):
 * an apply whose outcome the owning module did not report stays claimed with a recovery-required
 * operation and an owned exception until a system administrator or general manager records the
 * reconciled outcome, with its evidence, through POST /v1/recommendations/{id}/settle-apply. The
 * command is never run again by the settlement, and the database accepts the end of such a claim
 * only through its settlement.
 */
describe('settling an apply with an unknown outcome (AUT-03)', () => {
  let t: TestApp;
  let fake: FakeAssistantProvider;
  let leagueManager: Actor;
  let gm: Actor;
  let sysadmin: Actor;
  let facilitiesOperator: Actor;

  beforeAll(async () => {
    ({ t, fake } = await automationTestApp());
    leagueManager = await staffMember(t, ['league_manager']);
    gm = await staffMember(t, ['general_manager']);
    sysadmin = await staffMember(t, ['system_administrator']);
    // Neither composes notices nor settles: cannot see the notice recommendations at all.
    facilitiesOperator = await staffMember(t, ['facilities_operator']);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    fake.reset();
    t.clock.set(CLOCK_START);
    await t.enableCapability('assistant');
  });

  /** A staff notice proposed and approved by the league manager. */
  async function approvedNotice(title: string): Promise<Rec> {
    fake.script(title, [
      {
        type: 'tool_calls',
        calls: [
          {
            tool: 'communications.send',
            arguments: {
              kind: 'staff_broadcast',
              category: 'operational',
              audience: { staffRoles: ['front_desk'] },
              title,
              body: 'Please read the posted notice.',
            },
          },
        ],
      },
      { type: 'answer', text: 'Drafted.' },
    ]);
    const asked = await post(t, '/v1/assistant/requests', leagueManager, { prompt: title });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const rec = asked.body.recommendations[0] as Rec;
    const approved = await post(t, `/v1/recommendations/${rec.id}/approve`, leagueManager, {
      expectedRevision: rec.revision,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return approved.body as Rec;
  }

  /** The same, applied while communications loses the outcome: claimed, recovery required. */
  async function unknownNotice(title: string): Promise<Rec> {
    const approved = await approvedNotice(title);
    const spy = vi
      .spyOn(t.app.get(NotificationsService), 'composeAndQueue')
      .mockRejectedValueOnce(new Error('connection reset after commit'));
    try {
      const lost = await post(t, `/v1/recommendations/${approved.id}/apply`, leagueManager, {
        expectedRevision: approved.revision,
      });
      expect(lost.status, JSON.stringify(lost.body)).toBe(409);
      expect(lost.body.details).toMatchObject({ code: 'APPLY_OUTCOME_UNKNOWN' });
    } finally {
      spy.mockRestore();
    }
    const after = await get(t, `/v1/recommendations/${approved.id}`, leagueManager);
    expect(after.body).toMatchObject({ status: 'approved', apply: { state: 'running' } });
    return after.body as Rec;
  }

  const operationOf = (id: string) =>
    t.db
      .selectFrom('operations')
      .select(['status', 'result', 'error'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const exceptionOf = (recommendationId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'status', 'resolution'])
      .where('affected_id', '=', recommendationId)
      .executeTakeFirstOrThrow();
  const settle = (actor: Actor, rec: Rec, body: object = {}, idempotencyKey = key()) =>
    post(
      t,
      `/v1/recommendations/${rec.id}/settle-apply`,
      actor,
      {
        expectedRevision: rec.revision,
        outcome: 'applied',
        evidence: 'Communications shows the notice queued at 12:00 for the front desk.',
        reason: 'Checked the communications delivery log',
        ...body,
      },
      idempotencyKey,
    );

  it('AUT-03: an unknown apply is settled as applied with evidence and its exception resolved', async () => {
    const rec = await unknownNotice('notice settled applied');
    const operationId = rec.apply.operationId as string;
    expect((await operationOf(operationId)).status).toBe('recovery_required');
    expect(await exceptionOf(rec.id)).toMatchObject({
      category: 'automation.apply_outcome_unknown',
      status: 'open',
    });
    const notifications = await countRows(t, 'notifications');
    const send = vi.spyOn(t.app.get(NotificationsService), 'composeAndQueue');

    // A reconciliation is never gated by the organization's capability switch (K-12 rule).
    await t.disableCapability('assistant');
    const k = key();
    const settled = await settle(gm, rec, {}, k);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body).toMatchObject({
      id: rec.id,
      status: 'applied',
      revision: rec.revision + 1,
      apply: {
        state: 'applied',
        operationId,
        // SPK-AUTO-003: applied by the approving reviewer whose principal ran the command.
        appliedBy: { accountId: leagueManager.accountId },
        lastError: null,
        settlements: [
          {
            applyOperationId: operationId,
            outcome: 'applied',
            evidence: 'Communications shows the notice queued at 12:00 for the front desk.',
            reason: 'Checked the communications delivery log',
            settledBy: { accountId: gm.accountId, kind: 'staff' },
          },
        ],
      },
    });
    const settlementId = settled.body.apply.settlements[0].id as string;
    expect(settled.body.apply.auditRecordId).toBe(settled.body.apply.settlements[0].auditRecordId);
    // The command is not run again; nothing else is sent.
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
    expect(await countRows(t, 'notifications')).toBe(notifications);
    // The operation succeeds, the exception is resolved, the settlement is audited and announced.
    expect(await operationOf(operationId)).toMatchObject({
      status: 'succeeded',
      result: { recommendationId: rec.id, settlementId, outcome: 'applied' },
    });
    expect(await exceptionOf(rec.id)).toMatchObject({
      status: 'resolved',
      resolution: { settlementId, outcome: 'applied' },
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['id', 'actor', 'reason', 'details'])
      .where('action', '=', 'automation.settle_apply')
      .where('target_id', '=', rec.id)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      id: settled.body.apply.auditRecordId,
      actor: { accountId: gm.accountId },
      reason: 'Checked the communications delivery log',
      details: { settlementId, outcome: 'applied', applyOperationId: operationId },
    });
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'automation.recommendation_applied')
      .where('aggregate_id', '=', rec.id)
      .execute();
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ recommendationId: rec.id, settlementId, commandOperationId: null }),
    ]);

    // Replay answers the recorded outcome; a second settlement is refused (applied is final).
    const replay = await settle(gm, rec, {}, k);
    expect(replay.status).toBe(200);
    expect(replay.body.apply.settlements).toHaveLength(1);
    const again = await settle(sysadmin, settled.body as Rec, { outcome: 'not_applied' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    const settlements = await t.db
      .selectFrom('recommendation_apply_settlements')
      .select('id')
      .where('recommendation_id', '=', rec.id)
      .execute();
    expect(settlements).toHaveLength(1);
  });

  it('AUT-03: an unknown apply settled as not applied releases the claim; the reviewer may apply it again', async () => {
    const rec = await unknownNotice('notice settled not applied');
    const operationId = rec.apply.operationId as string;
    const settled = await settle(sysadmin, rec, {
      outcome: 'not_applied',
      evidence: 'No notification with this title exists in communications.',
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body).toMatchObject({
      status: 'approved',
      apply: {
        state: 'pending',
        operationId: null,
        lastError: { code: 'APPLY_SETTLED_NOT_APPLIED', details: { outcome: 'not_applied' } },
        settlements: [{ outcome: 'not_applied', settledBy: { accountId: sysadmin.accountId } }],
      },
    });
    expect(await operationOf(operationId)).toMatchObject({
      status: 'failed',
      error: { code: 'APPLY_SETTLED_NOT_APPLIED' },
    });
    expect((await exceptionOf(rec.id)).status).toBe('resolved');
    const failedEvents = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'automation.recommendation_apply_failed')
      .where('aggregate_id', '=', rec.id)
      .execute();
    expect(failedEvents.map((e) => e.payload)).toHaveLength(2);
    expect(failedEvents.map((e) => e.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'unknown' }),
        expect.objectContaining({
          outcome: 'failed',
          errorCode: 'APPLY_SETTLED_NOT_APPLIED',
          settlementId: settled.body.apply.settlements[0].id,
        }),
      ]),
    );

    const applied = await post(t, `/v1/recommendations/${rec.id}/apply`, leagueManager, {
      expectedRevision: settled.body.revision,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({
      status: 'applied',
      apply: {
        state: 'applied',
        record: { type: 'notification' },
        settlements: [{ outcome: 'not_applied' }],
      },
    });
    expect(applied.body.apply.operationId).not.toBe(operationId);
  });

  it('AUT-03: a released proposal past its expiry expires through the re-armed timer', async () => {
    const rec = await unknownNotice('notice released after expiry');
    t.clock.advance(25 * 3600_000);
    await drainOutbox(t);
    // Claimed while unknown: the timer could not expire it.
    expect((await get(t, `/v1/recommendations/${rec.id}`, leagueManager)).body.status).toBe(
      'approved',
    );
    const settled = await settle(gm, rec, {
      outcome: 'not_applied',
      evidence: 'Nothing was queued.',
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    await drainOutbox(t);
    const after = await get(t, `/v1/recommendations/${rec.id}`, leagueManager);
    expect(after.body).toMatchObject({ status: 'expired', apply: { state: 'not_applied' } });
  });

  it('AUT-03: only an apply with an unknown outcome is settled, only by a settler; others learn nothing', async () => {
    const approved = await approvedNotice('notice never applied');
    const notUnknown = await settle(gm, approved);
    expect(notUnknown.status).toBe(409);
    expect(notUnknown.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'APPLY_OUTCOME_NOT_UNKNOWN' },
    });

    const rec = await unknownNotice('notice for authority checks');
    // The requester sees it but may not settle it; someone who cannot see it learns nothing.
    const requester = await settle(leagueManager, rec);
    expect(requester.status).toBe(403);
    expect(requester.body.code).toBe('ACCESS_DENIED');
    expect((await settle(facilitiesOperator, rec)).status).toBe(404);
    const customer = await adultCustomer(t);
    expect((await settle(customer, rec)).status).toBe(404);
    const other = await otherOrganization(t);
    const otherGm = await staffMember(t, ['general_manager'], {
      organizationId: other.organizationId,
    });
    expect((await settle(otherGm, rec)).status).toBe(404);
    // Validated and revision-checked like every command.
    const noEvidence = await post(t, `/v1/recommendations/${rec.id}/settle-apply`, gm, {
      expectedRevision: rec.revision,
      outcome: 'applied',
      reason: 'Checked',
    });
    expect(noEvidence.status).toBe(400);
    const stale = await settle(gm, { ...rec, revision: rec.revision - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const unchanged = await get(t, `/v1/recommendations/${rec.id}`, leagueManager);
    expect(unchanged.body).toMatchObject({
      status: 'approved',
      revision: rec.revision,
      apply: { state: 'running', settlements: [] },
    });
  });

  describe('database guarantees (migration 1401)', () => {
    const CHECK = '23514';
    const UNIQUE = '23505';
    const RESTRICT = '23001';

    async function refused(promise: Promise<unknown>, code: string, constraint?: string) {
      let caught: unknown = null;
      try {
        await promise;
      } catch (error) {
        caught = error;
      }
      expect(pgErrorCode(caught), `expected SQLSTATE ${code}`).toBe(code);
      if (constraint) expect(databaseConstraintOf(caught)?.constraint).toBe(constraint);
    }

    const row = (id: string) =>
      t.db.selectFrom('recommendations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

    const settlementValues = (
      rec: { id: string; apply_operation_id: string | null },
      auditRecordId: string,
      actor: Actor,
      overrides: Record<string, unknown> = {},
    ) => ({
      id: newId(),
      organization_id: t.organizationId,
      recommendation_id: rec.id,
      apply_operation_id: rec.apply_operation_id as string,
      outcome: 'applied' as const,
      evidence: 'Checked',
      reason: 'Reconciled',
      settled_by: json({
        kind: 'staff',
        accountId: actor.accountId,
        personId: actor.personId,
        staffRoles: ['general_manager'],
        sessionId: null,
        actorLabel: 'staff:test',
      }),
      settled_by_account_id: actor.accountId,
      settled_by_person_id: actor.personId,
      settled_at: t.clock.now(),
      audit_record_id: auditRecordId,
      correlation_id: null,
      ...overrides,
    });

    const auditRecord = () =>
      t.db.transaction().execute((trx) =>
        t.app.get(AuditWriter).record(trx, {
          organizationId: t.organizationId,
          actor: systemPrincipal(t.organizationId),
          action: 'test.audit',
          targetType: 'recommendation',
          targetId: newId(),
        }),
      );

    it('§4.11: the claim of an apply with an unknown outcome ends only through its settlement — never marked applied, released or rewritten directly', async () => {
      const rec = await row((await unknownNotice('notice guarded by the database')).id);
      const auditId = await auditRecord();
      await refused(
        t.db
          .updateTable('recommendations')
          .set({
            status: 'applied',
            applied_by: json(rec.reviewed_by ?? {}),
            applied_by_account_id: rec.reviewed_by_account_id,
            applied_by_person_id: rec.reviewed_by_person_id,
            applied_at: t.clock.now(),
            applied_audit_record_id: auditId,
            last_apply_error: null,
            revision: rec.revision + 1,
          })
          .where('id', '=', rec.id)
          .execute(),
        CHECK,
        'recommendations_unknown_apply_settled',
      );
      await refused(
        t.db
          .updateTable('recommendations')
          .set({ apply_operation_id: null, apply_started_at: null, revision: rec.revision + 1 })
          .where('id', '=', rec.id)
          .execute(),
        CHECK,
        'recommendations_unknown_apply_settled',
      );
      await refused(
        t.db
          .updateTable('recommendations')
          .set({
            last_apply_error: json({ code: 'X', message: 'rewritten', details: {} }),
            revision: rec.revision + 1,
          })
          .where('id', '=', rec.id)
          .execute(),
        CHECK,
        'recommendations_unknown_apply_settled',
      );
      expect(await row(rec.id)).toMatchObject({ status: 'approved', revision: rec.revision });
    });

    it('§4.7 invariant 5: the database refuses a settlement of an apply that is not unknown, a settlement by a system principal, a second settlement of one apply, and any change to a settlement', async () => {
      const auditId = await auditRecord();
      // An approved recommendation that was never applied has nothing to settle.
      const approved = await row((await approvedNotice('notice without unknown apply')).id);
      const someOperation = (await row((await unknownNotice('notice for an operation')).id))
        .apply_operation_id;
      await refused(
        t.db
          .insertInto('recommendation_apply_settlements')
          .values(
            settlementValues({ id: approved.id, apply_operation_id: someOperation }, auditId, gm),
          )
          .execute(),
        CHECK,
        'recommendation_apply_settlements_unknown_apply',
      );
      const rec = await row((await unknownNotice('notice settled twice')).id);
      await refused(
        t.db
          .insertInto('recommendation_apply_settlements')
          .values(
            settlementValues(rec, auditId, gm, {
              settled_by: json({ ...systemPrincipal(t.organizationId), actorLabel: 'system' }),
            }),
          )
          .execute(),
        CHECK,
      );
      const first = settlementValues(rec, auditId, gm);
      await t.db.insertInto('recommendation_apply_settlements').values(first).execute();
      await refused(
        t.db
          .insertInto('recommendation_apply_settlements')
          .values(settlementValues(rec, auditId, gm, { outcome: 'not_applied' }))
          .execute(),
        UNIQUE,
        'recommendation_apply_settlements_one_per_apply',
      );
      await refused(
        t.db
          .updateTable('recommendation_apply_settlements')
          .set({ outcome: 'not_applied' })
          .where('id', '=', first.id)
          .execute(),
        RESTRICT,
      );
      await refused(
        t.db.deleteFrom('recommendation_apply_settlements').where('id', '=', first.id).execute(),
        RESTRICT,
      );
    });
  });
});

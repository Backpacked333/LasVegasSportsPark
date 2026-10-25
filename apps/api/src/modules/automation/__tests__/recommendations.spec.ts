import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../../testing';
import { NotificationsService } from '../../communications';
import { createCapturedPaymentFixture } from '../../finance';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import type { FakeAssistantProvider } from '../providers/fake-assistant.provider';
import {
  CLOCK_START,
  adultCustomer,
  ask,
  automationTestApp,
  countRows,
  createChange,
  drainOutbox,
  get,
  key,
  openDraft,
  otherOrganization,
  post,
  staffMember,
  type Actor,
} from './automation';

interface Rec {
  id: string;
  revision: number;
  status: string;
}

/**
 * Reviewable recommendations (SPK-AUTO-003, SPK-AUTO-004): a consequential change is applied only
 * after an explicit approval, by the approving reviewer, through the owning module's normal
 * command with the reviewer's own principal; everything else stays a proposal.
 */
describe('recommendations (SPK-AUTO-003, SPK-AUTO-004)', () => {
  let t: TestApp;
  let fake: FakeAssistantProvider;
  let schedulerA: Actor;
  let schedulerB: Actor;
  let frontDesk: Actor;
  let financeOperator: Actor;
  let leagueManager: Actor;
  let sysadmin: Actor;
  let pitch: PitchFixture;
  let day = 1;

  beforeAll(async () => {
    ({ t, fake } = await automationTestApp());
    schedulerA = await staffMember(t, ['scheduler']);
    schedulerB = await staffMember(t, ['scheduler']);
    frontDesk = await staffMember(t, ['front_desk']);
    financeOperator = await staffMember(t, ['finance_operator']);
    leagueManager = await staffMember(t, ['league_manager']);
    sysadmin = await staffMember(t, ['system_administrator']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R',
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    fake.reset();
    t.clock.set(CLOCK_START);
  });

  /** A fresh draft (one game on a new day) and a publication recommendation for it. */
  async function proposePublish(requester: Actor): Promise<{ draftId: string; rec: Rec }> {
    day += 1;
    const date = `2027-02-${String(day).padStart(2, '0')}`;
    const draft = await openDraft(t, requester, `Repair ${day}`, [
      createChange(at(date, '09:00'), at(date, '10:00'), [pitch.southHalfId]),
    ]);
    fake.script(`publish ${draft.id}`, [
      {
        type: 'tool_calls',
        calls: [{ tool: 'scheduling.publish_schedule', arguments: { draftId: draft.id } }],
      },
      { type: 'answer', text: 'Ready for review.' },
    ]);
    const res = await ask(t, requester, { prompt: `publish ${draft.id}` });
    expect(res.body.recommendations).toHaveLength(1);
    return { draftId: draft.id, rec: res.body.recommendations[0] as Rec };
  }

  const draftStatus = async (id: string) =>
    (
      await t.db
        .selectFrom('schedule_drafts')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;

  const approve = (actor: Actor, rec: Rec, extra: object = {}) =>
    post(t, `/v1/recommendations/${rec.id}/approve`, actor, {
      expectedRevision: rec.revision,
      ...extra,
    });
  const apply = (actor: Actor, rec: Rec, idempotencyKey = key()) =>
    post(
      t,
      `/v1/recommendations/${rec.id}/apply`,
      actor,
      { expectedRevision: rec.revision },
      idempotencyKey,
    );

  it('SPK-AUTO-003: proposed → approved → applied by the approving reviewer through scheduling, with the reviewer’s principal; a replay applies nothing more', async () => {
    const { draftId, rec } = await proposePublish(schedulerA);
    expect(rec.status).toBe('proposed');
    // Not before an explicit approval.
    const early = await apply(schedulerB, rec);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    // Another scheduler holds scheduling.publish_schedule on the draft: they may review it.
    expect((await get(t, `/v1/recommendations/${rec.id}`, schedulerB)).status).toBe(200);
    const stale = await approve(schedulerB, { ...rec, revision: rec.revision + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const approved = await approve(schedulerB, rec, { reason: 'Checked the conflicts' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'approved',
      review: {
        decision: 'approved',
        reviewer: { accountId: schedulerB.accountId },
        reason: 'Checked the conflicts',
      },
      apply: { state: 'pending' },
    });
    expect(await draftStatus(draftId)).toBe('editing');
    // Only the approving reviewer applies it (the requester did not approve it).
    const notReviewer = await apply(schedulerA, approved.body);
    expect(notReviewer.status).toBe(403);
    expect(notReviewer.body.code).toBe('ACCESS_DENIED');
    const k = key();
    const applied = await apply(schedulerB, approved.body, k);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({
      status: 'applied',
      apply: {
        state: 'applied',
        appliedBy: { accountId: schedulerB.accountId },
        record: { type: 'schedule_publication' },
      },
    });
    expect(await draftStatus(draftId)).toBe('published');
    const publication = await t.db
      .selectFrom('publications')
      .select(['id', 'actor', 'operation_id'])
      .where('draft_id', '=', draftId)
      .execute();
    expect(publication).toHaveLength(1);
    expect(publication[0]?.actor).toMatchObject({ accountId: schedulerB.accountId });
    expect(applied.body.apply.commandOperationId).toBe(publication[0]?.operation_id);
    // The apply is logged under the reviewer, with its coordinating operation and audit record.
    const invocations = await t.db
      .selectFrom('tool_invocations')
      .select(['phase', 'outcome', 'principal', 'recommendation_id', 'operation_id'])
      .where('recommendation_id', '=', rec.id)
      .execute();
    expect(invocations).toEqual([
      expect.objectContaining({
        phase: 'apply',
        outcome: 'succeeded',
        principal: expect.objectContaining({ accountId: schedulerB.accountId }),
        operation_id: applied.body.apply.operationId,
      }),
    ]);
    const op = await get(t, `/v1/operations/${applied.body.apply.operationId}`, schedulerB);
    expect(op.body).toMatchObject({ kind: 'automation.apply_recommendation', status: 'succeeded' });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'actor'])
      .where('id', '=', applied.body.apply.auditRecordId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      action: 'automation.apply_recommendation',
      actor: expect.objectContaining({ accountId: schedulerB.accountId }),
    });
    // §4.9 replay: same key, same body → the stored outcome; nothing is published twice.
    const replay = await apply(schedulerB, approved.body, k);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(rec.id);
    const again = await apply(schedulerB, applied.body);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    expect(
      await t.db.selectFrom('publications').select('id').where('draft_id', '=', draftId).execute(),
    ).toHaveLength(1);
  });

  it('§4.7 invariant 5: two concurrent applies of one recommendation publish once', async () => {
    const { draftId, rec } = await proposePublish(schedulerA);
    const approved = await approve(schedulerA, rec);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const results = await Promise.all([
      apply(schedulerA, approved.body),
      apply(schedulerA, approved.body),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(
      await t.db.selectFrom('publications').select('id').where('draft_id', '=', draftId).execute(),
    ).toHaveLength(1);
    const applies = await t.db
      .selectFrom('tool_invocations')
      .select('outcome')
      .where('recommendation_id', '=', rec.id)
      .execute();
    expect(applies).toEqual([{ outcome: 'succeeded' }]);
  });

  it('§4.10: a recommendation exists only for its requester and for people who hold its command’s action on its target', async () => {
    const { rec } = await proposePublish(schedulerA);
    const customer = await adultCustomer(t);
    const other = await otherOrganization(t);
    const foreignScheduler = await staffMember(t, ['scheduler'], {
      organizationId: other.organizationId,
    });
    const elsewhere = await t.db
      .insertInto('facilities')
      .values({
        id: '01a16dc4-0000-7000-8000-000000000001',
        organization_id: t.organizationId,
        slug: 'annex',
        name: 'Annex',
        timezone: 'America/Los_Angeles',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const annexScheduler = await staffMember(t, ['scheduler'], { facilityIds: [elsewhere.id] });
    for (const viewer of [frontDesk, financeOperator, customer, foreignScheduler, annexScheduler]) {
      const res = await get(t, `/v1/recommendations/${rec.id}`, viewer);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
      const review = await approve(viewer, rec);
      expect(review.status).toBe(404);
    }
    expect((await get(t, `/v1/recommendations/${rec.id}`, schedulerA)).status).toBe(200);
    // Lists: the requester's own and those the viewer may apply.
    const listA = await get(t, '/v1/recommendations?status=proposed', schedulerA);
    expect(listA.body.items.map((r: Rec) => r.id)).toContain(rec.id);
    const listFront = await get(t, '/v1/recommendations', frontDesk);
    expect(listFront.body.items.map((r: Rec) => r.id)).not.toContain(rec.id);
    const listAnnex = await get(t, '/v1/recommendations', annexScheduler);
    expect(listAnnex.body.items.map((r: Rec) => r.id)).not.toContain(rec.id);
  });

  it('SPK-AUTO-004: applying uses the reviewer’s authority at apply time — after losing the scheduler role scheduling refuses, the claim is released and the denial is logged', async () => {
    const person = await staffMember(t, ['front_desk']);
    const scheduler = await staffMember(t, ['scheduler'], { personId: person.personId });
    const { draftId, rec } = await proposePublish(scheduler);
    const approved = await approve(scheduler, rec);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const ended = await post(t, `/v1/staff-memberships/${scheduler.membershipId}/end`, sysadmin, {
      reason: 'Moved to the front desk',
    });
    expect(ended.status, JSON.stringify(ended.body)).toBeLessThan(300);
    // Still the requester and approver (self), but no longer a scheduler: scheduling decides.
    const refused = await apply(person, approved.body);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCESS_DENIED');
    expect(await draftStatus(draftId)).toBe('editing');
    const after = await get(t, `/v1/recommendations/${rec.id}`, person);
    expect(after.body).toMatchObject({
      status: 'approved',
      apply: {
        state: 'pending',
        operationId: null,
        lastError: { code: 'ACCESS_DENIED' },
      },
    });
    const invocations = await t.db
      .selectFrom('tool_invocations')
      .select(['outcome', 'error_code', 'operation_id'])
      .where('recommendation_id', '=', rec.id)
      .execute();
    expect(invocations).toEqual([
      expect.objectContaining({ outcome: 'denied', error_code: 'ACCESS_DENIED' }),
    ]);
    const op = await t.db
      .selectFrom('operations')
      .select('status')
      .where('id', '=', invocations[0]?.operation_id as string)
      .executeTakeFirstOrThrow();
    expect(op.status).toBe('failed');
    const denial = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('action', '=', 'automation.tool_invocation_denied')
      .where('target_id', '=', approved.body.assistantRequestId)
      .executeTakeFirstOrThrow();
    expect(denial.details).toMatchObject({ phase: 'apply', errorCode: 'ACCESS_DENIED' });
  });

  it('SPK-AUTO-003: a refund is applied once by the approving finance reviewer; finance still refuses a refund beyond the refundable funds (failed, claim released)', async () => {
    const payer = await adultCustomer(t);
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 5000,
    });
    const proposeRefund = async (amountMinor: number): Promise<Rec> => {
      fake.script(`refund ${amountMinor}`, [
        {
          type: 'tool_calls',
          calls: [
            {
              tool: 'finance.refund',
              arguments: {
                paymentAttemptId: payment.paymentAttemptId,
                amountMinor,
                reason: 'Charged twice',
              },
            },
          ],
        },
        { type: 'answer', text: 'Refund prepared.' },
      ]);
      const res = await ask(t, financeOperator, { prompt: `refund ${amountMinor}` });
      return res.body.recommendations[0] as Rec;
    };
    const first = await proposeRefund(2000);
    const firstApproved = await approve(financeOperator, first);
    const firstApplied = await apply(financeOperator, firstApproved.body);
    expect(firstApplied.status, JSON.stringify(firstApplied.body)).toBe(200);
    const second = await proposeRefund(4000);
    const secondApproved = await approve(financeOperator, second);
    const refused = await apply(financeOperator, secondApproved.body);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    const refunds = await t.db
      .selectFrom('refund_attempts')
      .select('amount_minor')
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .execute();
    expect(refunds).toEqual([{ amount_minor: 2000 }]);
    const after = await get(t, `/v1/recommendations/${second.id}`, financeOperator);
    expect(after.body).toMatchObject({
      status: 'approved',
      apply: { state: 'pending', lastError: { code: 'RESOURCE_CONFLICT' } },
    });
    const outcome = await t.db
      .selectFrom('tool_invocations')
      .select('outcome')
      .where('recommendation_id', '=', second.id)
      .executeTakeFirstOrThrow();
    expect(outcome.outcome).toBe('failed');
  });

  it('SPK-AUTO-001 / SPK-AUTO-003: a drafted notice is sent only when the reviewer applies it, as the reviewer', async () => {
    const coachPerson = await staffMember(t, ['coach']);
    fake.script('draft a notice', [
      {
        type: 'tool_calls',
        calls: [
          {
            tool: 'communications.send',
            arguments: {
              kind: 'staff_broadcast',
              category: 'operational',
              audience: { personIds: [coachPerson.personId] },
              title: 'Field change on Saturday',
              body: 'Games move to Pitch R north.',
              rationale: 'Coaches need the new field',
            },
          },
        ],
      },
      { type: 'answer', text: 'A notice is drafted for your review.' },
    ]);
    const before = await countRows(t, 'notifications');
    const res = await ask(t, leagueManager, { prompt: 'Draft a notice to the coach' });
    const rec = res.body.recommendations[0];
    expect(rec).toMatchObject({
      kind: 'communication_draft',
      summary: 'Coaches need the new field',
      payload: { title: 'Field change on Saturday', body: 'Games move to Pitch R north.' },
      command: { actionId: 'communications.send' },
    });
    expect(await countRows(t, 'notifications')).toBe(before);
    const approved = await approve(leagueManager, rec);
    const applied = await apply(leagueManager, approved.body);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const notification = await t.db
      .selectFrom('notifications')
      .select(['id', 'created_by', 'status', 'title'])
      .where('id', '=', applied.body.apply.record.id)
      .executeTakeFirstOrThrow();
    expect(notification).toMatchObject({ title: 'Field change on Saturday', status: 'queued' });
    expect(notification.created_by).toMatchObject({ accountId: leagueManager.accountId });
  });

  it('§4.12: an apply whose outcome cannot be learned stays claimed — never applied twice — with an owned exception and a recovery-required operation', async () => {
    fake.script('notice for the desk', [
      {
        type: 'tool_calls',
        calls: [
          {
            tool: 'communications.send',
            arguments: {
              kind: 'staff_broadcast',
              category: 'operational',
              audience: { staffRoles: ['front_desk'] },
              title: 'Desk notice',
              body: 'Please check the lost and found.',
            },
          },
        ],
      },
      { type: 'answer', text: 'Drafted.' },
    ]);
    const rec = (await ask(t, leagueManager, { prompt: 'notice for the desk' })).body
      .recommendations[0];
    const approved = await approve(leagueManager, rec);
    const spy = vi
      .spyOn(t.app.get(NotificationsService), 'composeAndQueue')
      .mockRejectedValueOnce(new Error('connection reset after commit'));
    try {
      const lost = await apply(leagueManager, approved.body);
      expect(lost.status).toBe(409);
      expect(lost.body).toMatchObject({
        code: 'RESOURCE_CONFLICT',
        nextAction: 'await_reconciliation',
        details: { code: 'APPLY_OUTCOME_UNKNOWN' },
      });
    } finally {
      spy.mockRestore();
    }
    const after = await get(t, `/v1/recommendations/${rec.id}`, leagueManager);
    expect(after.body).toMatchObject({
      status: 'approved',
      apply: { state: 'running', lastError: { code: 'APPLY_OUTCOME_UNKNOWN' } },
    });
    const op = await t.db
      .selectFrom('operations')
      .select('status')
      .where('id', '=', after.body.apply.operationId)
      .executeTakeFirstOrThrow();
    expect(op.status).toBe('recovery_required');
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue', 'status'])
      .where('affected_id', '=', rec.id)
      .executeTakeFirstOrThrow();
    expect(exception).toEqual({
      category: 'automation.apply_outcome_unknown',
      owner_queue: 'general_manager',
      status: 'open',
    });
    // A retry is refused instead of sending a second time; the timer cannot expire it either.
    const retry = await apply(leagueManager, after.body);
    expect(retry.status).toBe(409);
    expect(retry.body.details).toMatchObject({ code: 'APPLY_IN_PROGRESS' });
    t.clock.advance(25 * 3600_000);
    await drainOutbox(t);
    expect((await get(t, `/v1/recommendations/${rec.id}`, leagueManager)).body.status).toBe(
      'approved',
    );
    const outcome = await t.db
      .selectFrom('tool_invocations')
      .select('outcome')
      .where('recommendation_id', '=', rec.id)
      .execute();
    expect(outcome).toEqual([{ outcome: 'unknown' }]);
  });

  it('SPK-AUTO-001: a schedule repair proposes draft changes; applying opens the draft and publishes it as the reviewer', async () => {
    fake.script('repair the clash', [
      {
        type: 'tool_calls',
        calls: [
          {
            tool: 'scheduling.publish_schedule',
            arguments: {
              repair: {
                facilityId: t.facilityId,
                name: 'Clash repair',
                changes: [
                  createChange(at('2027-03-06', '09:00'), at('2027-03-06', '10:00'), [
                    pitch.northHalfId,
                  ]),
                ],
              },
            },
          },
        ],
      },
      { type: 'answer', text: 'A repair is ready.' },
    ]);
    const res = await ask(t, schedulerA, { prompt: 'Repair the clash' });
    const rec = res.body.recommendations[0];
    expect(rec).toMatchObject({
      kind: 'schedule_repair',
      command: { target: { type: 'schedule_draft', id: null, facilityId: t.facilityId } },
    });
    expect(rec.missingEvidence).toContainEqual(
      expect.objectContaining({ recordType: 'schedule_draft_validation', reason: 'not_evaluated' }),
    );
    const drafts = await t.db
      .selectFrom('schedule_drafts')
      .select('id')
      .where('name', '=', 'Clash repair')
      .execute();
    expect(drafts).toEqual([]);
    const approved = await approve(schedulerA, rec);
    const applied = await apply(schedulerA, approved.body);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const draft = await t.db
      .selectFrom('schedule_drafts')
      .select(['status', 'author'])
      .where('name', '=', 'Clash repair')
      .executeTakeFirstOrThrow();
    expect(draft.status).toBe('published');
    expect(draft.author).toMatchObject({ accountId: schedulerA.accountId });
  });

  it('SPK-AUTO-003: rejecting needs a reason and is final; informational recommendations cannot be applied', async () => {
    const { rec } = await proposePublish(schedulerA);
    const noReason = await post(t, `/v1/recommendations/${rec.id}/reject`, schedulerA, {
      expectedRevision: rec.revision,
    });
    expect(noReason.status).toBe(400);
    const rejected = await post(t, `/v1/recommendations/${rec.id}/reject`, schedulerA, {
      expectedRevision: rec.revision,
      reason: 'Not this week',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      review: { decision: 'rejected', reason: 'Not this week' },
      apply: { state: 'not_applied' },
    });
    const late = await approve(schedulerA, rejected.body);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_TRANSITION');

    fake.script('explain', [
      {
        type: 'answer',
        text: 'Explained.',
        recommendations: [{ kind: 'issue_summary', title: 'Summary', summary: 'Nothing urgent' }],
      },
    ]);
    const info = (await ask(t, schedulerA, { prompt: 'explain today' })).body.recommendations[0];
    const accepted = await approve(schedulerA, info);
    expect(accepted.body).toMatchObject({ status: 'approved', apply: { state: 'not_applicable' } });
    const notApplicable = await apply(schedulerA, accepted.body);
    expect(notApplicable.status).toBe(409);
    expect(notApplicable.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { kind: 'issue_summary' },
    });
  });

  it('expiry: an unreviewed recommendation expires on its timer; a review arriving after the deadline expires it and is refused', async () => {
    const timed = await proposePublish(schedulerA);
    const late = await proposePublish(schedulerA);
    t.clock.advance(25 * 3600_000);
    // A command after the deadline commits the expiry and is refused.
    const refused = await approve(schedulerA, late.rec);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'expired' },
    });
    expect((await get(t, `/v1/recommendations/${late.rec.id}`, schedulerA)).body).toMatchObject({
      status: 'expired',
    });
    // The durable timer expires the other one (idempotent under replay).
    await drainOutbox(t);
    const expired = await get(t, `/v1/recommendations/${timed.rec.id}`, schedulerA);
    expect(expired.body).toMatchObject({
      status: 'expired',
      expiredAt: t.clock.now().toISOString(),
    });
    expect(await draftStatus(timed.draftId)).toBe('editing');
    const auditCount = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'automation.recommendation_expired')
      .where('target_id', '=', timed.rec.id)
      .execute();
    expect(auditCount).toHaveLength(1);
  });
});

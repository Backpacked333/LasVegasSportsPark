import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { authHeaderForPerson, createAccountFixture, createPersonFixture } from '../../identity';
import {
  adultCustomer,
  competitionWorld,
  expectPgError,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
  type ScheduledFixture,
} from './support';

const HOUR = 3_600_000;

describe('time-bounded access, fees and the coach/referee workspace (SPK-STAFF-004, SPK-STAFF-006, SPK-UX-007)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let leagueManager: Actor;
  let finance: Actor;
  let game: ScheduledFixture;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    leagueManager = world.leagueManager;
    finance = await staffMember(t, ['finance_operator']);
    game = await scheduleFixture(t, world, { date: '2027-01-16' });
  });
  afterAll(async () => {
    await t.close();
  });

  const me = async (actor: Actor) => {
    const res = await t.http.get('/v1/me').set(actor.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { principal: { kind: string; staffRoles: string[]; facilityIds: string[] } };
  };

  /** A substitute official (an adult without staff membership) accepted for `fixtureId`. */
  async function acceptedSubstitute(fixtureId: string, person: Actor) {
    const created = await post(t, '/v1/assignments', leagueManager, {
      personId: person.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: fixtureId,
      role: 'referee',
      engagement: 'substitute',
      offer: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const accepted = await post(
      t,
      `/v1/assignments/${created.body.assignment.id}/accept`,
      person,
      {},
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return accepted.body as {
      assignment: {
        id: string;
        access: { status: string; until: string; staffMembershipId: string };
      };
      operationId: string;
    };
  }

  it('SPK-STAFF-004: substitute work grants time-bounded access that expires without removing the work records', async () => {
    const parentReferee = await adultCustomer(t);
    expect((await me(parentReferee)).principal).toMatchObject({ kind: 'customer', staffRoles: [] });
    const accepted = await acceptedSubstitute(game.fixtureId, parentReferee);
    expect(accepted.assignment.access).toMatchObject({ status: 'granted' });
    expect(accepted.assignment.access.until).toBe(
      new Date(new Date(game.end).getTime() + 24 * HOUR).toISOString(),
    );
    const operation = await t.http
      .get(`/v1/operations/${accepted.operationId}`)
      .set(parentReferee.header);
    expect(operation.body).toMatchObject({
      kind: 'workforce.accept_assignment',
      status: 'succeeded',
      result: {
        access: 'granted',
        staffMembershipId: accepted.assignment.access.staffMembershipId,
      },
    });
    // during the window the person acts as an official, scoped to the facility of the game
    expect((await me(parentReferee)).principal).toMatchObject({
      kind: 'staff',
      staffRoles: ['official'],
      facilityIds: [t.facilityId],
    });

    // the game is played and the work completed; the official submits their fee
    t.clock.set(new Date(new Date(game.start).getTime() + 2 * HOUR));
    const completed = await post(
      t,
      `/v1/assignments/${accepted.assignment.id}/complete`,
      leagueManager,
      {},
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const fee = await post(t, '/v1/fee-submissions', parentReferee, {
      assignmentId: accepted.assignment.id,
      rateBasis: { kind: 'per_assignment', rateMinor: 4500 },
      submittedAmountMinor: 4500,
      currency: 'USD',
    });
    expect(fee.status, JSON.stringify(fee.body)).toBe(201);

    // the access window closes: roles are gone, history stays
    t.clock.set(new Date(new Date(accepted.assignment.access.until).getTime() + 1));
    expect((await me(parentReferee)).principal).toMatchObject({ kind: 'customer', staffRoles: [] });
    const membership = await t.db
      .selectFrom('staff_memberships')
      .select(['status', 'effective_to'])
      .where('id', '=', accepted.assignment.access.staffMembershipId)
      .executeTakeFirstOrThrow();
    expect(new Date(membership.effective_to as Date).toISOString()).toBe(
      accepted.assignment.access.until,
    );
    const workspace = await t.http
      .get('/v1/me/assignments?from=2027-01-01T00:00:00Z')
      .set(parentReferee.header);
    expect(workspace.status, JSON.stringify(workspace.body)).toBe(200);
    expect(workspace.body.items).toHaveLength(1);
    expect(workspace.body.items[0]).toMatchObject({
      assignment: {
        id: accepted.assignment.id,
        status: 'completed',
        access: { status: 'granted', active: false },
      },
      fee: { id: fee.body.id, status: 'submitted' },
    });
    const ownFee = await t.http.get(`/v1/fee-submissions/${fee.body.id}`).set(parentReferee.header);
    expect(ownFee.status).toBe(200);
    // the database refuses to delete historical work records
    await expectPgError(
      t.db.deleteFrom('assignments').where('id', '=', accepted.assignment.id).execute(),
      '23001',
    );
    t.clock.set('2027-01-16T20:00:00Z');
  });

  it('SPK-STAFF-004: withdrawing substitute work ends its access immediately', async () => {
    const g = await scheduleFixture(t, world, { date: '2027-01-17' });
    const volunteer = await adultCustomer(t);
    const accepted = await acceptedSubstitute(g.fixtureId, volunteer);
    expect((await me(volunteer)).principal.staffRoles).toEqual(['official']);
    t.clock.advance(HOUR);
    const withdrawn = await post(
      t,
      `/v1/assignments/${accepted.assignment.id}/withdraw`,
      volunteer,
      {
        reason: 'Travel',
      },
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.assignment.access).toMatchObject({ status: 'ended', active: false });
    expect(withdrawn.body.operationId).toEqual(expect.any(String));
    expect((await me(volunteer)).principal).toMatchObject({ kind: 'customer', staffRoles: [] });
    const membership = await t.db
      .selectFrom('staff_memberships')
      .select(['status', 'ended_reason'])
      .where('id', '=', accepted.assignment.access.staffMembershipId)
      .executeTakeFirstOrThrow();
    expect(membership).toEqual({ status: 'ended', ended_reason: 'Travel' });
    t.clock.set('2027-01-16T20:00:00Z');
  });

  it('SPK-STAFF-004 recovery: when identity refuses the access grant the acceptance stands, the failure is recorded and escalated', async () => {
    const g = await scheduleFixture(t, world, { date: '2027-01-20' });
    // a youth referee: identity grants staff memberships to adults only
    const youthId = await createPersonFixture(t, { kind: 'child', dateOfBirth: '2011-05-01' });
    await createAccountFixture(t, { personId: youthId });
    const youth: Actor = {
      personId: youthId,
      accountId: '',
      header: await authHeaderForPerson(t, youthId),
    };
    const accepted = await acceptedSubstitute(g.fixtureId, youth);
    expect(accepted.assignment).toMatchObject({ status: 'accepted', access: { status: 'failed' } });
    const operation = await t.http.get(`/v1/operations/${accepted.operationId}`).set(youth.header);
    expect(operation.body).toMatchObject({
      status: 'recovery_required',
      error: { code: 'VALIDATION_FAILED', details: { step: 'grant' } },
    });
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue', 'status'])
      .where('affected_id', '=', accepted.assignment.id)
      .executeTakeFirstOrThrow();
    expect(exception).toEqual({
      category: 'workforce.temporary_access_failed',
      owner_queue: 'system_administrator',
      status: 'open',
    });
    expect((await me(youth)).principal.staffRoles).toEqual([]);
  });

  it('SPK-STAFF-006: fees carry rate basis, approver and an append-only adjustment history, then export without payroll', async () => {
    const official = await staffMember(t, ['official']);
    const g = await scheduleFixture(t, world, { date: '2027-01-18' });
    const created = await post(t, '/v1/assignments', leagueManager, {
      personId: official.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: g.fixtureId,
      role: 'referee',
      offer: true,
    });
    const assignmentId = created.body.assignment.id as string;
    await post(t, `/v1/assignments/${assignmentId}/accept`, official, {});
    const feeBody = {
      assignmentId,
      rateBasis: { kind: 'hourly', rateMinor: 3000, minutes: 75 },
      submittedAmountMinor: 4000,
      currency: 'USD',
      note: 'Includes warm-up',
    };
    const early = await post(t, '/v1/fee-submissions', official, feeBody);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_TRANSITION');

    t.clock.set(new Date(new Date(g.end).getTime() + HOUR));
    await post(t, `/v1/assignments/${assignmentId}/complete`, leagueManager, {});
    const notMine = await post(t, '/v1/fee-submissions', leagueManager, feeBody);
    expect(notMine.status).toBe(403);
    const submitted = await post(t, '/v1/fee-submissions', official, feeBody);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(submitted.body).toMatchObject({
      status: 'submitted',
      computedAmountMinor: 3750,
      submittedAmountMinor: 4000,
      approvedAmountMinor: null,
      adjustments: [],
    });
    const duplicate = await post(t, '/v1/fee-submissions', official, feeBody);
    expect(duplicate.status).toBe(409);

    // segregation of duties: nobody approves their own fee
    const selfApprove = await post(
      t,
      `/v1/fee-submissions/${submitted.body.id}/approve`,
      official,
      {},
    );
    expect(selfApprove.status).toBe(403);
    const byManager = await post(
      t,
      `/v1/fee-submissions/${submitted.body.id}/approve`,
      leagueManager,
      {},
    );
    expect(byManager.status).toBe(404);

    const adjusted = await post(t, `/v1/fee-submissions/${submitted.body.id}/adjust`, finance, {
      amountMinor: 3750,
      reason: 'Rate card: 75 minutes at 30.00/h',
      expectedRevision: submitted.body.revision,
    });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
    expect(adjusted.body).toMatchObject({
      status: 'adjusted',
      approvedAmountMinor: 3750,
      approver: { kind: 'staff' },
      adjustments: [{ sequence: 1, previousAmountMinor: 4000, adjustedAmountMinor: 3750 }],
    });
    const stale = await post(t, `/v1/fee-submissions/${submitted.body.id}/adjust`, finance, {
      amountMinor: 3800,
      reason: 'again',
      expectedRevision: submitted.body.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const second = await post(t, `/v1/fee-submissions/${submitted.body.id}/adjust`, finance, {
      amountMinor: 3800,
      reason: 'Travel allowance',
      expectedRevision: adjusted.body.revision,
    });
    expect(
      second.body.adjustments.map((a: { sequence: number; adjustedAmountMinor: number }) => [
        a.sequence,
        a.adjustedAmountMinor,
      ]),
    ).toEqual([
      [1, 3750],
      [2, 3800],
    ]);

    // the adjustment history is append-only in the database
    const firstAdjustment = second.body.adjustments[0].id as string;
    await expectPgError(
      t.db
        .updateTable('fee_adjustments')
        .set({ adjusted_amount_minor: 1 })
        .where('id', '=', firstAdjustment)
        .execute(),
      '23001',
    );
    await expectPgError(
      t.db.deleteFrom('fee_adjustments').where('id', '=', firstAdjustment).execute(),
      '23001',
    );

    // export: finance only; a general manager approves but does not export
    const gm = await staffMember(t, ['general_manager']);
    const gmExport = await post(t, '/v1/fee-export-batches', gm, { currency: 'USD' });
    expect(gmExport.status).toBe(403);
    const batch = await post(t, '/v1/fee-export-batches', finance, { currency: 'USD' });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    expect(batch.body).toMatchObject({
      currency: 'USD',
      submissionCount: 1,
      totalMinor: 3800,
      lines: [{ feeSubmissionId: submitted.body.id, amountMinor: 3800, role: 'referee' }],
    });
    const exported = await t.http
      .get(`/v1/fee-submissions/${submitted.body.id}`)
      .set(finance.header);
    expect(exported.body).toMatchObject({ status: 'exported', exportBatchId: batch.body.id });
    const again = await post(t, '/v1/fee-export-batches', finance, { currency: 'USD' });
    expect(again.status).toBe(400);
    const afterExport = await post(t, `/v1/fee-submissions/${submitted.body.id}/adjust`, finance, {
      amountMinor: 1,
      reason: 'too late',
    });
    expect(afterExport.body.code).toBe('INVALID_TRANSITION');
    await expectPgError(
      t.db
        .updateTable('fee_export_batches')
        .set({ total_minor: 0 })
        .where('id', '=', batch.body.id)
        .execute(),
      '23001',
    );
    const customer = await adultCustomer(t);
    const listByCustomer = await t.http.get('/v1/fee-submissions').set(customer.header);
    expect(listByCustomer.status).toBe(403);
    const listByFinance = await t.http
      .get('/v1/fee-submissions?status=exported')
      .set(finance.header);
    expect(listByFinance.body.items.map((f: { id: string }) => f.id)).toContain(submitted.body.id);
    t.clock.set('2027-01-16T20:00:00Z');
  });

  it('SPK-UX-007: the workspace lists only the caller’s assignments with team names and available actions', async () => {
    const coachOfficial = await staffMember(t, ['official']);
    const someoneElse = await staffMember(t, ['official']);
    const g = await scheduleFixture(t, world, { date: '2027-01-19' });
    const mine = await post(t, '/v1/assignments', leagueManager, {
      personId: coachOfficial.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: g.fixtureId,
      role: 'referee',
      offer: true,
    });
    await post(t, '/v1/assignments', leagueManager, {
      personId: someoneElse.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: g.fixtureId,
      role: 'assistant_referee',
      offer: true,
    });
    const res = await t.http.get('/v1/me/assignments').set(coachOfficial.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.assignment.id).toBe(mine.body.assignment.id);
    expect(item.activity).toMatchObject({
      targetType: 'fixture',
      targetId: g.fixtureId,
      scheduledStart: g.start,
      facilityId: t.facilityId,
    });
    expect(item.activity.participants).toEqual([
      { side: 'home', teamEntryId: g.homeEntryId, name: expect.stringMatching(/^Lions/) },
      { side: 'away', teamEntryId: g.awayEntryId, name: expect.stringMatching(/^Tigers/) },
    ]);
    expect(item.availableActions).toEqual(['accept', 'decline']);
    // nothing personal about participants travels to the workspace
    expect(JSON.stringify(res.body)).not.toMatch(/dateOfBirth|contactPoints|email/);
    const anonymous = await t.http.get('/v1/me/assignments');
    expect(anonymous.status).toBe(401);
  });
});

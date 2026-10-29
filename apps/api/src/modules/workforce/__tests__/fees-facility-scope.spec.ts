import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  CLOCK_START,
  competitionWorld,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

const HOUR = 3_600_000;

/**
 * A fee belongs to its assignment's facility (SPK-STAFF-006, §4.3 facility boundaries, §4.14
 * object-level authorization): staff scoped to another facility cannot read, decide or export it,
 * exactly as they cannot see the assignment behind it.
 */
describe('fee submissions follow the assignment’s facility scope (SPK-STAFF-006, §4.3, §4.14)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let lm: Actor;
  let annex: string;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    lm = world.leagueManager;
    annex = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: annex,
        organization_id: t.organizationId,
        slug: `annex-${annex.slice(0, 8)}`,
        name: 'Annex',
        timezone: 'America/Los_Angeles',
      })
      .execute();
  });
  afterAll(async () => {
    await t.close();
  });

  async function completedFee(date: string, official?: Actor) {
    const person = official ?? (await staffMember(t, ['official']));
    const game = await scheduleFixture(t, world, { date });
    const offered = await post(t, '/v1/assignments', lm, {
      personId: person.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: game.fixtureId,
      role: 'referee',
      offer: true,
    });
    expect(offered.status, JSON.stringify(offered.body)).toBe(201);
    const id = offered.body.assignment.id as string;
    expect((await post(t, `/v1/assignments/${id}/accept`, person, {})).status).toBe(200);
    try {
      t.clock.set(new Date(new Date(game.end).getTime() + HOUR));
      expect((await post(t, `/v1/assignments/${id}/complete`, lm, {})).status).toBe(200);
      const fee = await post(t, '/v1/fee-submissions', person, {
        assignmentId: id,
        rateBasis: { kind: 'per_assignment', rateMinor: 5000 },
        submittedAmountMinor: 5000,
        currency: 'USD',
      });
      expect(fee.status, JSON.stringify(fee.body)).toBe(201);
      return { assignmentId: id, feeId: fee.body.id as string };
    } finally {
      t.clock.set(CLOCK_START);
    }
  }

  it('SPK-STAFF-006 / §4.14: staff scoped to another facility get NOT_FOUND on read and decisions, see none in lists and export none', async () => {
    const a = await completedFee('2027-03-03');
    const b = await completedFee('2027-03-04');
    const annexFinance = await staffMember(t, ['finance_operator'], { facilityIds: [annex] });
    const annexGm = await staffMember(t, ['general_manager'], { facilityIds: [annex] });

    for (const actor of [annexFinance, annexGm]) {
      expect((await t.http.get(`/v1/fee-submissions/${a.feeId}`).set(actor.header)).status).toBe(
        404,
      );
      const list = await t.http.get('/v1/fee-submissions').set(actor.header);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.items).toEqual([]);
      expect((await post(t, `/v1/fee-submissions/${a.feeId}/approve`, actor, {})).status).toBe(404);
      expect(
        (
          await post(t, `/v1/fee-submissions/${a.feeId}/adjust`, actor, {
            amountMinor: 100,
            reason: 'Cut',
            expectedRevision: 1,
          })
        ).status,
      ).toBe(404);
      expect(
        (await post(t, `/v1/fee-submissions/${b.feeId}/reject`, actor, { reason: 'Not ours' }))
          .status,
      ).toBe(404);
    }
    // a main-facility operator decides; the annex operator exports none of it, even by id
    const mainFinance = await staffMember(t, ['finance_operator'], { facilityIds: [t.facilityId] });
    const approved = await post(t, `/v1/fee-submissions/${a.feeId}/approve`, mainFinance, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const exportAll = await post(t, '/v1/fee-export-batches', annexFinance, { currency: 'USD' });
    expect(exportAll.status, JSON.stringify(exportAll.body)).toBe(400);
    const exportById = await post(t, '/v1/fee-export-batches', annexFinance, {
      currency: 'USD',
      submissionIds: [a.feeId],
    });
    expect(exportById.status, JSON.stringify(exportById.body)).toBe(400);
    expect(exportById.body.details).toMatchObject({ ineligibleSubmissionIds: [a.feeId] });

    // an organization-wide operator exports it; the annex operator may not read that batch
    const orgFinance = await staffMember(t, ['finance_operator']);
    const batch = await post(t, '/v1/fee-export-batches', orgFinance, { currency: 'USD' });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    expect(batch.body.lines.map((l: { feeSubmissionId: string }) => l.feeSubmissionId)).toEqual([
      a.feeId,
    ]);
    const annexRead = await t.http
      .get(`/v1/fee-export-batches/${batch.body.id}`)
      .set(annexFinance.header);
    expect(annexRead.status).toBe(403);
    const mainRead = await t.http
      .get(`/v1/fee-export-batches/${batch.body.id}`)
      .set(mainFinance.header);
    expect(mainRead.status).toBe(200);
    const mainList = await t.http.get('/v1/fee-submissions').set(mainFinance.header);
    expect(mainList.body.items.map((f: { id: string }) => f.id).sort()).toEqual(
      [a.feeId, b.feeId].sort(),
    );
  });

  it('SPK-STAFF-006: a facility-scoped finance operator who is the assignee still reads their own fee elsewhere through self authority', async () => {
    const operator = await staffMember(t, ['finance_operator', 'official'], {
      facilityIds: [annex],
    });
    const own = await completedFee('2027-03-05', operator);
    const read = await t.http.get(`/v1/fee-submissions/${own.feeId}`).set(operator.header);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const mine = await t.http
      .get(`/v1/fee-submissions?personId=${operator.personId}`)
      .set(operator.header);
    expect(mine.body.items.map((f: { id: string }) => f.id)).toEqual([own.feeId]);
    // and never decides it (no finance authority at that facility, and never over their own fee)
    expect((await post(t, `/v1/fee-submissions/${own.feeId}/approve`, operator, {})).status).toBe(
      403,
    );
  });
});

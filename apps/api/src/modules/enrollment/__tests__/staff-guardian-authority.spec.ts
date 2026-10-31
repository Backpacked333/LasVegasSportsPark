import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture, createPolicyVersionFixture } from '../../catalog';
import {
  acknowledge,
  adult,
  basketWith,
  child,
  enrollmentTestApp,
  offering,
  post,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

/**
 * R3-TRACE-A-02 (§2.1, SPK-IAM-001/003, SPK-REG-007/008/009/010, SPK-YOUTH-003): a staff member who
 * is also a parent acts for their own child through the `register` grant, and is a customer for
 * that command. Staff-only branches (a waitlist priority, skipping a required approval, recording
 * attendance, naming another payer, the staff-assisted record) follow a staff role that holds the
 * action at the offering's facility, never the principal's kind.
 */
describe('R3-TRACE-A-02: a staff member acting as a guardian has only a guardian’s authority', () => {
  let t: TestApp;
  let frontDesk: Actor;
  let programManager: Actor;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    frontDesk = await staff(t, ['front_desk']);
    programManager = await staff(t, ['program_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  /** A one-seat offering whose seat another family holds, so everyone else waits. */
  async function fullOffering(): Promise<OfferingSetup> {
    const setup = await offering(t, { capacityUnits: [{ unit: 'seats', limit: 1 }] });
    const holder = await adult(t);
    const holderKid = await child(t, [holder]);
    await acknowledge(t, setup, holderKid, holder.personId);
    const held = await basketWith(t, holder, [
      { participantPersonId: holderKid, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${held.id}/hold`, holder.header, {})).status).toBe(200);
    return setup;
  }

  async function kidOf(guardian: Actor, setup: OfferingSetup): Promise<string> {
    const kid = await child(t, [guardian]);
    await acknowledge(t, setup, kid, guardian.personId);
    return kid;
  }

  const entryRow = (id: string) =>
    t.db
      .selectFrom('waitlist_entries')
      .select([
        'priority_rank',
        'priority_basis',
        'payer_person_id',
        'requested_by',
        'requested_by_person_id',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('SPK-REG-008: a scheduler or coach joining for their own child cannot set a waitlist priority, so no family is queue-jumped', async () => {
    const setup = await fullOffering();
    const family = await adult(t);
    const familyKid = await kidOf(family, setup);
    const waiting = await post(t, '/v1/waitlist-entries', family.header, {
      offeringId: setup.offeringId,
      participantPersonId: familyKid,
      intent: 'youth',
    });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(201);
    expect(waiting.body.position).toBe(1);

    for (const roles of [['scheduler'], ['coach']] as const) {
      const parent = await staff(t, [...roles]);
      const kid = await kidOf(parent, setup);
      const jumped = await post(t, '/v1/waitlist-entries', parent.header, {
        offeringId: setup.offeringId,
        participantPersonId: kid,
        intent: 'youth',
        priorityBasis: 'manual',
        priorityRank: 0,
      });
      expect(jumped.status, JSON.stringify(jumped.body)).toBe(403);
      expect(jumped.body.code).toBe('ACCESS_DENIED');
    }

    // Joining as the family does is fine: the default basis and rank, behind the family already
    // waiting; the registrant is recorded as the customer they acted as, never staff-assisted.
    const scheduler = await staff(t, ['scheduler']);
    const schedulerKid = await kidOf(scheduler, setup);
    const stranger = await adult(t);
    const foreignPayer = await post(t, '/v1/waitlist-entries', scheduler.header, {
      offeringId: setup.offeringId,
      participantPersonId: schedulerKid,
      intent: 'youth',
      payerPersonId: stranger.personId,
    });
    expect(foreignPayer.status).toBe(403);
    expect(foreignPayer.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    const joined = await post(t, '/v1/waitlist-entries', scheduler.header, {
      offeringId: setup.offeringId,
      participantPersonId: schedulerKid,
      intent: 'youth',
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    expect(joined.body.position).toBe(2);
    const stored = await entryRow(joined.body.id as string);
    expect(stored).toMatchObject({
      priority_rank: 100,
      priority_basis: 'joined_at',
      payer_person_id: scheduler.personId,
      requested_by_person_id: scheduler.personId,
    });
    expect(stored.requested_by).toMatchObject({ kind: 'customer', staffRoles: [] });
    const family1 = await t.http
      .get(`/v1/waitlist-entries/${waiting.body.id as string}`)
      .set(family.header);
    expect(family1.body.position).toBe(1);

    // Front desk joins families to the queue but does not adjust priority (manage_waitlist).
    const deskKid = await kidOf(family, setup);
    const byDesk = await post(t, '/v1/waitlist-entries', frontDesk.header, {
      offeringId: setup.offeringId,
      participantPersonId: deskKid,
      intent: 'youth',
      payerPersonId: family.personId,
      priorityRank: 0,
    });
    expect(byDesk.status).toBe(403);

    // Program administration, acting on its role, does set it.
    const other = await adult(t);
    const otherKid = await kidOf(other, setup);
    const prioritized = await post(t, '/v1/waitlist-entries', programManager.header, {
      offeringId: setup.offeringId,
      participantPersonId: otherKid,
      intent: 'youth',
      payerPersonId: other.personId,
      priorityBasis: 'manual',
      priorityRank: 0,
    });
    expect(prioritized.status, JSON.stringify(prioritized.body)).toBe(201);
    expect(prioritized.body.position).toBe(1);
    expect(await entryRow(prioritized.body.id as string)).toMatchObject({
      priority_rank: 0,
      priority_basis: 'manual',
    });
  });

  it('SPK-REG-007 / SPK-REG-010: a scheduler transferring their own child into an offering that requires approval is refused; desk staff may', async () => {
    const approval = await createPolicyVersionFixture(t, {
      kind: 'eligibility',
      content: { requiresApproval: true },
    });
    const from = await offering(t, { basePriceMinor: 0 });
    const to = await offering(t, {
      basePriceMinor: 0,
      startsOn: '2027-02-01',
      endsOn: '2027-04-30',
      eligibilityPolicyVersionId: approval,
    });
    const scheduler = await staff(t, ['scheduler']);
    const enrolled = async () => {
      const kid = await child(t, [scheduler]);
      await acknowledge(t, from, kid, scheduler.personId);
      await acknowledge(t, to, kid, scheduler.personId);
      const basket = await basketWith(t, scheduler, [
        { participantPersonId: kid, offeringId: from.offeringId },
      ]);
      expect((await post(t, `/v1/baskets/${basket.id}/hold`, scheduler.header, {})).status).toBe(
        200,
      );
      const done = await post(t, `/v1/baskets/${basket.id}/complete`, scheduler.header, {});
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const enrollmentId = done.body.lines[0].enrollmentId as string;
      // Registered through the family's own authority: no staff-assisted record.
      const row = await t.db
        .selectFrom('enrollments')
        .select(['revision', 'assisted_by_person_id', 'registered_by'])
        .where('id', '=', enrollmentId)
        .executeTakeFirstOrThrow();
      expect(row.assisted_by_person_id).toBeNull();
      expect(row.registered_by).toMatchObject({ kind: 'customer' });
      return { enrollmentId, revision: row.revision };
    };

    const own = await enrolled();
    const preview = await post(
      t,
      `/v1/enrollments/${own.enrollmentId}/transfer`,
      scheduler.header,
      {
        targetOfferingId: to.offeringId,
        expectedRevision: own.revision,
      },
    );
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.requiredApproval).toBe(true);
    const refused = await post(
      t,
      `/v1/enrollments/${own.enrollmentId}/transfer`,
      scheduler.header,
      {
        targetOfferingId: to.offeringId,
        expectedRevision: own.revision,
        commit: true,
      },
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details.code).toBe('APPROVAL_REQUIRED');
    expect(
      (
        await t.db
          .selectFrom('enrollments')
          .select('status')
          .where('id', '=', own.enrollmentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('confirmed');

    // Registration staff acting on their role commit the transfer (it is the human decision).
    const assisted = await post(
      t,
      `/v1/enrollments/${own.enrollmentId}/transfer`,
      frontDesk.header,
      {
        targetOfferingId: to.offeringId,
        expectedRevision: own.revision,
        commit: true,
      },
    );
    expect(assisted.status, JSON.stringify(assisted.body)).toBe(200);
    expect(assisted.body.newEnrollment).toMatchObject({ status: 'confirmed' });
  });

  it('SPK-AT-004: a coach who is the other guardian reads the child’s registration with the payer hidden, as any guardian does', async () => {
    const free = await offering(t, { basePriceMinor: 0 });
    const payer = await adult(t);
    const coach = await staff(t, ['coach']);
    const kid = await child(t, [payer, coach]);
    await acknowledge(t, free, kid, payer.personId);
    const basket = await basketWith(t, payer, [
      { participantPersonId: kid, offeringId: free.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${basket.id}/hold`, payer.header, {})).status).toBe(200);
    const done = await post(t, `/v1/baskets/${basket.id}/complete`, payer.header, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const enrollmentId = done.body.lines[0].enrollmentId as string;

    const byCoach = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(coach.header);
    expect(byCoach.status).toBe(200);
    expect(byCoach.body).toMatchObject({ payerPersonId: null, basketId: null, orderRef: null });
    expect(byCoach.body.registeredBy.personId).toBeNull();
    expect(JSON.stringify(byCoach.body)).not.toContain(payer.personId);
    const listed = await t.http.get(`/v1/enrollments?participantPersonId=${kid}`).set(coach.header);
    expect(listed.status).toBe(200);
    expect(listed.body.items[0].payerPersonId).toBeNull();

    // A staff reader acting on their role sees the record whole.
    const byDesk = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(frontDesk.header);
    expect(byDesk.body.payerPersonId).toBe(payer.personId);
  });

  it('SPK-YOUTH-003: a scheduler or coach cannot record their own child’s trial attendance; staff on their role can', async () => {
    const trial = await offering(t, { kind: 'trial', basePriceMinor: 0 });
    const start = new Date(t.clock.now().getTime() + 60 * 60_000);
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: trial.offeringId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 60 * 60_000),
    });
    const booked: Array<{ parent: Actor; id: string }> = [];
    for (const roles of [['scheduler'], ['coach']] as const) {
      const parent = await staff(t, [...roles]);
      const kid = await child(t, [parent]);
      await acknowledge(t, trial, kid, parent.personId);
      const created = await post(t, '/v1/trial-participations', parent.header, {
        offeringId: trial.offeringId,
        participantPersonId: kid,
        sessionId,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      // Booked as the family: not staff-assisted.
      expect(created.body.assistedByPersonId).toBeNull();
      expect(created.body.registeredBy).toMatchObject({ kind: 'customer' });
      booked.push({ parent, id: created.body.id as string });
    }
    t.clock.advance(90 * 60_000);
    for (const { parent, id } of booked) {
      for (const outcome of ['attended', 'no_show'] as const) {
        const recorded = await post(t, `/v1/trial-participations/${id}/outcome`, parent.header, {
          outcome,
          expectedRevision: 1,
        });
        expect(recorded.status, JSON.stringify(recorded.body)).toBe(403);
        expect(recorded.body.code).toBe('ACCESS_DENIED');
      }
      const observed = await post(t, `/v1/trial-participations/${id}/outcome`, frontDesk.header, {
        outcome: 'attended',
        expectedRevision: 1,
      });
      expect(observed.status, JSON.stringify(observed.body)).toBe(200);
      expect(observed.body.status).toBe('attended');
    }
  });
});

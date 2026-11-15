import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingSessionFixture,
  createPriceRuleTierFixture,
} from '../../catalog';
import { createEnrollmentFixture } from '../../enrollment';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import {
  entryTestApp,
  family,
  post,
  program,
  sessionRef,
  staffMember,
  type Actor,
  type Family,
  type Program,
} from './support';

const DAY = 24 * 3_600_000;

interface Issue {
  code: string;
  severity: string;
  message: string;
  nextAction: string;
  reference: { type: string; id: string } | null;
}

/**
 * Arrival for a participant who chose days (SPK-PAY-014, proposed amendment PA-03; quality review
 * M-1): an enrollment is a participation basis for the sessions it attends and no others. The
 * tier and its days are test data.
 */
describe('arrival follows the days a participant chose (SPK-PAY-014, proposed)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let fam: Family;
  let p: Program;
  let tomorrow: string;
  let dayAfter: string;
  let tierId: string;

  /** A child of the family with a recorded arrival and the form acknowledged. */
  const arrived = async (): Promise<string> => {
    const child = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: fam.guardian.personId,
      subjectPersonId: child,
    });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: child,
      policyVersionId: p.offering.formPolicyVersionId,
      signedByPersonId: fam.guardian.personId,
    });
    const arrival = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: child, visitorCategory: 'participant' }],
    });
    expect(arrival.status, JSON.stringify(arrival.body)).toBe(201);
    return child;
  };
  const registeredFor = (child: string, selectedSessionIds: string[] | null) =>
    createEnrollmentFixture(t, {
      offeringId: p.offering.offeringId,
      participantPersonId: child,
      priceTierId: selectedSessionIds ? tierId : null,
      selectedSessionIds,
    });
  const checkIn = async (personId: string) => {
    const res = await post(t, '/v1/session-checkins', desk, {
      personId,
      activity: sessionRef(p),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { status: string; issues: Issue[]; basis: unknown };
  };

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    fam = await family(t, desk);
    // Three days of a camp: today (the session being checked in to) and the next two.
    p = await program(t, manager);
    const later = (days: number) =>
      createOfferingSessionFixture(t, {
        offeringId: p.offering.offeringId,
        scheduledStart: new Date(Date.parse(p.start) + days * DAY),
        scheduledEnd: new Date(Date.parse(p.end) + days * DAY),
      });
    tomorrow = await later(1);
    dayAfter = await later(2);
    const rule = await t.db
      .selectFrom('price_rules')
      .select('id')
      .where('offering_id', '=', p.offering.offeringId)
      .executeTakeFirstOrThrow();
    tierId = await createPriceRuleTierFixture(t, {
      priceRuleId: rule.id,
      offeringId: p.offering.offeringId,
      code: 'by_the_day',
      name: 'By the day',
      attendance: 'chosen_sessions',
      minSessions: 1,
      maxSessions: 3,
      priceMinor: 7_000,
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-014 (QA M-1): a child registered for other days is not an expected arrival today: the check-in is held with the days they are registered for; a child registered for today, or without a day selection, is admitted', async () => {
    const otherDays = await arrived();
    const enrollmentId = await registeredFor(otherDays, [tomorrow, dayAfter]);
    const facility = await t.db
      .selectFrom('facilities')
      .select('timezone')
      .where('id', '=', t.facilityId)
      .executeTakeFirstOrThrow();
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: facility.timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const days = [1, 2].map((n) => local.format(new Date(Date.parse(p.start) + n * DAY)));

    const held = await checkIn(otherDays);
    expect(held.status).toBe('held');
    expect(held.basis).toBeNull();
    expect(held.issues.filter((i) => i.severity === 'blocking')).toEqual([
      {
        code: 'not_registered_for_session',
        severity: 'blocking',
        message: `Not registered for today. This participant is registered for ${days.join(', ')}.`,
        nextAction: 'register_or_book',
        reference: { type: 'enrollment', id: enrollmentId },
      },
    ]);

    const today = await arrived();
    const todayEnrollment = await registeredFor(today, [p.sessionId, dayAfter]);
    const admitted = await checkIn(today);
    expect(admitted.status).toBe('admitted');
    expect(admitted.basis).toMatchObject({ kind: 'enrollment', id: todayEnrollment });

    // Every enrollment without a day selection attends every session, as before.
    const everyDay = await arrived();
    await registeredFor(everyDay, null);
    expect((await checkIn(everyDay)).status).toBe('admitted');
  });

  it('SPK-PAY-014 (QA M-1): a pass scan offers a family member only the sessions their enrollment attends today', async () => {
    const issued = await post(t, '/v1/passes', desk, {
      holder: { kind: 'household', householdId: fam.householdId },
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    await createEnrollmentFixture(t, {
      offeringId: p.offering.offeringId,
      participantPersonId: fam.childA,
      priceTierId: tierId,
      selectedSessionIds: [tomorrow],
    });
    await createEnrollmentFixture(t, {
      offeringId: p.offering.offeringId,
      participantPersonId: fam.childB,
      priceTierId: tierId,
      selectedSessionIds: [p.sessionId],
    });
    const scan = await post(t, '/v1/passes/scan', desk, {
      reference: issued.body.reference,
      facilityId: t.facilityId,
    });
    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
    const activitiesOf = (personId: string) =>
      (
        (
          scan.body.people as Array<{
            personId: string;
            activities: Array<{ activity: { id: string } }>;
          }>
        ).find((person) => person.personId === personId)?.activities ?? []
      ).map((a) => a.activity.id);
    // Ava is registered for tomorrow: nothing is offered today. Ben is registered for today.
    expect(activitiesOf(fam.childA)).toEqual([]);
    expect(activitiesOf(fam.childB)).toEqual([p.sessionId]);
  });
});

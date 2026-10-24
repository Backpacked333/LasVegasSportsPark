import { newId } from '@sportspark/contracts';
import { json, pgConstraintName, seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture } from '../../catalog';
import { createSeasonFixture, createTeamEntryFixture } from '../../competition';
import { createPersonFixture } from '../../identity';
import {
  createCapacityPoolFixture,
  createEnrollmentFixture,
  createHoldFixture,
  createMakeupEntitlementFixture,
  createSessionBookingFixture,
} from '../testing/enrollment-fixtures';
import {
  enrollmentTestApp,
  isRestrictViolation,
  offering,
  rejectsWith,
  type OfferingSetup,
} from './support';

const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';

describe('enrollment schema invariants (§4.7 invariants 2, 3, 7; §4.6 machines; SPK-AT-004/005/020)', () => {
  let t: TestApp;
  let setup: OfferingSetup;
  let person: string;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    setup = await offering(t);
    person = await createPersonFixture(t, { kind: 'child' });
  });
  afterAll(async () => {
    await t.close();
  });

  const ACTOR = json({ kind: 'system', actorLabel: 'test' });

  it('SPK-AT-004 / §4.7 invariant 2: the database refuses a second equivalent active entitlement', async () => {
    const equivalenceKey = `seat|offering:${setup.offeringId}|person:${person}`;
    await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: person,
      status: 'pending',
      equivalenceKey,
    });
    expect(
      await rejectsWith(
        createEnrollmentFixture(t, {
          offeringId: setup.offeringId,
          participantPersonId: person,
          status: 'confirmed',
          equivalenceKey,
        }),
      ),
    ).toBe(UNIQUE);
    // A canceled entitlement is history, not an active duplicate; a null key permits duplicates.
    await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: person,
      status: 'canceled',
      equivalenceKey,
    });
    await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: person,
      status: 'confirmed',
      equivalenceKey: null,
    });
    await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: person,
      status: 'confirmed',
      equivalenceKey: null,
    });
  });

  it('SPK-AT-004: one open application per participant and offering, whichever adult submits it', async () => {
    const kid = await createPersonFixture(t, { kind: 'child' });
    const insert = () =>
      t.db
        .insertInto('applications')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          offering_id: setup.offeringId,
          participant_person_id: kid,
          intent: 'youth',
          submitted_by: ACTOR,
          submitted_by_person_id: null,
          payer_person_id: null,
          status: 'submitted',
          override: null,
          team_entry_id: null,
          session_id: null,
          notes: null,
          submitted_at: t.clock.now(),
          decided_at: null,
          decided_by: null,
          decided_by_person_id: null,
          decision_reason: null,
          withdrawn_at: null,
        })
        .execute();
    await insert();
    expect(await rejectsWith(insert())).toBe(UNIQUE);
  });

  it('§4.7 invariant 3: committed plus held can never exceed capacity, and counters never go negative', async () => {
    const poolId = await createCapacityPoolFixture(t, {
      offeringId: setup.offeringId,
      scopeType: 'session',
      scopeId: newId(),
      unit: 'session_seats',
      capacity: 2,
    });
    await createHoldFixture(t, { poolId, quantity: 2 });
    expect(await rejectsWith(createHoldFixture(t, { poolId }))).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db.updateTable('capacity_pools').set({ committed: 1 }).where('id', '=', poolId).execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db.updateTable('capacity_pools').set({ held: -1 }).where('id', '=', poolId).execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db.updateTable('capacity_pools').set({ capacity: 1 }).where('id', '=', poolId).execute(),
      ),
    ).toBe(CHECK);
    // One pool per scope, unit and constraint.
    const scopeId = newId();
    await createCapacityPoolFixture(t, {
      offeringId: setup.offeringId,
      scopeType: 'session',
      scopeId,
      unit: 'session_seats',
      capacity: 1,
    });
    expect(
      await rejectsWith(
        createCapacityPoolFixture(t, {
          offeringId: setup.offeringId,
          scopeType: 'session',
          scopeId,
          unit: 'session_seats',
          capacity: 5,
        }),
      ),
    ).toBe(UNIQUE);
  });

  it('SPK-REG-006: a hold has exactly one terminal outcome', async () => {
    const poolId = await createCapacityPoolFixture(t, {
      offeringId: setup.offeringId,
      scopeType: 'session',
      scopeId: newId(),
      unit: 'session_seats',
      capacity: 5,
    });
    const holdId = await createHoldFixture(t, { poolId });
    // Status and fact must agree.
    expect(
      await rejectsWith(
        t.db.updateTable('holds').set({ status: 'committed' }).where('id', '=', holdId).execute(),
      ),
    ).toBe(CHECK);
    await t.db
      .updateTable('holds')
      .set({ status: 'expired', expired_at: t.clock.now() })
      .where('id', '=', holdId)
      .execute();
    expect(
      await rejectsWith(
        t.db
          .updateTable('holds')
          .set({ status: 'committed', committed_at: t.clock.now(), expired_at: null })
          .where('id', '=', holdId)
          .execute(),
      ),
    ).toBe(CHECK);
    // Pool and quantity are fixed at acquisition, even while active.
    const other = await createHoldFixture(t, { poolId });
    expect(
      await rejectsWith(
        t.db.updateTable('holds').set({ quantity: 3 }).where('id', '=', other).execute(),
      ),
    ).toBe(CHECK);
  });

  it('SPK-REG-008: a waitlist offer is consumed once', async () => {
    const poolId = await createCapacityPoolFixture(t, {
      offeringId: setup.offeringId,
      scopeType: 'session',
      scopeId: newId(),
      unit: 'session_seats',
      capacity: 5,
    });
    const holdId = await createHoldFixture(t, { poolId, ownerKind: 'waitlist_offer' });
    const entryId = newId();
    const now = t.clock.now();
    await t.db
      .insertInto('waitlist_entries')
      .values({
        id: entryId,
        organization_id: t.organizationId,
        offering_id: setup.offeringId,
        pool_id: poolId,
        session_id: null,
        participant_person_id: person,
        intent: 'youth',
        joined_at: now,
        queued_at: now,
        requested_by: ACTOR,
        requested_by_person_id: null,
        payer_person_id: null,
        accepted_enrollment_id: null,
        withdrawn_at: null,
        removed_at: null,
        removal_reason: null,
      })
      .execute();
    const offerId = newId();
    await t.db
      .insertInto('waitlist_offers')
      .values({
        id: offerId,
        organization_id: t.organizationId,
        waitlist_entry_id: entryId,
        pool_id: poolId,
        hold_id: holdId,
        quantity: 1,
        offered_at: now,
        expires_at: new Date(now.getTime() + 60_000),
        accepted_at: null,
        accepted_basket_id: null,
        accepted_enrollment_id: null,
        accepted_session_booking_id: null,
        declined_at: null,
        expired_at: null,
      })
      .execute();
    await t.db
      .updateTable('waitlist_offers')
      .set({ status: 'accepted', accepted_at: now })
      .where('id', '=', offerId)
      .execute();
    expect(
      await rejectsWith(
        t.db
          .updateTable('waitlist_offers')
          .set({ status: 'offered', accepted_at: null })
          .where('id', '=', offerId)
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .updateTable('waitlist_offers')
          .set({ status: 'expired', accepted_at: null, expired_at: now })
          .where('id', '=', offerId)
          .execute(),
      ),
    ).toBe(CHECK);
    // One open offer per entry.
    const second = await createHoldFixture(t, { poolId, ownerKind: 'waitlist_offer' });
    const third = await createHoldFixture(t, { poolId, ownerKind: 'waitlist_offer' });
    const insertOffer = (hold: string) =>
      t.db
        .insertInto('waitlist_offers')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          waitlist_entry_id: entryId,
          pool_id: poolId,
          hold_id: hold,
          quantity: 1,
          offered_at: now,
          expires_at: new Date(now.getTime() + 60_000),
          accepted_at: null,
          accepted_basket_id: null,
          accepted_enrollment_id: null,
          accepted_session_booking_id: null,
          declined_at: null,
          expired_at: null,
        })
        .execute();
    await insertOffer(second);
    expect(await rejectsWith(insertOffer(third))).toBe(UNIQUE);
  });

  it('§4.6 / §4.5: the enrollment lifecycle is the canonical machine and never mixes in waitlisting', async () => {
    const id = await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: person,
      status: 'pending',
    });
    expect(
      await rejectsWith(
        t.db
          .updateTable('enrollments')
          .set({ status: 'completed', confirmed_at: t.clock.now(), completed_at: t.clock.now() })
          .where('id', '=', id)
          .execute(),
      ),
    ).toBe(CHECK);
    await t.db
      .updateTable('enrollments')
      .set({ status: 'canceled', canceled_at: t.clock.now() })
      .where('id', '=', id)
      .execute();
    expect(
      await rejectsWith(
        t.db
          .updateTable('enrollments')
          .set({ status: 'confirmed', confirmed_at: t.clock.now(), canceled_at: null })
          .where('id', '=', id)
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        sql`update enrollments set status = 'waitlisted' where id = ${id}`.execute(t.db),
      ),
    ).toBe(CHECK);
  });

  it('SPK-AT-020 / §4.7 invariant 7: the database refuses a redemption beyond the limit; history is append-only', async () => {
    const makeupId = await createMakeupEntitlementFixture(t, {
      participantPersonId: person,
      eligibleOfferingIds: [setup.offeringId],
      redemptionLimit: 1,
    });
    const sessionA = await createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date('2026-12-01T17:00:00Z'),
      scheduledEnd: new Date('2026-12-01T18:00:00Z'),
    });
    const sessionB = await createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date('2026-12-08T17:00:00Z'),
      scheduledEnd: new Date('2026-12-08T18:00:00Z'),
    });
    const booking = (sessionId: string) =>
      createSessionBookingFixture(t, {
        offeringId: setup.offeringId,
        sessionId,
        participantPersonId: person,
        kind: 'makeup',
        scheduledStart: new Date('2026-12-01T17:00:00Z'),
        scheduledEnd: new Date('2026-12-01T18:00:00Z'),
      });
    const redeem = (
      bookingId: string,
      kind: 'redeem' | 'reversal' = 'redeem',
      reverses: string | null = null,
    ) => {
      const id = newId();
      return t.db
        .insertInto('makeup_redemptions')
        .values({
          id,
          organization_id: t.organizationId,
          makeup_entitlement_id: makeupId,
          session_booking_id: bookingId,
          participant_person_id: person,
          kind,
          reverses_redemption_id: reverses,
          actor: ACTOR,
          redeemed_at: t.clock.now(),
        })
        .execute()
        .then(() => id);
    };
    const first = await booking(sessionA);
    const redemption = await redeem(first);
    const after = await t.db
      .selectFrom('makeup_entitlements')
      .selectAll()
      .where('id', '=', makeupId)
      .executeTakeFirstOrThrow();
    expect(after).toMatchObject({ redeemed_count: 1, status: 'exhausted' });
    const second = await booking(sessionB);
    expect(await rejectsWith(redeem(second))).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .updateTable('makeup_entitlements')
          .set({ redeemed_count: 2 })
          .where('id', '=', makeupId)
          .execute(),
      ),
    ).toBe(CHECK);
    // The same booking can never consume twice.
    expect(await rejectsWith(redeem(first))).toBe(UNIQUE);
    // Corrections are new rows: a reversal gives the redemption back; the history never changes.
    await redeem(first, 'reversal', redemption);
    expect(
      await t.db
        .selectFrom('makeup_entitlements')
        .select(['redeemed_count', 'status'])
        .where('id', '=', makeupId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ redeemed_count: 0, status: 'active' });
    // A reversal must correct a redemption of the same entitlement and booking: reversing the
    // second booking's redemption from a third booking would hand out a free redemption.
    const redemption2 = await redeem(second);
    const sessionC = await createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date('2026-12-29T17:00:00Z'),
      scheduledEnd: new Date('2026-12-29T18:00:00Z'),
    });
    const third = await booking(sessionC);
    expect(await rejectsWith(redeem(third, 'reversal', redemption2))).toBe(CHECK);
    let error: unknown;
    try {
      await t.db.deleteFrom('makeup_redemptions').where('id', '=', redemption).execute();
    } catch (e) {
      error = e;
    }
    expect(isRestrictViolation(error)).toBe(true);
    // An expired or another participant's entitlement is refused by the trigger as well.
    const otherPerson = await createPersonFixture(t, { kind: 'child' });
    const otherBooking = await createSessionBookingFixture(t, {
      offeringId: setup.offeringId,
      sessionId: sessionB,
      participantPersonId: otherPerson,
      kind: 'makeup',
      scheduledStart: new Date('2026-12-08T17:00:00Z'),
      scheduledEnd: new Date('2026-12-08T18:00:00Z'),
    });
    expect(
      await rejectsWith(
        t.db
          .insertInto('makeup_redemptions')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            makeup_entitlement_id: makeupId,
            session_booking_id: otherBooking,
            participant_person_id: otherPerson,
            kind: 'redeem',
            reverses_redemption_id: null,
            actor: ACTOR,
            redeemed_at: t.clock.now(),
          })
          .execute(),
      ),
    ).toBe(CHECK);
  });

  it('§4.3: composite keys keep every reference inside its organization', async () => {
    const other = await seedOrganization(t.db);
    const foreignPerson = await createPersonFixture(t, {
      kind: 'child',
      organizationId: other.organizationId,
    });
    expect(
      await rejectsWith(
        createEnrollmentFixture(t, {
          offeringId: setup.offeringId,
          participantPersonId: foreignPerson,
        }),
      ),
    ).toBe(FOREIGN_KEY);
    expect(
      await rejectsWith(
        createEnrollmentFixture(t, {
          offeringId: setup.offeringId,
          participantPersonId: foreignPerson,
          organizationId: other.organizationId,
        }),
      ),
    ).toBe(FOREIGN_KEY);
  });

  it('SPK-PLACE-004 / SPK-YOUTH-003: one live booking per session and one scheduled trial per offering', async () => {
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date('2026-12-15T17:00:00Z'),
      scheduledEnd: new Date('2026-12-15T18:00:00Z'),
    });
    const book = () =>
      createSessionBookingFixture(t, {
        offeringId: setup.offeringId,
        sessionId,
        participantPersonId: person,
        scheduledStart: new Date('2026-12-15T17:00:00Z'),
        scheduledEnd: new Date('2026-12-15T18:00:00Z'),
      });
    await book();
    expect(await rejectsWith(book())).toBe(UNIQUE);
    const trial = () =>
      t.db
        .insertInto('trial_participations')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          offering_id: setup.offeringId,
          session_id: null,
          session_booking_id: null,
          participant_person_id: person,
          application_id: null,
          scheduled_for: null,
          attended_at: null,
          canceled_at: null,
          cancel_reason: null,
          converted_enrollment_id: null,
          converted_basket_id: null,
          converted_at: null,
          registered_by: ACTOR,
          registered_by_person_id: null,
          assisted_by_person_id: null,
        })
        .execute();
    await trial();
    expect(await rejectsWith(trial())).toBe(UNIQUE);
  });

  it('§4.6: the database refuses session booking, application and placement transitions their machines do not allow', async () => {
    const constraintOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
      try {
        await promise;
      } catch (error) {
        return pgConstraintName(error);
      }
      throw new Error('expected the database to reject the statement');
    };
    // SessionBookingMachine: canceled is final (facts consistent, so only the machine refuses).
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date('2026-12-22T17:00:00Z'),
      scheduledEnd: new Date('2026-12-22T18:00:00Z'),
    });
    const bookingId = await createSessionBookingFixture(t, {
      offeringId: setup.offeringId,
      sessionId,
      participantPersonId: person,
      status: 'canceled',
      scheduledStart: new Date('2026-12-22T17:00:00Z'),
      scheduledEnd: new Date('2026-12-22T18:00:00Z'),
    });
    expect(
      await constraintOf(
        t.db
          .updateTable('session_bookings')
          .set({ status: 'confirmed', confirmed_at: t.clock.now(), canceled_at: null })
          .where('id', '=', bookingId)
          .execute(),
      ),
    ).toBe('session_bookings_machine');

    // ApplicationMachine: a declined application is never accepted afterwards.
    const applicationId = newId();
    await t.db
      .insertInto('applications')
      .values({
        id: applicationId,
        organization_id: t.organizationId,
        offering_id: setup.offeringId,
        participant_person_id: person,
        intent: 'youth',
        submitted_by: ACTOR,
        submitted_by_person_id: null,
        payer_person_id: null,
        status: 'declined',
        override: null,
        team_entry_id: null,
        session_id: null,
        notes: null,
        submitted_at: t.clock.now(),
        decided_at: t.clock.now(),
        decided_by: ACTOR,
        decided_by_person_id: null,
        decision_reason: 'test',
        withdrawn_at: null,
      })
      .execute();
    expect(
      await constraintOf(
        t.db
          .updateTable('applications')
          .set({ status: 'accepted' })
          .where('id', '=', applicationId)
          .execute(),
      ),
    ).toBe('applications_machine');

    // PlacementMachine: an unassigned request is never released without an assignment, and a
    // released request never comes back.
    const { seasonId } = await createSeasonFixture(t);
    const { teamEntryId } = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: await createPersonFixture(t, { kind: 'adult' }),
      teamName: 'Guard test',
    });
    const placementId = newId();
    await t.db
      .insertInto('placement_requests')
      .values({
        id: placementId,
        organization_id: t.organizationId,
        participant_person_id: person,
        application_id: null,
        enrollment_id: null,
        offering_id: null,
        season_id: seasonId,
        preferred_competition_id: null,
        preferred_division_id: null,
        declared_level: null,
        notes: null,
        requested_by: ACTOR,
        requested_by_person_id: null,
        proposed_team_entry_id: null,
        proposed_at: null,
        proposed_by: null,
        assigned_team_entry_id: teamEntryId,
        assigned_at: t.clock.now(),
        decided_by: null,
        decided_by_person_id: null,
        roster_membership_ref: null,
        last_operation_id: null,
        released_at: null,
        release_reason: null,
      })
      .execute();
    expect(
      await constraintOf(
        t.db
          .updateTable('placement_requests')
          .set({ status: 'released', released_at: t.clock.now(), release_reason: 'test' })
          .where('id', '=', placementId)
          .execute(),
      ),
    ).toBe('placement_requests_machine');
    await t.db
      .updateTable('placement_requests')
      .set({ status: 'assigned' })
      .where('id', '=', placementId)
      .execute();
    await t.db
      .updateTable('placement_requests')
      .set({ status: 'released', released_at: t.clock.now(), release_reason: 'test' })
      .where('id', '=', placementId)
      .execute();
    expect(
      await constraintOf(
        t.db
          .updateTable('placement_requests')
          .set({ status: 'assigned', released_at: null })
          .where('id', '=', placementId)
          .execute(),
      ),
    ).toBe('placement_requests_machine');
  });
});

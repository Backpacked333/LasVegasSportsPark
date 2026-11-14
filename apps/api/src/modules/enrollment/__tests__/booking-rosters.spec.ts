import { newId, type PolicyVersion } from '@sportspark/contracts';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  json,
  seedOrganization,
} from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  POLICY_PORT,
  createAcknowledgmentFixture,
  createPolicyVersionFixture,
  fixtureWaiverContent,
  requireWaiverFixture,
  type PolicyPort,
} from '../../catalog';
import { authHeaderForPerson, createAccountFixture, createPersonFixture } from '../../identity';
import { seedResource } from '../../scheduling';
import { ENROLLMENT_PORT, type EnrollmentPort } from '../enrollment.ports';
import { definitionWithScope } from './package-g-support';
import { useBookingTerms } from './stage3-doubles';
import {
  acknowledge,
  adult,
  child,
  drain,
  enrollmentTestApp,
  offering,
  post,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LONG_AGO = new Date('2026-01-01T00:00:00Z');

interface Member {
  id: string;
  personId: string | null;
  displayName: string | null;
  invitedContact: { kind: string; value: string } | null;
  status: string;
  waiverStatus: string;
  invitation: { id: string; status: string } | null;
  revision: number;
}

/**
 * Rental-group rosters (SPK-COND-005, proposed amendment PA-09; capability `rental_rosters`,
 * DEC-103), with the liability waiver of SPK-REG-011 shown per member. Proposed default under
 * test: a missing waiver is shown and never blocks the booking.
 */
describe('rental-group rosters (SPK-COND-005, proposed amendment PA-09)', () => {
  let t: TestApp;
  let desk: Actor;
  let fields: string[];
  let next = 0;

  const start = (days: number, hourUtc = 18) =>
    new Date(Date.parse('2026-11-10T00:00:00Z') + days * DAY + hourUtc * HOUR);

  async function terms(): Promise<PolicyVersion> {
    const id = await createPolicyVersionFixture(t, {
      kind: 'refund',
      content: {
        confirmationMode: 'instant',
        installmentPolicyKey: null,
        accessConditions: null,
        hostResponsibilities: null,
      },
    });
    const version = await t.app.get<PolicyPort>(POLICY_PORT).getPolicyVersion(t.organizationId, id);
    return version!;
  }

  async function rentalOffering(): Promise<OfferingSetup> {
    const definitionId = await definitionWithScope(t, 'rental_resource', {
      resources: { resourceIds: fields, count: 1 },
      staffing: [],
    });
    const setup = await offering(t, {
      kind: 'rental',
      entitlementDefinitionId: definitionId,
      basePriceMinor: 0,
      ageBand: { minAgeYears: 18 },
    });
    useBookingTerms(setup.offeringId, await terms());
    return setup;
  }

  /** A live rental booking and its renter. Each booking takes its own day so none conflict. */
  async function rental(setup?: OfferingSetup, renterWaiverVersionId?: string) {
    const rentalSetup = setup ?? (await rentalOffering());
    const renter = await adult(t);
    await acknowledge(t, rentalSetup, renter.personId, renter.personId);
    if (renterWaiverVersionId) {
      // The renter is the booking's participant: a waiver that blocks is theirs to accept before
      // booking (SPK-REG-011). The roster's members are judged separately and never block.
      await createAcknowledgmentFixture(t, {
        subjectPersonId: renter.personId,
        policyVersionId: renterWaiverVersionId,
        signedByPersonId: renter.personId,
      });
    }
    next += 1;
    const booked = await post(t, '/v1/bookings', renter.header, {
      offeringId: rentalSetup.offeringId,
      start: start(next).toISOString(),
      end: new Date(start(next).getTime() + HOUR).toISOString(),
      resourceIds: [fields[0]],
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    return {
      setup: rentalSetup,
      renter,
      bookingId: booked.body.id as string,
      booking: booked.body,
    };
  }

  const rosterOf = async (actor: Actor, bookingId: string) => {
    const res = await t.http.get(`/v1/bookings/${bookingId}/roster`).set(actor.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      bookingId: string;
      waiver: { state: string; policyKeys: string[]; blocksBooking: boolean };
      members: Member[];
      counts: { joined: number; invited: number; waiverOutstanding: number };
    };
  };
  const add = (actor: Actor, bookingId: string, personId: string) =>
    post(t, `/v1/bookings/${bookingId}/roster`, actor.header, { personId });
  const invite = (actor: Actor, bookingId: string, body: Record<string, unknown>) =>
    post(t, `/v1/bookings/${bookingId}/roster/invitations`, actor.header, body);
  const accept = (actor: Actor, invitationId: string, body: Record<string, unknown> = {}) =>
    post(t, `/v1/booking-roster-invitations/${invitationId}/accept`, actor.header, body);
  const disabled = (response: { status: number; body: { details?: unknown } }) => {
    expect(response.status).toBe(403);
    expect(response.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'rental_rosters',
    });
  };

  beforeAll(async () => {
    t = await enrollmentTestApp({
      capabilities: [
        'pickup_sessions',
        'rentals',
        'parties',
        'rental_rosters',
        'liability_waivers',
      ],
    });
    desk = await staff(t, ['front_desk']);
    fields = [];
    for (let i = 0; i < 2; i += 1) {
      fields.push(
        (
          await seedResource(t.db, {
            organizationId: t.organizationId,
            facilityId: t.facilityId,
            name: `Rental field ${i + 1}`,
          })
        ).resourceId,
      );
    }
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-COND-005: the renter and staff add and invite people, each invited person joins for themselves or their child, staff and the renter see the roster, and being on it grants nothing else', async () => {
    const { renter, bookingId, booking } = await rental();
    const friend = await adult(t);
    const friendsChild = await child(t, [friend]);
    const walkIn = await adult(t);
    const stranger = await adult(t);
    const strangersChild = await child(t, [stranger]);

    // an empty roster to begin with
    expect((await rosterOf(renter, bookingId)).members).toEqual([]);

    // the renter adds themselves
    const self = await add(renter, bookingId, renter.personId);
    expect(self.status, JSON.stringify(self.body)).toBe(201);
    expect(self.body).toMatchObject({ personId: renter.personId, status: 'joined' });
    // ... but cannot put somebody else on the list without their say: they are invited
    const direct = await add(renter, bookingId, friend.personId);
    expect(direct.status).toBe(400);
    expect(direct.body.details).toMatchObject({ code: 'ROSTER_INVITATION_REQUIRED' });

    // an invitation to a known person: accepted by that person, signed in, for themselves
    const invited = await invite(renter, bookingId, {
      recipientPersonId: friend.personId,
      message: 'Thursday five-a-side',
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    expect(invited.body).toMatchObject({
      bookingId,
      recipientPersonId: friend.personId,
      status: 'pending',
      message: 'Thursday five-a-side',
    });
    expect(invited.body.token).toEqual(expect.any(String));
    // the token is never stored: only its hash
    const stored = await t.db
      .selectFrom('booking_roster_invitations')
      .select(['token_hash'])
      .where('id', '=', invited.body.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toContain(invited.body.token);
    const again = await invite(renter, bookingId, { recipientPersonId: friend.personId });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ code: 'ROSTER_MEMBER_EXISTS' });

    const mine = await t.http.get('/v1/me/booking-roster-invitations').set(friend.header);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({
      id: invited.body.id,
      status: 'pending',
      booking: { id: bookingId, firstStart: booking.firstStart, occurrenceCount: 1 },
      requiredWaiverKeys: [],
    });
    expect(mine.body[0].invitedByName).toEqual(expect.any(String));
    // nobody else can read or answer it
    expect(
      (await t.http.get(`/v1/booking-roster-invitations/${invited.body.id}`).set(stranger.header))
        .status,
    ).toBe(404);
    expect((await accept(stranger, invited.body.id)).status).toBe(404);
    // it names the friend: they join themselves, not somebody else in their place
    const forChild = await accept(friend, invited.body.id, { personId: friendsChild });
    expect(forChild.status).toBe(400);
    expect(forChild.body.details).toMatchObject({ code: 'ROSTER_INVITATION_NAMES_PERSON' });
    const joined = await accept(friend, invited.body.id);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body).toMatchObject({
      invitation: { status: 'accepted' },
      member: { personId: friend.personId, status: 'joined' },
    });
    expect((await accept(friend, invited.body.id)).status).toBe(409);
    // once on the roster, a member adds their own child (someone they may register)
    const kid = await add(friend, bookingId, friendsChild);
    expect(kid.status, JSON.stringify(kid.body)).toBe(201);
    expect(kid.body).toMatchObject({ personId: friendsChild, status: 'joined' });
    // ... and nobody else's
    expect((await add(friend, bookingId, strangersChild)).status).toBe(400);

    // an invitation to a contact with no record yet: whoever holds the token joins, for
    // themselves or for their child
    const byContact = await invite(renter, bookingId, {
      recipientContact: { kind: 'email', value: 'Guest@Example.test' },
    });
    expect(byContact.status, JSON.stringify(byContact.body)).toBe(201);
    expect(byContact.body.recipientContact).toEqual({ kind: 'email', value: 'guest@example.test' });
    expect((await accept(stranger, byContact.body.id)).status).toBe(404);
    expect(
      (await accept(stranger, byContact.body.id, { token: 'not-the-right-token' })).status,
    ).toBe(404);
    // the token does not let them join a child that is not theirs
    expect(
      (
        await accept(stranger, byContact.body.id, {
          token: byContact.body.token,
          personId: friendsChild,
        })
      ).status,
    ).toBe(404);
    const childJoined = await accept(stranger, byContact.body.id, {
      token: byContact.body.token,
      personId: strangersChild,
    });
    expect(childJoined.status, JSON.stringify(childJoined.body)).toBe(200);
    expect(childJoined.body.member).toMatchObject({
      personId: strangersChild,
      status: 'joined',
      invitedContact: null,
    });

    // staff at the facility add somebody standing at the desk
    const byStaff = await add(desk, bookingId, walkIn.personId);
    expect(byStaff.status, JSON.stringify(byStaff.body)).toBe(201);
    const duplicate = await add(desk, bookingId, walkIn.personId);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.details).toMatchObject({ code: 'ROSTER_MEMBER_EXISTS' });

    // the renter and staff see who is on the roster; nobody else does, not even a member
    const roster = await rosterOf(renter, bookingId);
    expect(roster.counts).toEqual({ joined: 5, invited: 0, waiverOutstanding: 0 });
    expect(roster.members.map((m) => [m.personId, m.status]).sort()).toEqual(
      [renter.personId, friend.personId, friendsChild, strangersChild, walkIn.personId]
        .map((id) => [id, 'joined'])
        .sort(),
    );
    expect(roster.members.every((m) => typeof m.displayName === 'string')).toBe(true);
    expect((await rosterOf(desk, bookingId)).members).toHaveLength(5);
    for (const outsider of [friend, stranger, await staff(t, ['coach' as never])]) {
      const res = await t.http.get(`/v1/bookings/${bookingId}/roster`).set(outsider.header);
      expect(res.status).toBe(404);
    }

    // being on a roster grants nothing else: no registration, no participation, no team
    // record, no report row; and nothing follows from the roster's events
    await drain(t);
    const rostered = [friend.personId, friendsChild, strangersChild, walkIn.personId];
    const count = async (
      table: 'enrollments' | 'applications' | 'session_bookings' | 'roster_memberships',
      column: 'participant_person_id' | 'person_id',
    ) =>
      Number(
        (
          await t.db
            .selectFrom(table)
            .select((eb) => eb.fn.countAll().as('n'))
            .where(column as never, 'in', rostered as never)
            .executeTakeFirstOrThrow()
        ).n,
      );
    expect(await count('enrollments', 'participant_person_id')).toBe(0);
    expect(await count('applications', 'participant_person_id')).toBe(0);
    expect(await count('session_bookings', 'participant_person_id')).toBe(0);
    expect(await count('roster_memberships', 'person_id')).toBe(0);
    const participations = await t.app
      .get<EnrollmentPort>(ENROLLMENT_PORT)
      .participationsOf(t.organizationId, rostered, {
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2028-01-01T00:00:00Z'),
      });
    for (const participation of participations) {
      expect(participation.enrollments).toEqual([]);
      expect(participation.sessionBookings).toEqual([]);
    }
    const handled = await t.db
      .selectFrom('job_attempts')
      .innerJoin('outbox_events', 'outbox_events.id', 'job_attempts.source_id')
      .select('job_attempts.handler')
      .where('outbox_events.event_type', 'like', 'enrollment.booking_roster%')
      .execute();
    expect(handled).toEqual([]);
    // the booking itself is exactly as it was
    const after = await t.http.get(`/v1/bookings/${bookingId}`).set(renter.header);
    expect(after.body).toMatchObject({ status: booking.status, revision: booking.revision });
  });

  it("SPK-COND-005 / SPK-REG-011: the roster shows each member's waiver as current, lapsed or missing for the rental's required waiver, and a missing waiver never blocks the booking", async () => {
    const setup = await rentalOffering();
    const policyKey = `rental-waiver-${newId().slice(-8)}`;
    const version = await createPolicyVersionFixture(t, {
      kind: 'waiver',
      key: policyKey,
      title: 'Rental waiver',
      effectiveFrom: LONG_AGO,
      content: fixtureWaiverContent({ renewEveryMonths: 6, enforcement: 'block' }),
    });
    await requireWaiverFixture(t, { offeringId: setup.offeringId, policyKey });
    // the renter themselves is the booking's participant: without the blocking waiver the booking
    // is refused at registration (SPK-REG-011), which is not what the roster is about
    const unsigned = await adult(t);
    await acknowledge(t, setup, unsigned.personId, unsigned.personId);
    const refusedBooking = await post(t, '/v1/bookings', unsigned.header, {
      offeringId: setup.offeringId,
      start: start(200).toISOString(),
      end: new Date(start(200).getTime() + HOUR).toISOString(),
      resourceIds: [fields[0]],
    });
    expect(refusedBooking.status).toBe(422);
    expect(refusedBooking.body.details.reasons).toEqual([
      expect.objectContaining({ code: 'waiver_missing', severity: 'blocking' }),
    ]);
    const { renter, bookingId, booking } = await rental(setup, version);
    const current = await createPersonFixture(t, { kind: 'adult' });
    const lapsed = await createPersonFixture(t, { kind: 'adult' });
    const missing = await createPersonFixture(t, { kind: 'adult' });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: current,
      policyVersionId: version,
      signedByPersonId: current,
    });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: lapsed,
      policyVersionId: version,
      signedByPersonId: lapsed,
      signedAt: new Date('2026-03-01T00:00:00Z'),
    });
    for (const personId of [current, lapsed, missing]) {
      expect((await add(desk, bookingId, personId)).status).toBe(201);
    }
    const pendingInvite = await invite(renter, bookingId, {
      recipientContact: { kind: 'phone', value: '+1 702 555 0100' },
    });
    expect(pendingInvite.status).toBe(201);
    const roster = await rosterOf(desk, bookingId);
    expect(roster.waiver).toEqual({
      state: 'evaluated',
      policyKeys: [policyKey],
      blocksBooking: false,
    });
    const statusOf = (personId: string) =>
      roster.members.find((m) => m.personId === personId)?.waiverStatus;
    expect(statusOf(current)).toBe('current');
    expect(statusOf(lapsed)).toBe('lapsed');
    expect(statusOf(missing)).toBe('missing');
    // an invited contact has no person yet: nothing to judge
    expect(roster.members.find((m) => m.personId === null)).toMatchObject({
      status: 'invited',
      waiverStatus: 'not_evaluated',
      invitedContact: { kind: 'phone', value: '+1 702 555 0100' },
      invitation: { status: 'pending' },
    });
    expect(roster.counts).toEqual({ joined: 3, invited: 1, waiverOutstanding: 2 });
    // the invited person sees which waiver the rental asks for
    const view = await t.http
      .get(`/v1/booking-roster-invitations/${pendingInvite.body.id}`)
      .query({ token: pendingInvite.body.token })
      .set((await adult(t)).header);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.requiredWaiverKeys).toEqual([policyKey]);
    // the waiver blocks nothing here: a person whose waiver is missing was added, and the
    // booking is untouched (proposed default, DEC-103 pending)
    const unchanged = await t.http.get(`/v1/bookings/${bookingId}`).set(renter.header);
    expect(unchanged.body).toMatchObject({ status: booking.status, revision: booking.revision });

    // once the missing member accepts the waiver the roster says so
    await createAccountFixture(t, { personId: missing });
    const accepted = await post(
      t,
      '/v1/waiver-acceptances',
      await authHeaderForPerson(t, missing),
      { subjectPersonId: missing, policyKey },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const refreshed = await rosterOf(renter, bookingId);
    expect(refreshed.members.find((m) => m.personId === missing)?.waiverStatus).toBe('current');
    expect(refreshed.counts.waiverOutstanding).toBe(1);

    // liability waivers turned off: nothing is evaluated
    await t.disableCapability('liability_waivers');
    try {
      const off = await rosterOf(desk, bookingId);
      expect(off.waiver).toEqual({ state: 'capability_off', policyKeys: [], blocksBooking: false });
      expect(new Set(off.members.map((m) => m.waiverStatus))).toEqual(new Set(['not_evaluated']));
      expect(off.counts.waiverOutstanding).toBe(0);
    } finally {
      await t.enableCapability('liability_waivers');
    }
    // a rental that requires no waiver: nothing to evaluate either
    const plain = await rental();
    expect((await add(desk, plain.bookingId, current)).status).toBe(201);
    const none = await rosterOf(desk, plain.bookingId);
    expect(none.waiver.state).toBe('not_required');
    expect(none.members[0]?.waiverStatus).toBe('not_evaluated');
  });

  it('SPK-COND-005: an invitation is declined, revoked or expires, and a member is removed, each leaving the row as history', async () => {
    const { renter, bookingId } = await rental();
    const guest = await adult(t);

    // declined by the invited person: the invited row is removed, with why
    const first = await invite(renter, bookingId, { recipientPersonId: guest.personId });
    const declined = await post(
      t,
      `/v1/booking-roster-invitations/${first.body.id}/decline`,
      guest.header,
      {},
    );
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.status).toBe('declined');
    expect((await accept(guest, first.body.id)).body.code).toBe('INVALID_TRANSITION');
    let roster = await rosterOf(renter, bookingId);
    expect(roster.members).toEqual([
      expect.objectContaining({
        personId: guest.personId,
        status: 'removed',
        waiverStatus: 'not_evaluated',
        invitation: expect.objectContaining({ status: 'declined' }),
      }),
    ]);

    // the same person can be invited again (the removed row is history, not a live member)
    const second = await invite(renter, bookingId, { recipientPersonId: guest.personId });
    expect(second.status).toBe(201);
    // only the renter or staff revoke; a reason is required
    const notTheirs = await post(
      t,
      `/v1/booking-roster-invitations/${second.body.id}/revoke`,
      guest.header,
      { reason: 'x' },
    );
    expect(notTheirs.status).toBe(404);
    const noReason = await post(
      t,
      `/v1/booking-roster-invitations/${second.body.id}/revoke`,
      renter.header,
      {},
    );
    expect(noReason.status).toBe(400);
    const revoked = await post(
      t,
      `/v1/booking-roster-invitations/${second.body.id}/revoke`,
      renter.header,
      { reason: 'Wrong person' },
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect((await accept(guest, second.body.id)).body.code).toBe('INVALID_TRANSITION');

    // an invitation past its expiry reads expired, and an attempt to accept records the expiry
    const third = await invite(desk, bookingId, {
      recipientPersonId: guest.personId,
      expiresInHours: 2,
    });
    expect(third.status).toBe(201);
    t.clock.advance(3 * HOUR);
    try {
      expect(
        (await t.http.get('/v1/me/booking-roster-invitations').set(guest.header)).body,
      ).toEqual([]);
      const view = await t.http
        .get(`/v1/booking-roster-invitations/${third.body.id}`)
        .set(guest.header);
      expect(view.body.status).toBe('expired');
      const late = await accept(guest, third.body.id);
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('INVALID_TRANSITION');
      const recorded = await t.db
        .selectFrom('booking_roster_invitations')
        .select('status')
        .where('id', '=', third.body.id)
        .executeTakeFirstOrThrow();
      expect(recorded.status).toBe('expired');
    } finally {
      t.clock.advance(-3 * HOUR);
    }
    roster = await rosterOf(renter, bookingId);
    expect(roster.members.map((m) => m.status)).toEqual(['removed', 'removed', 'removed']);

    // a joined member leaves by themselves; the renter removes another; staff remove a third
    const fourth = await invite(renter, bookingId, { recipientPersonId: guest.personId });
    const joined = await accept(guest, fourth.body.id);
    expect(joined.status).toBe(200);
    const memberId = joined.body.member.id as string;
    const remove = (actor: Actor, id: string, body: Record<string, unknown>) =>
      post(t, `/v1/bookings/${bookingId}/roster/members/${id}/remove`, actor.header, body);
    const outsider = await adult(t);
    expect((await remove(outsider, memberId, { reason: 'x' })).status).toBe(404);
    expect((await remove(guest, memberId, {})).status).toBe(400);
    const stale = await remove(guest, memberId, { reason: 'Cannot come', expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const left = await remove(guest, memberId, { reason: 'Cannot come' });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(left.body).toMatchObject({
      status: 'removed',
      removalReason: 'Cannot come',
      waiverStatus: 'not_evaluated',
    });
    expect((await remove(renter, memberId, { reason: 'again' })).body.code).toBe(
      'INVALID_TRANSITION',
    );
    // removing a row that is still only invited revokes its invitation too
    const fifth = await invite(renter, bookingId, {
      recipientContact: { kind: 'email', value: 'late@example.test' },
    });
    const invitedRow = (await rosterOf(renter, bookingId)).members.find(
      (m) => m.status === 'invited',
    );
    expect(invitedRow?.invitation?.id).toBe(fifth.body.id);
    const removedInvite = await remove(desk, invitedRow!.id, { reason: 'Booked by mistake' });
    expect(removedInvite.status).toBe(200);
    expect(
      await t.db
        .selectFrom('booking_roster_invitations')
        .select(['status', 'revocation_reason'])
        .where('id', '=', fifth.body.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'revoked', revocation_reason: 'Booked by mistake' });
    const audits = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', '=', memberId)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      'enrollment.manage_booking_roster',
      'enrollment.manage_booking_roster',
      'enrollment.remove_booking_roster_member',
    ]);
    expect(audits[2]?.reason).toBe('Cannot come');
  });

  it('SPK-COND-005: only a live rental booking has a roster', async () => {
    const guest = await createPersonFixture(t, { kind: 'adult' });
    // a party is not a rental
    const definitionId = await definitionWithScope(t, 'party_package' as never, {
      durationMinutes: 120,
      guestLimit: 12,
      resources: { resourceIds: fields, count: 1 },
      staffing: [],
      equipmentAssetIds: [],
    });
    const partySetup = await offering(t, {
      kind: 'party' as never,
      entitlementDefinitionId: definitionId,
      basePriceMinor: 0,
      ageBand: { minAgeYears: 18 },
    });
    useBookingTerms(partySetup.offeringId, await terms());
    const host = await adult(t);
    await acknowledge(t, partySetup, host.personId, host.personId);
    next += 1;
    const party = await post(t, '/v1/bookings', host.header, {
      offeringId: partySetup.offeringId,
      start: start(next, 20).toISOString(),
      resourceIds: [fields[1]],
      guestCount: 8,
    });
    expect(party.status, JSON.stringify(party.body)).toBe(201);
    const refused = await add(desk, party.body.id, guest);
    expect(refused.status).toBe(400);
    expect(refused.body.details).toMatchObject({ code: 'ROSTER_RENTAL_ONLY' });
    expect(
      (await invite(host, party.body.id, { recipientPersonId: guest })).body.details,
    ).toMatchObject({ code: 'ROSTER_RENTAL_ONLY' });

    // an ended booking's roster is read, not added to
    const { renter, bookingId, booking } = await rental();
    expect((await add(desk, bookingId, guest)).status).toBe(201);
    const canceled = await post(t, `/v1/bookings/${bookingId}/cancel`, renter.header, {
      reason: 'Rained off',
      expectedRevision: booking.revision,
    });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    const late = await add(desk, bookingId, (await adult(t)).personId);
    expect(late.status).toBe(400);
    expect(late.body.details).toMatchObject({ code: 'BOOKING_NOT_LIVE' });
    expect((await rosterOf(desk, bookingId)).counts.joined).toBe(1);
    // an unknown booking and an unknown person
    expect((await add(desk, newId(), guest)).status).toBe(404);
    const live = await rental();
    expect((await add(desk, live.bookingId, newId())).status).toBe(400);
  });

  it('SPK-COND-005 with rental rosters turned off: nobody is added or invited and no invitation is accepted, while the roster stays readable and can be unwound', async () => {
    const { renter, bookingId } = await rental();
    const guest = await adult(t);
    const other = await adult(t);
    const pending = await invite(renter, bookingId, { recipientPersonId: guest.personId });
    const second = await invite(renter, bookingId, { recipientPersonId: other.personId });
    expect((await add(renter, bookingId, renter.personId)).status).toBe(201);
    await t.disableCapability('rental_rosters');
    try {
      disabled(await add(desk, bookingId, (await adult(t)).personId));
      disabled(
        await invite(renter, bookingId, { recipientContact: { kind: 'email', value: 'a@b.test' } }),
      );
      disabled(await accept(guest, pending.body.id));
      // reads of what exists stay available
      const roster = await rosterOf(renter, bookingId);
      expect(roster.counts).toMatchObject({ joined: 1, invited: 2 });
      expect(
        (await t.http.get(`/v1/booking-roster-invitations/${pending.body.id}`).set(guest.header))
          .status,
      ).toBe(200);
      // unwinding is never gated: decline, revoke, remove
      expect(
        (
          await post(
            t,
            `/v1/booking-roster-invitations/${pending.body.id}/decline`,
            guest.header,
            {},
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await post(t, `/v1/booking-roster-invitations/${second.body.id}/revoke`, renter.header, {
            reason: 'Feature turned off',
          })
        ).status,
      ).toBe(200);
      const self = roster.members.find((m) => m.personId === renter.personId);
      expect(
        (
          await post(
            t,
            `/v1/bookings/${bookingId}/roster/members/${self!.id}/remove`,
            renter.header,
            { reason: 'Feature turned off' },
          )
        ).status,
      ).toBe(200);
    } finally {
      await t.enableCapability('rental_rosters');
    }
  });

  describe('database integrity (migration 0530)', () => {
    const actor = json({ kind: 'system', actorLabel: 'schema-test' });
    const memberRow = (bookingId: string, over: Record<string, unknown>) => ({
      id: newId(),
      organization_id: t.organizationId,
      booking_id: bookingId,
      person_id: null,
      invited_contact_kind: null,
      invited_contact_value: null,
      status: 'joined' as const,
      added_by: actor,
      added_by_person_id: null,
      joined_at: t.clock.now(),
      removed_at: null,
      removed_by: null,
      removal_reason: null,
      ...over,
    });
    const insertMember = (bookingId: string, over: Record<string, unknown>) =>
      t.db
        .insertInto('booking_roster_members')
        .values(memberRow(bookingId, over) as never)
        .execute();

    it('SPK-COND-005: the database refuses a second live roster row for one booking and person, and for one booking and invited contact', async () => {
      const { bookingId } = await rental();
      const person = await createPersonFixture(t, { kind: 'adult' });
      const first = newId();
      await insertMember(bookingId, { id: first, person_id: person });
      await expect(insertMember(bookingId, { person_id: person })).rejects.toSatisfy(
        isUniqueViolation,
      );
      // an invited row is live too
      await expect(
        insertMember(bookingId, { person_id: person, status: 'invited', joined_at: null }),
      ).rejects.toSatisfy(isUniqueViolation);
      // once removed, the person can be on the roster again
      await t.db
        .updateTable('booking_roster_members')
        .set({ status: 'removed', removed_at: t.clock.now() })
        .where('id', '=', first)
        .execute();
      await insertMember(bookingId, { person_id: person });
      // the same person on another booking is no conflict
      const other = await rental();
      await insertMember(other.bookingId, { person_id: person });
      const contact = {
        status: 'invited' as const,
        joined_at: null,
        invited_contact_kind: 'email',
        invited_contact_value: 'guest@example.test',
      };
      await insertMember(bookingId, contact);
      await expect(insertMember(bookingId, contact)).rejects.toSatisfy(isUniqueViolation);
    });

    it('SPK-COND-005: a roster row is about a person or a contact, a joined member is a person, and its lifecycle only moves forward', async () => {
      const { bookingId } = await rental();
      const person = await createPersonFixture(t, { kind: 'adult' });
      const another = await createPersonFixture(t, { kind: 'adult' });
      // neither a person nor a contact
      await expect(
        insertMember(bookingId, { status: 'invited', joined_at: null }),
      ).rejects.toSatisfy(isCheckViolation);
      // joined without a person, or without a joining time
      await expect(
        insertMember(bookingId, {
          invited_contact_kind: 'email',
          invited_contact_value: 'x@example.test',
        }),
      ).rejects.toSatisfy(isCheckViolation);
      await expect(
        insertMember(bookingId, { person_id: person, joined_at: null }),
      ).rejects.toSatisfy(isCheckViolation);
      // a contact kind without its value; an unknown status; removed without a time
      await expect(
        insertMember(bookingId, {
          status: 'invited',
          joined_at: null,
          invited_contact_kind: 'email',
        }),
      ).rejects.toSatisfy(isCheckViolation);
      await expect(
        insertMember(bookingId, { person_id: person, status: 'waiting' }),
      ).rejects.toSatisfy(isCheckViolation);
      await expect(
        insertMember(bookingId, { person_id: person, status: 'removed' }),
      ).rejects.toSatisfy(isCheckViolation);

      const id = newId();
      await insertMember(bookingId, { id, person_id: person });
      const update = (set: Record<string, unknown>) =>
        t.db
          .updateTable('booking_roster_members')
          .set(set as never)
          .where('id', '=', id)
          .execute();
      // the person and the booking of a row never change
      await expect(update({ person_id: another })).rejects.toThrow(/cannot change/);
      const elsewhere = await rental();
      await expect(update({ booking_id: elsewhere.bookingId })).rejects.toThrow(/cannot change/);
      // joined -> invited is not a move; joined -> removed is; removed is final
      await expect(update({ status: 'invited', joined_at: null })).rejects.toSatisfy(
        isCheckViolation,
      );
      await update({ status: 'removed', removed_at: t.clock.now() });
      await expect(update({ status: 'joined', removed_at: null })).rejects.toSatisfy(
        isCheckViolation,
      );
      // history is never deleted
      await expect(
        t.db.deleteFrom('booking_roster_members').where('id', '=', id).execute(),
      ).rejects.toThrow(/append-only/);
    });

    it("SPK-COND-005: a roster row cannot point at another organization's booking or person, and an invitation cannot be rewritten or reopened", async () => {
      const { bookingId } = await rental();
      const other = await seedOrganization(t.db);
      const foreignPerson = await createPersonFixture(t, {
        kind: 'adult',
        organizationId: other.organizationId,
      });
      const person = await createPersonFixture(t, { kind: 'adult' });
      await expect(insertMember(bookingId, { person_id: foreignPerson })).rejects.toSatisfy(
        isForeignKeyViolation,
      );
      await expect(
        insertMember(bookingId, { person_id: person, added_by_person_id: foreignPerson }),
      ).rejects.toSatisfy(isForeignKeyViolation);
      // the same booking id under the other organization does not exist there
      await expect(
        t.db
          .insertInto('booking_roster_members')
          .values(
            memberRow(bookingId, {
              organization_id: other.organizationId,
              person_id: foreignPerson,
            }) as never,
          )
          .execute(),
      ).rejects.toSatisfy(isForeignKeyViolation);

      const memberId = newId();
      await insertMember(bookingId, {
        id: memberId,
        person_id: person,
        status: 'invited',
        joined_at: null,
      });
      const invitation = (over: Record<string, unknown>) => ({
        id: newId(),
        organization_id: t.organizationId,
        booking_id: bookingId,
        member_id: memberId,
        invited_by: actor,
        invited_by_person_id: null,
        recipient_person_id: person,
        recipient_contact_kind: null,
        recipient_contact_value: null,
        message: null,
        token_hash: `hash-${newId()}`,
        expires_at: new Date(t.clock.now().getTime() + DAY),
        accepted_at: null,
        accepted_by_person_id: null,
        declined_at: null,
        revoked_at: null,
        revoked_by: null,
        revocation_reason: null,
        ...over,
      });
      const insertInvitation = (over: Record<string, unknown>) =>
        t.db
          .insertInto('booking_roster_invitations')
          .values(invitation(over) as never)
          .execute();
      const id = newId();
      await insertInvitation({ id });
      // one pending invitation per roster row; a person or a contact, never both or neither
      await expect(insertInvitation({})).rejects.toSatisfy(isUniqueViolation);
      await expect(
        insertInvitation({
          status: 'revoked',
          revoked_at: t.clock.now(),
          recipient_person_id: null,
        }),
      ).rejects.toSatisfy(isCheckViolation);
      await expect(
        insertInvitation({
          status: 'revoked',
          revoked_at: t.clock.now(),
          recipient_contact_kind: 'email',
          recipient_contact_value: 'x@example.test',
        }),
      ).rejects.toSatisfy(isCheckViolation);
      await expect(
        insertInvitation({
          status: 'revoked',
          revoked_at: t.clock.now(),
          recipient_person_id: foreignPerson,
        }),
      ).rejects.toSatisfy(isForeignKeyViolation);
      // accepted needs its time
      await expect(insertInvitation({ status: 'accepted' })).rejects.toSatisfy(isCheckViolation);
      const update = (set: Record<string, unknown>) =>
        t.db
          .updateTable('booking_roster_invitations')
          .set(set as never)
          .where('id', '=', id)
          .execute();
      await expect(update({ token_hash: 'another' })).rejects.toThrow(/cannot be rewritten/);
      await expect(
        update({ expires_at: new Date(t.clock.now().getTime() + 30 * DAY) }),
      ).rejects.toThrow(/cannot be rewritten/);
      await update({ status: 'declined', declined_at: t.clock.now() });
      await expect(update({ status: 'pending', declined_at: null })).rejects.toSatisfy(
        isCheckViolation,
      );
      await expect(
        t.db.deleteFrom('booking_roster_invitations').where('id', '=', id).execute(),
      ).rejects.toThrow(/append-only/);
    });
  });
});

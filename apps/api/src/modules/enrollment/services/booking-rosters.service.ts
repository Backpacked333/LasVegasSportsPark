import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AcceptBookingRosterInvitationInput,
  type AddBookingRosterMemberInput,
  type BookingRoster,
  type BookingRosterInvitation,
  type BookingRosterInvitationAccepted,
  type BookingRosterInvitationIssued,
  type BookingRosterInvitationView,
  type BookingRosterMember,
  type BookingRosterWaiverRequirement,
  type BookingRosterWaiverStatus,
  type CreateBookingRosterInvitationInput,
  type DeclineBookingRosterInvitationInput,
  type Principal,
  type RemoveBookingRosterMemberInput,
  type RevokeBookingRosterInvitationInput,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  type BookingRosterInvitationsTable,
  type BookingRosterMembersTable,
  type Database,
  type Db,
} from '@sportspark/db';
import type { InsertObject, Selectable, UpdateObject } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  CLOCK,
  DATABASE,
  FacilityDirectory,
  Outbox,
  UnitOfWork,
  type ActionDefinition,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  POLICY_PORT,
  type OfferingLookupPort,
  type PolicyPort,
} from '../../catalog';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentRosterEvents } from '../enrollment.events';
import { actorSnapshot, iso, isoOrNull, organizationOf, type Reader } from '../enrollment.shared';
import {
  BookingRosterInvitationMachine,
  BookingRosterMemberMachine,
} from '../enrollment.state-machines';
import { BookingsService, type BookingRow } from './bookings.service';
import { CustomerScope } from './customer-scope';
import { EnrollmentFacilityScope } from './facility-scope';

type MemberRow = Selectable<BookingRosterMembersTable>;
type InvitationRow = Selectable<BookingRosterInvitationsTable>;

/**
 * How long a roster invitation stays open when the inviter names no expiry. An engineering default
 * (Proposed; DEC-103 does not ask it), the same as a team invitation's.
 */
export const BOOKING_ROSTER_INVITATION_DEFAULT_HOURS = 14 * 24;

/** A roster exists only while its booking is live; an ended booking's roster is read-only. */
const LIVE_BOOKING: ReadonlyArray<BookingRow['status']> = [
  'requested',
  'held',
  'awaiting_staff',
  'confirmed',
];

const WAIVER_RANK: Record<BookingRosterWaiverStatus, number> = {
  not_evaluated: 0,
  current: 1,
  lapsed: 2,
  missing: 3,
};

function newToken(): string {
  return randomBytes(32).toString('base64url');
}
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
/** Whether `token` is the one behind `tokenHash`, compared in constant time. */
function holdsToken(token: string | undefined, tokenHash: string): boolean {
  if (token === undefined) return false;
  const presented = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(tokenHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

interface Access {
  staff: boolean;
  booker: boolean;
  selfIds: string[];
}

/**
 * Who is reading a roster row. A person's details are theirs until they join (security review
 * M-1): a row that never joined shows no name and no waiver status to anybody, and its person
 * reference only to staff or to a reader who may act for that person.
 */
interface Viewer {
  staff: boolean;
  ownIds: ReadonlySet<string>;
}

/** In what capacity the caller answers an invitation. */
interface Recipient {
  invitation: InvitationRow;
  selfIds: string[];
  /** `self`: the invitation names the caller, or the caller holds a contact invitation's token. */
  capacity: 'self' | 'representative';
}

/**
 * Rental-group rosters (SPK-COND-005, proposed amendment PA-09; capability `rental_rosters`,
 * DEC-103). Proposed: built ahead of the decision and off until an organization turns it on.
 *
 * A rental booking may have a roster: the people the renter brings. The renter or staff add and
 * invite people; an invited person joins for themselves (or, on a contact invitation, for their
 * child); a member may add their own child. Staff and the renter read the roster with each
 * joined member's liability waiver status for the rental offering's required waiver, judged by
 * the catalog (`PolicyPort.waiverStatuses`), or `not_evaluated` while liability waivers are off.
 *
 * Whose person a customer may name (security review M-1; SPK-IAM-003): a renter or member names
 * by person reference only themselves and the people they hold registering authority for, when
 * adding and when inviting; anybody else is invited by contact. A reference they may not name is
 * answered exactly as an unknown one. An invitation that names a person is answered only by
 * that person or by somebody who may act for them, with or without its token; a contact
 * invitation is answered by the holder of its token, for themselves or a child they act for.
 * The database records who joined and in what capacity (migration 0531).
 *
 * Being on a roster grants nothing else. This service writes only its two tables: no enrollment,
 * no entitlement, no hold, no team entry, no roster membership; no other module reads them. A
 * missing waiver is shown and never changes the booking (the proposed default of DEC-103).
 *
 * Adding, inviting and accepting check the capability inside their unit of work. Declining,
 * revoking, removing and every read never do, so a roster can always be unwound and read.
 */
@Injectable()
export class BookingRostersService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly facilities: FacilityDirectory,
    private readonly bookings: BookingsService,
    private readonly scope: EnrollmentFacilityScope,
    private readonly customers: CustomerScope,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  /** The renter, or staff at the booking's facility; anyone else learns nothing (§4.10). */
  async roster(principal: Principal, bookingId: string): Promise<BookingRoster> {
    const organizationId = organizationOf(principal);
    const booking = await this.bookings.load(this.db, organizationId, bookingId);
    if (!booking) throw errors.protectedNotFound('booking');
    const access = await this.access(principal, booking, EnrollmentActions.readBookingRoster);
    if (!access.staff && !access.booker) throw errors.protectedNotFound('booking');
    const rows = await this.db
      .selectFrom('booking_roster_members')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('booking_id', '=', bookingId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const viewer = await this.viewer(principal, access);
    const { members, waiver } = await this.memberViews(
      this.db,
      organizationId,
      booking,
      rows,
      viewer,
    );
    const order = { joined: 0, invited: 1, removed: 2 } as const;
    members.sort((a, b) => order[a.status] - order[b.status]);
    const joined = members.filter((m) => m.status === 'joined');
    return {
      bookingId,
      waiver,
      members,
      counts: {
        joined: joined.length,
        invited: members.filter((m) => m.status === 'invited').length,
        waiverOutstanding: joined.filter(
          (m) => m.waiverStatus === 'missing' || m.waiverStatus === 'lapsed',
        ).length,
      },
    };
  }

  /**
   * One invitation as the invited person sees it. Readable by the person it names or somebody who
   * may act for them, by whoever holds a contact invitation's token, by the renter and by staff
   * at the facility; nobody else learns it exists. A token never opens an invitation that names
   * somebody else.
   */
  async invitation(
    principal: Principal,
    invitationId: string,
    token: string | undefined,
  ): Promise<BookingRosterInvitationView> {
    const organizationId = organizationOf(principal);
    const row = await this.loadInvitation(this.db, organizationId, invitationId);
    if (!row) throw errors.protectedNotFound('booking_roster_invitation');
    const booking = await this.bookings.load(this.db, organizationId, row.booking_id);
    if (!booking) throw errors.protectedNotFound('booking_roster_invitation');
    const access = await this.access(principal, booking, EnrollmentActions.readBookingRoster);
    if (!access.staff && !access.booker) {
      // Throws the answer an unknown invitation gets unless the caller is its recipient.
      await this.recipientOf(principal, row, token);
    }
    return this.withoutRecipient(
      await this.invitationView(organizationId, row, booking),
      await this.viewer(principal, access),
    );
  }

  /**
   * The open invitations that name the signed-in person, or a person they may register (a child
   * staff invited by name has no account of their own to answer with).
   */
  async myInvitations(principal: Principal): Promise<BookingRosterInvitationView[]> {
    const organizationId = organizationOf(principal);
    if (!principal.personId) return [];
    const answerable = [
      ...new Set([
        ...(await this.customers.selfIds(principal)),
        ...(await this.customers.subjectIds(
          principal,
          EnrollmentActions.acceptBookingRosterInvitation,
        )),
      ]),
    ];
    const now = this.clock.now();
    const rows = await this.db
      .selectFrom('booking_roster_invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('recipient_person_id', 'in', answerable)
      .where('status', '=', 'pending')
      .where('expires_at', '>', now)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(50)
      .execute();
    const views: BookingRosterInvitationView[] = [];
    for (const row of rows) {
      const booking = await this.bookings.load(this.db, organizationId, row.booking_id);
      if (booking) views.push(await this.invitationView(organizationId, row, booking));
    }
    return views;
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  /**
   * Adds a person who is here to be added: staff add anyone; the renter and joined members add
   * themselves or someone they may register (their child). Anyone else is invited instead, so
   * nobody is put on a list without their own say.
   */
  async addMember(
    principal: Principal,
    bookingId: string,
    body: AddBookingRosterMemberInput,
    correlationId: string | null,
  ): Promise<BookingRosterMember> {
    const organizationId = organizationOf(principal);
    const found = await this.bookings.load(this.db, organizationId, bookingId);
    if (!found) throw errors.protectedNotFound('booking');
    const access = await this.access(principal, found, EnrollmentActions.manageBookingRoster);
    if (!access.staff) {
      const member = access.booker || (await this.isJoinedMember(organizationId, found.id, access));
      if (!member) throw errors.protectedNotFound('booking');
      // Themselves or someone they may register, as a person: a staff role held elsewhere never
      // widens this (the customer subjects of the action ignore staff roles).
      const mayAdd = (
        await this.customers.subjectIds(principal, EnrollmentActions.manageBookingRoster)
      ).includes(body.personId);
      if (!mayAdd) {
        throw errors.validation(
          'You can add yourself or someone you register for. Invite anyone else, so they answer for themselves.',
          { path: 'personId', code: 'ROSTER_INVITATION_REQUIRED' },
        );
      }
    }
    // Read before the unit of work opens: it reads relationships, not this module's rows.
    const viewer = await this.viewer(principal, access);
    return this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'rental_rosters', trx);
      const booking = await this.rosterableBooking(trx, organizationId, bookingId);
      const person = await this.persons.findPerson(organizationId, body.personId, trx);
      if (!person || person.status !== 'active') {
        throw errors.validation('The person is not an active person of this organization.', {
          path: 'personId',
        });
      }
      const now = this.clock.now();
      const id = newId();
      const row = await this.insertMember(trx, {
        id,
        organization_id: organizationId,
        booking_id: booking.id,
        person_id: person.id,
        invited_contact_kind: null,
        invited_contact_value: null,
        status: BookingRosterMemberMachine.next('invited', 'join'),
        added_by: json(actorSnapshot(principal)),
        added_by_person_id: principal.personId,
        joined_at: now,
        removed_at: null,
        removed_by: null,
        removal_reason: null,
      });
      await this.recordChange(trx, principal, organizationId, booking, row, 'joined', {
        reason: body.reason ?? null,
        correlationId,
        details: { addedDirectly: true, byStaff: access.staff },
      });
      return this.memberView(trx, organizationId, booking, row, viewer);
    });
  }

  /** The renter or staff invite a person, or a contact who has no record yet. */
  async invite(
    principal: Principal,
    bookingId: string,
    body: CreateBookingRosterInvitationInput,
    correlationId: string | null,
  ): Promise<BookingRosterInvitationIssued> {
    const organizationId = organizationOf(principal);
    const found = await this.bookings.load(this.db, organizationId, bookingId);
    if (!found) throw errors.protectedNotFound('booking');
    const access = await this.access(principal, found, EnrollmentActions.manageBookingRoster);
    if (!access.staff && !access.booker) throw errors.protectedNotFound('booking');
    // A renter names by reference only themselves or someone they may register (never through a
    // staff role held elsewhere). Any other reference, known or not, gets one answer: no lookup
    // is made, so the answer says nothing about whether such a person exists (§4.10).
    if (body.recipientPersonId && !access.staff) {
      const mayName = (
        await this.customers.subjectIds(principal, EnrollmentActions.manageBookingRoster)
      ).includes(body.recipientPersonId);
      if (!mayName) throw inviteByContact();
    }
    const token = newToken();
    const contact = body.recipientContact
      ? {
          kind: body.recipientContact.kind,
          value:
            body.recipientContact.kind === 'email'
              ? body.recipientContact.value.trim().toLowerCase()
              : body.recipientContact.value.trim(),
        }
      : null;
    return this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'rental_rosters', trx);
      const booking = await this.rosterableBooking(trx, organizationId, bookingId);
      let recipientPersonId: string | null = null;
      if (body.recipientPersonId) {
        const recipient = await this.persons.findPerson(
          organizationId,
          body.recipientPersonId,
          trx,
        );
        if (!recipient || recipient.status !== 'active') {
          // Staff look people up elsewhere; a renter gets the one answer of every refused
          // reference.
          throw access.staff
            ? errors.notFound('person', body.recipientPersonId)
            : inviteByContact();
        }
        recipientPersonId = recipient.id;
      }
      const now = this.clock.now();
      const expiresAt = new Date(
        now.getTime() +
          (body.expiresInHours ?? BOOKING_ROSTER_INVITATION_DEFAULT_HOURS) * 3_600_000,
      );
      const member = await this.insertMember(trx, {
        id: newId(),
        organization_id: organizationId,
        booking_id: booking.id,
        person_id: recipientPersonId,
        invited_contact_kind: contact?.kind ?? null,
        invited_contact_value: contact?.value ?? null,
        status: 'invited',
        added_by: json(actorSnapshot(principal)),
        added_by_person_id: principal.personId,
        joined_at: null,
        removed_at: null,
        removed_by: null,
        removal_reason: null,
      });
      const id = newId();
      const invitation = await trx
        .insertInto('booking_roster_invitations')
        .values({
          id,
          organization_id: organizationId,
          booking_id: booking.id,
          member_id: member.id,
          invited_by: json(actorSnapshot(principal)),
          invited_by_person_id: principal.personId,
          recipient_person_id: recipientPersonId,
          recipient_contact_kind: contact?.kind ?? null,
          recipient_contact_value: contact?.value ?? null,
          message: body.message ?? null,
          token_hash: hashToken(token),
          expires_at: expiresAt,
          accepted_at: null,
          accepted_by_person_id: null,
          declined_at: null,
          revoked_at: null,
          revoked_by: null,
          revocation_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageBookingRoster.id,
        targetType: 'booking_roster_invitation',
        targetId: id,
        afterRevision: invitation.revision,
        reason: body.reason ?? null,
        correlationId,
        details: {
          bookingId: booking.id,
          memberId: member.id,
          recipientPersonId,
          recipientContactKind: contact?.kind ?? null,
          expiresAt: expiresAt.toISOString(),
        },
      });
      await this.outbox.enqueue(trx, EnrollmentRosterEvents.bookingRosterInvitationCreated, {
        organizationId,
        aggregateType: 'booking_roster_invitation',
        aggregateId: id,
        payload: {
          invitationId: id,
          bookingId: booking.id,
          memberId: member.id,
          recipientPersonId,
          recipientContactKind: contact?.kind ?? null,
          expiresAt: expiresAt.toISOString(),
        },
        correlationId,
      });
      await this.recordChange(trx, principal, organizationId, booking, member, 'invited', {
        reason: null,
        correlationId,
        details: { invitationId: id },
      });
      return { ...this.toInvitation(invitation, now), token };
    });
  }

  /**
   * The invited person joins. An invitation that names a person joins that person and nobody
   * else, and is accepted only by them or by somebody who may register them (signing in proves
   * who they are; its token is neither needed nor enough). An invitation to a contact is accepted
   * by whoever holds its token, for themselves or for someone they may register (their child);
   * the roster row becomes that joiner.
   */
  async accept(
    principal: Principal,
    invitationId: string,
    body: AcceptBookingRosterInvitationInput,
    correlationId: string | null,
  ): Promise<BookingRosterInvitationAccepted> {
    const organizationId = organizationOf(principal);
    const actorPersonId = principal.personId;
    if (!actorPersonId) {
      throw errors.accessDenied('Link your account to a person before accepting.');
    }
    const found = await this.loadInvitation(this.db, organizationId, invitationId);
    if (!found) throw errors.protectedNotFound('booking_roster_invitation');
    const recipient = await this.recipientOf(principal, found, body.token);
    const { joiner, capacity } = this.joinerOf(recipient, actorPersonId, body.personId);
    const target = {
      type: 'booking_roster_invitation',
      id: invitationId,
      organizationId,
      subjectPersonIds: [joiner],
      protected: true,
    };
    // Self, or a person the caller may register: the same authority a registration needs. The
    // person an invitation names needs no more than being that person.
    const needsAuthority = found.recipient_person_id === null || capacity === 'representative';
    if (needsAuthority) {
      await this.authorization.require(
        principal,
        EnrollmentActions.acceptBookingRosterInvitation,
        target,
      );
    }
    const now = this.clock.now();
    await this.expireIfDue(principal, organizationId, invitationId, now, correlationId);
    return this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'rental_rosters', trx);
      const invitation = await this.loadInvitation(trx, organizationId, invitationId, true);
      if (!invitation) throw errors.protectedNotFound('booking_roster_invitation');
      if (needsAuthority) {
        // Judged again inside the unit of work, against the joiner (§4.11).
        await this.authorization.require(
          principal,
          EnrollmentActions.acceptBookingRosterInvitation,
          target,
        );
      }
      BookingRosterInvitationMachine.next(invitation.status, 'accept');
      const booking = await this.rosterableBooking(trx, organizationId, invitation.booking_id);
      const member = await this.loadMember(trx, organizationId, invitation.member_id, true);
      if (!member) throw errors.internal('a roster invitation without its roster row');
      const person = await this.persons.findPerson(organizationId, joiner, trx);
      if (!person || person.status !== 'active') {
        throw errors.validation('The person joining is not an active person.', {
          path: 'personId',
        });
      }
      let joined: MemberRow;
      try {
        joined = await trx
          .updateTable('booking_roster_members')
          .set({
            status: BookingRosterMemberMachine.next(member.status, 'join'),
            // The joiner: the person the invitation names, or whoever a contact invitation's
            // holder joined. The row's person never changes once named (0530 guard).
            person_id: person.id,
            joined_at: now,
            revision: member.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', member.id)
          .where('revision', '=', member.revision)
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('This person is already on the roster.', {
            code: 'ROSTER_MEMBER_EXISTS',
          });
        }
        throw error;
      }
      const accepted = await trx
        .updateTable('booking_roster_invitations')
        .set({
          status: 'accepted',
          accepted_at: now,
          // Who acted, who joined and in what capacity: the database refuses an acceptance whose
          // joiner is not the person named or not the joined roster row (migration 0531).
          accepted_by_person_id: capacity === 'self' ? person.id : actorPersonId,
          accepted_for_person_id: person.id,
          accepted_as: capacity,
          revision: invitation.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', invitation.id)
        .where('revision', '=', invitation.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.recordInvitationChange(trx, principal, accepted, 'accepted', {
        beforeRevision: invitation.revision,
        reason: body.reason ?? null,
        correlationId,
      });
      await this.recordChange(trx, principal, organizationId, booking, joined, 'joined', {
        reason: null,
        correlationId,
        beforeRevision: member.revision,
        details: { invitationId: invitation.id, acceptedAs: capacity },
      });
      return {
        invitation: this.toInvitation(accepted, now),
        // The caller is the joiner or acts for them: the row is theirs to see.
        member: await this.memberView(trx, organizationId, booking, joined, {
          staff: false,
          ownIds: new Set([person.id]),
        }),
      };
    });
  }

  async decline(
    principal: Principal,
    invitationId: string,
    body: DeclineBookingRosterInvitationInput,
    correlationId: string | null,
  ): Promise<BookingRosterInvitation> {
    const organizationId = organizationOf(principal);
    const found = await this.loadInvitation(this.db, organizationId, invitationId);
    if (!found) throw errors.protectedNotFound('booking_roster_invitation');
    await this.recipientOf(principal, found, body.token);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const invitation = await this.loadInvitation(trx, organizationId, invitationId, true);
      if (!invitation) throw errors.protectedNotFound('booking_roster_invitation');
      const next = BookingRosterInvitationMachine.next(invitation.status, 'decline');
      return this.closeInvitation(trx, principal, invitation, next, now, {
        set: { declined_at: now },
        memberReason: 'The invitation was declined.',
        reason: body.reason ?? null,
        correlationId,
      });
    });
  }

  /** The renter or staff withdraw a pending invitation. */
  async revoke(
    principal: Principal,
    invitationId: string,
    body: RevokeBookingRosterInvitationInput,
    correlationId: string | null,
  ): Promise<BookingRosterInvitation> {
    const organizationId = organizationOf(principal);
    const found = await this.loadInvitation(this.db, organizationId, invitationId);
    if (!found) throw errors.protectedNotFound('booking_roster_invitation');
    const booking = await this.bookings.load(this.db, organizationId, found.booking_id);
    if (!booking) throw errors.protectedNotFound('booking_roster_invitation');
    const access = await this.access(
      principal,
      booking,
      EnrollmentActions.removeBookingRosterMember,
    );
    if (!access.staff && !access.booker) {
      throw errors.protectedNotFound('booking_roster_invitation');
    }
    const viewer = await this.viewer(principal, access);
    const now = this.clock.now();
    const revoked = await this.uow.run(async ({ trx }) => {
      const invitation = await this.loadInvitation(trx, organizationId, invitationId, true);
      if (!invitation) throw errors.protectedNotFound('booking_roster_invitation');
      assertExpectedRevision(body.expectedRevision, invitation.revision);
      const next = BookingRosterInvitationMachine.next(invitation.status, 'revoke');
      return this.closeInvitation(trx, principal, invitation, next, now, {
        set: {
          revoked_at: now,
          revoked_by: json(actorSnapshot(principal)),
          revocation_reason: body.reason,
        },
        memberReason: body.reason,
        reason: body.reason,
        correlationId,
      });
    });
    return this.withoutRecipient(revoked, viewer);
  }

  /** The renter, staff, the member themselves or someone who may register them. */
  async removeMember(
    principal: Principal,
    bookingId: string,
    memberId: string,
    body: RemoveBookingRosterMemberInput,
    correlationId: string | null,
  ): Promise<BookingRosterMember> {
    const organizationId = organizationOf(principal);
    const booking = await this.bookings.load(this.db, organizationId, bookingId);
    if (!booking) throw errors.protectedNotFound('booking');
    const found = await this.loadMember(this.db, organizationId, memberId);
    if (!found || found.booking_id !== bookingId) {
      throw errors.protectedNotFound('booking_roster_member');
    }
    const access = await this.access(
      principal,
      booking,
      EnrollmentActions.removeBookingRosterMember,
    );
    if (!access.staff && !access.booker) {
      // The member themselves, or someone who may register them (never through a staff role).
      const own =
        found.person_id !== null &&
        (
          await this.customers.subjectIds(principal, EnrollmentActions.removeBookingRosterMember)
        ).includes(found.person_id);
      if (!own) throw errors.protectedNotFound('booking');
    }
    const viewer = await this.viewer(principal, access);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const member = await this.loadMember(trx, organizationId, memberId, true);
      if (!member) throw errors.protectedNotFound('booking_roster_member');
      assertExpectedRevision(body.expectedRevision, member.revision);
      const removed = await this.removeRow(trx, principal, member, body.reason, now);
      const pending = await trx
        .selectFrom('booking_roster_invitations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('member_id', '=', member.id)
        .where('status', '=', 'pending')
        .forUpdate()
        .executeTakeFirst();
      if (pending) {
        const revoked = await trx
          .updateTable('booking_roster_invitations')
          .set({
            status: BookingRosterInvitationMachine.next(pending.status, 'revoke'),
            revoked_at: now,
            revoked_by: json(actorSnapshot(principal)),
            revocation_reason: body.reason,
            revision: pending.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', pending.id)
          .where('revision', '=', pending.revision)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.recordInvitationChange(trx, principal, revoked, 'revoked', {
          beforeRevision: pending.revision,
          reason: body.reason,
          correlationId,
        });
      }
      await this.recordChange(trx, principal, organizationId, booking, removed, 'removed', {
        reason: body.reason,
        correlationId,
        beforeRevision: member.revision,
        details: {},
      });
      return this.memberView(trx, organizationId, booking, removed, viewer);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private async access(
    principal: Principal,
    booking: BookingRow,
    action: ActionDefinition,
  ): Promise<Access> {
    const staff = await this.scope.actsAsStaff(
      principal,
      action,
      booking.organization_id,
      booking.facility_id,
    );
    const selfIds = principal.personId ? await this.customers.selfIds(principal) : [];
    return { staff, selfIds, booker: selfIds.includes(booking.booker_person_id) };
  }

  private async isJoinedMember(
    organizationId: string,
    bookingId: string,
    access: Access,
  ): Promise<boolean> {
    if (access.selfIds.length === 0) return false;
    const row = await this.db
      .selectFrom('booking_roster_members')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('booking_id', '=', bookingId)
      .where('person_id', 'in', access.selfIds)
      .where('status', '=', 'joined')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The reader of a roster: staff, and the people this person may act for as a customer. */
  private async viewer(principal: Principal, access: Access): Promise<Viewer> {
    const own = principal.personId
      ? await this.customers.subjectIds(principal, EnrollmentActions.manageBookingRoster)
      : [];
    return { staff: access.staff, ownIds: new Set([...access.selfIds, ...own]) };
  }

  /**
   * Whether the caller is who an invitation is for, and in what capacity they answer it.
   *
   * An invitation that names a person is for that person, or for somebody who holds registering
   * authority over them (the rule a registration uses; never a staff role). Its token is neither
   * needed nor enough: holding it never lets one person answer for another (security review M-1).
   * An invitation to a contact is for whoever holds its token. Anyone else gets the answer an
   * unknown invitation gets (§4.10).
   */
  private async recipientOf(
    principal: Principal,
    invitation: InvitationRow,
    token: string | undefined,
  ): Promise<Recipient> {
    const selfIds = principal.personId ? await this.customers.selfIds(principal) : [];
    const named = invitation.recipient_person_id;
    if (named === null) {
      if (!holdsToken(token, invitation.token_hash)) {
        throw errors.protectedNotFound('booking_roster_invitation');
      }
      return { invitation, selfIds, capacity: 'self' };
    }
    if (selfIds.includes(named)) return { invitation, selfIds, capacity: 'self' };
    const actsFor =
      !!principal.personId &&
      (
        await this.customers.subjectIds(principal, EnrollmentActions.acceptBookingRosterInvitation)
      ).includes(named);
    if (!actsFor) throw errors.protectedNotFound('booking_roster_invitation');
    return { invitation, selfIds, capacity: 'representative' };
  }

  /** Who joins on an acceptance, and whether the caller is that person or acts for them. */
  private joinerOf(
    recipient: Recipient,
    actorPersonId: string,
    requested: string | undefined,
  ): { joiner: string; capacity: 'self' | 'representative' } {
    const named = recipient.invitation.recipient_person_id;
    if (named !== null) {
      if (requested !== undefined && requested !== named) {
        throw errors.validation(
          'This invitation names one person, and only they join on it. Anyone else is added from the roster or invited.',
          { path: 'personId', code: 'ROSTER_INVITATION_NAMES_PERSON' },
        );
      }
      return { joiner: named, capacity: recipient.capacity };
    }
    const joiner = requested ?? actorPersonId;
    return {
      joiner,
      capacity: recipient.selfIds.includes(joiner) ? 'self' : 'representative',
    };
  }

  /** The booking under lock, refused unless it is a live rental. */
  private async rosterableBooking(
    trx: Trx,
    organizationId: string,
    bookingId: string,
  ): Promise<BookingRow> {
    const booking = await this.bookings.load(trx, organizationId, bookingId, true);
    if (!booking) throw errors.protectedNotFound('booking');
    if (booking.kind !== 'rental') {
      throw errors.validation('Only a rental booking has a group roster.', {
        code: 'ROSTER_RENTAL_ONLY',
      });
    }
    if (!LIVE_BOOKING.includes(booking.status)) {
      throw errors.validation('This booking has ended; its roster can no longer be added to.', {
        code: 'BOOKING_NOT_LIVE',
        status: booking.status,
      });
    }
    return booking;
  }

  private loadInvitation(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<InvitationRow | undefined> {
    let q = db
      .selectFrom('booking_roster_invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private loadMember(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<MemberRow | undefined> {
    let q = db
      .selectFrom('booking_roster_members')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async insertMember(
    trx: Trx,
    values: InsertObject<Database, 'booking_roster_members'>,
  ): Promise<MemberRow> {
    try {
      return await trx
        .insertInto('booking_roster_members')
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The database is the guarantee: one live roster row per booking and person or contact.
        throw errors.resourceConflict('This person is already on the roster or invited to it.', {
          code: 'ROSTER_MEMBER_EXISTS',
        });
      }
      throw error;
    }
  }

  private async removeRow(
    trx: Trx,
    principal: Principal,
    member: MemberRow,
    reason: string,
    now: Date,
  ): Promise<MemberRow> {
    return trx
      .updateTable('booking_roster_members')
      .set({
        status: BookingRosterMemberMachine.next(member.status, 'remove'),
        removed_at: now,
        removed_by: json(actorSnapshot(principal)),
        removal_reason: reason,
        revision: member.revision + 1,
      })
      .where('organization_id', '=', member.organization_id)
      .where('id', '=', member.id)
      .where('revision', '=', member.revision)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Declined, revoked or expired: the invitation closes and its invited roster row is removed. */
  private async closeInvitation(
    trx: Trx,
    principal: Principal,
    invitation: InvitationRow,
    next: InvitationRow['status'],
    now: Date,
    input: {
      set: Pick<
        UpdateObject<Database, 'booking_roster_invitations'>,
        'declined_at' | 'revoked_at' | 'revoked_by' | 'revocation_reason'
      >;
      memberReason: string;
      reason: string | null;
      correlationId: string | null;
    },
  ): Promise<BookingRosterInvitation> {
    const organizationId = invitation.organization_id;
    const closed = await trx
      .updateTable('booking_roster_invitations')
      .set({ ...input.set, status: next, revision: invitation.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', invitation.id)
      .where('revision', '=', invitation.revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.recordInvitationChange(trx, principal, closed, next, {
      beforeRevision: invitation.revision,
      reason: input.reason,
      correlationId: input.correlationId,
    });
    const member = await this.loadMember(trx, organizationId, invitation.member_id, true);
    if (member?.status === 'invited') {
      const removed = await this.removeRow(trx, principal, member, input.memberReason, now);
      const booking = await this.bookings.load(trx, organizationId, invitation.booking_id);
      if (booking) {
        await this.recordChange(trx, principal, organizationId, booking, removed, 'removed', {
          reason: input.memberReason,
          correlationId: input.correlationId,
          beforeRevision: member.revision,
          details: { invitationId: invitation.id, invitation: next },
        });
      }
    }
    return this.toInvitation(closed, now);
  }

  /**
   * A pending invitation past its expiry is recorded as expired, in its own transaction, before
   * the acceptance is refused (so the refusal does not roll the expiry back). Only a caller who
   * already passed the recipient check reaches this.
   */
  private async expireIfDue(
    principal: Principal,
    organizationId: string,
    invitationId: string,
    now: Date,
    correlationId: string | null,
  ): Promise<void> {
    await this.uow.run(async ({ trx }) => {
      const invitation = await this.loadInvitation(trx, organizationId, invitationId, true);
      if (!invitation || invitation.status !== 'pending') return;
      if (new Date(invitation.expires_at).getTime() > now.getTime()) return;
      const next = BookingRosterInvitationMachine.next(invitation.status, 'expire');
      await this.closeInvitation(trx, principal, invitation, next, now, {
        set: {},
        memberReason: 'The invitation expired.',
        reason: null,
        correlationId,
      });
    });
  }

  private async recordChange(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    booking: BookingRow,
    member: MemberRow,
    change: 'invited' | 'joined' | 'removed',
    input: {
      reason: string | null;
      correlationId: string | null;
      beforeRevision?: number;
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action:
        change === 'removed'
          ? EnrollmentActions.removeBookingRosterMember.id
          : EnrollmentActions.manageBookingRoster.id,
      targetType: 'booking_roster_member',
      targetId: member.id,
      beforeRevision: input.beforeRevision,
      afterRevision: member.revision,
      reason: input.reason,
      correlationId: input.correlationId,
      details: {
        bookingId: booking.id,
        personId: member.person_id,
        change,
        ...input.details,
      },
    });
    await this.outbox.enqueue(trx, EnrollmentRosterEvents.bookingRosterChanged, {
      organizationId,
      aggregateType: 'booking_roster_member',
      aggregateId: member.id,
      payload: {
        bookingId: booking.id,
        memberId: member.id,
        personId: member.person_id,
        change,
        revision: member.revision,
      },
      correlationId: input.correlationId,
    });
  }

  private async recordInvitationChange(
    trx: Trx,
    principal: Principal,
    invitation: InvitationRow,
    change: InvitationRow['status'],
    input: { beforeRevision: number; reason: string | null; correlationId: string | null },
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId: invitation.organization_id,
      actor: principal,
      action: `enrollment.booking_roster_invitation_${change}`,
      targetType: 'booking_roster_invitation',
      targetId: invitation.id,
      beforeRevision: input.beforeRevision,
      afterRevision: invitation.revision,
      reason: input.reason,
      correlationId: input.correlationId,
      details: { bookingId: invitation.booking_id, memberId: invitation.member_id },
    });
  }

  /**
   * An invitation as a renter reads it when staff invited somebody by name: the renter learns
   * that an invitation is out, not whom it names. The person's reference is kept for staff, for
   * the person and for whoever may act for them (security review M-1).
   */
  private withoutRecipient<T extends BookingRosterInvitation>(invitation: T, viewer: Viewer): T {
    const named = invitation.recipientPersonId;
    if (named === null || viewer.staff || viewer.ownIds.has(named)) return invitation;
    return { ...invitation, recipientPersonId: null };
  }

  private toInvitation(row: InvitationRow, now: Date): BookingRosterInvitation {
    return {
      id: row.id,
      bookingId: row.booking_id,
      memberId: row.member_id,
      recipientPersonId: row.recipient_person_id,
      recipientContact:
        row.recipient_contact_kind && row.recipient_contact_value
          ? { kind: row.recipient_contact_kind, value: row.recipient_contact_value }
          : null,
      message: row.message,
      status: effectiveStatus(row, now),
      expiresAt: iso(row.expires_at),
      acceptedAt: isoOrNull(row.accepted_at),
      declinedAt: isoOrNull(row.declined_at),
      revokedAt: isoOrNull(row.revoked_at),
      invitedByPersonId: row.invited_by_person_id,
      revision: row.revision,
      createdAt: iso(row.created_at),
    };
  }

  private async invitationView(
    organizationId: string,
    row: InvitationRow,
    booking: BookingRow,
  ): Promise<BookingRosterInvitationView> {
    const now = this.clock.now();
    const snapshot = await this.offerings.getOffering(organizationId, booking.offering_id, now);
    const zone = (await this.facilities.describe(organizationId, [booking.facility_id])).get(
      booking.facility_id,
    )?.timezone;
    const names = row.invited_by_person_id
      ? await this.persons.displayNames(organizationId, [row.invited_by_person_id])
      : new Map<string, { displayName: string }>();
    const waiversOn = await this.capabilities.isEnabled(organizationId, 'liability_waivers');
    return {
      ...this.toInvitation(row, now),
      booking: {
        id: booking.id,
        offeringName: snapshot?.offering.name ?? 'Rental',
        facilityId: booking.facility_id,
        timezone: zone ?? null,
        firstStart: iso(booking.first_start),
        lastEnd: iso(booking.last_end),
        occurrenceCount: Array.isArray(booking.occurrences) ? booking.occurrences.length : 1,
      },
      invitedByName: row.invited_by_person_id
        ? (names.get(row.invited_by_person_id)?.displayName ?? null)
        : null,
      requiredWaiverKeys: waiversOn ? (snapshot?.requiredWaiverKeys ?? []) : [],
    };
  }

  private async memberView(
    db: Reader,
    organizationId: string,
    booking: BookingRow,
    row: MemberRow,
    viewer: Viewer,
  ): Promise<BookingRosterMember> {
    const [member] = (await this.memberViews(db, organizationId, booking, [row], viewer)).members;
    if (!member) throw errors.internal('a roster member could not be shown');
    return member;
  }

  /**
   * The rows as readers see them: names from the person directory, the latest invitation behind
   * each row, and the waiver status for the rental offering's required waiver families from the
   * catalog policy port (the worst of them when several are required). Nothing is evaluated while
   * liability waivers are off or the offering requires none.
   *
   * A person's details are theirs until they join (security review M-1). A row that has never
   * joined (invited, or removed before joining) shows no display name and no waiver status to
   * anybody, and nothing is read about its person; its person reference is shown only to staff or
   * to a reader who may act for that person. The contact an invitation was sent to is shown: the
   * inviter typed it.
   */
  private async memberViews(
    db: Reader,
    organizationId: string,
    booking: BookingRow,
    rows: readonly MemberRow[],
    viewer: Viewer,
  ): Promise<{ members: BookingRosterMember[]; waiver: BookingRosterWaiverRequirement }> {
    const now = this.clock.now();
    const trx = db === this.db ? undefined : (db as Trx);
    const snapshot = await this.offerings.getOffering(
      organizationId,
      booking.offering_id,
      now,
      trx,
    );
    const keys = snapshot?.requiredWaiverKeys ?? [];
    const waiversOn = await this.capabilities.isEnabled(organizationId, 'liability_waivers', db);
    const waiver: BookingRosterWaiverRequirement = {
      state: !waiversOn ? 'capability_off' : keys.length === 0 ? 'not_required' : 'evaluated',
      policyKeys: waiversOn ? keys : [],
      blocksBooking: false,
    };
    // Only people who joined are looked up: their name, and their waiver while they are coming.
    const joinedOnce = rows.filter((r) => r.joined_at !== null && r.person_id !== null);
    const namedIds = [...new Set(joinedOnce.map((r) => r.person_id as string))];
    const personIds = [
      ...new Set(joinedOnce.filter((r) => r.status === 'joined').map((r) => r.person_id as string)),
    ];
    const statusOf = new Map<string, BookingRosterWaiverStatus>();
    if (waiver.state === 'evaluated') {
      for (const policyKey of keys) {
        const judged = await this.policies.waiverStatuses(
          organizationId,
          personIds,
          policyKey,
          now,
          trx,
        );
        for (const [personId, status] of judged) {
          const known = statusOf.get(personId) ?? 'not_evaluated';
          if (WAIVER_RANK[status.status] > WAIVER_RANK[known])
            statusOf.set(personId, status.status);
        }
      }
    }
    const names = await this.persons.displayNames(organizationId, namedIds, trx);
    const invitations =
      rows.length === 0
        ? []
        : await db
            .selectFrom('booking_roster_invitations')
            .select(['id', 'member_id', 'status', 'expires_at', 'created_at'])
            .where('organization_id', '=', organizationId)
            .where(
              'member_id',
              'in',
              rows.map((r) => r.id),
            )
            .orderBy('created_at')
            .orderBy('id')
            .execute();
    const latest = new Map(invitations.map((i) => [i.member_id, i]));
    const members = rows.map((row): BookingRosterMember => {
      const invitation = latest.get(row.id);
      const joined = row.joined_at !== null;
      const mayRefer =
        joined || viewer.staff || (row.person_id !== null && viewer.ownIds.has(row.person_id));
      return {
        id: row.id,
        bookingId: row.booking_id,
        personId: mayRefer ? row.person_id : null,
        displayName:
          joined && row.person_id ? (names.get(row.person_id)?.displayName ?? null) : null,
        invitedContact:
          row.person_id === null && row.invited_contact_kind && row.invited_contact_value
            ? { kind: row.invited_contact_kind, value: row.invited_contact_value }
            : null,
        status: row.status,
        // Only somebody who is coming is judged: an invited row has not joined, and a removed
        // row is history.
        waiverStatus:
          row.status === 'joined' && row.person_id !== null
            ? (statusOf.get(row.person_id) ?? 'not_evaluated')
            : 'not_evaluated',
        addedByPersonId: row.added_by_person_id,
        addedAt: iso(row.created_at),
        joinedAt: isoOrNull(row.joined_at),
        removedAt: isoOrNull(row.removed_at),
        removalReason: row.removal_reason,
        invitation: invitation
          ? {
              id: invitation.id,
              status: effectiveStatus(invitation, now),
              expiresAt: iso(invitation.expires_at),
            }
          : null,
        revision: row.revision,
      };
    });
    return { members, waiver };
  }
}

/** A pending invitation past its expiry reads as expired, whether or not that is recorded yet. */
function effectiveStatus(
  row: { status: InvitationRow['status']; expires_at: Date | string },
  now: Date,
): InvitationRow['status'] {
  return row.status === 'pending' && new Date(row.expires_at).getTime() <= now.getTime()
    ? 'expired'
    : row.status;
}

/** The one answer to a renter who names a person they may not name, whoever that is (§4.10). */
function inviteByContact(): Error {
  return errors.validation(
    'You can name yourself or someone you register for. Invite anyone else by their email address or phone number, so they answer for themselves.',
    { path: 'recipientPersonId', code: 'ROSTER_INVITE_BY_CONTACT' },
  );
}

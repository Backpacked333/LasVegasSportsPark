import { createHash, randomBytes } from 'node:crypto';
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

interface Access {
  staff: boolean;
  booker: boolean;
  selfIds: string[];
}

/**
 * Rental-group rosters (SPK-COND-005, proposed amendment PA-09; capability `rental_rosters`,
 * DEC-103). Proposed: built ahead of the decision and off until an organization turns it on.
 *
 * A rental booking may have a roster: the people the renter brings. The renter or staff add and
 * invite people; an invited person joins for themselves (or, on a contact invitation, for their
 * child); a member may add their own child. Staff and the renter read the roster with each
 * member's liability waiver status for the rental offering's required waiver, judged by the
 * catalog (`PolicyPort.waiverStatuses`), or `not_evaluated` while liability waivers are off.
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
    const { members, waiver } = await this.memberViews(this.db, organizationId, booking, rows);
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
   * One invitation as the invited person sees it. Readable by the person it names, by whoever
   * holds its token, by the renter and by staff at the facility; nobody else learns it exists.
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
    const invited =
      (row.recipient_person_id !== null && access.selfIds.includes(row.recipient_person_id)) ||
      (token !== undefined && hashToken(token) === row.token_hash);
    if (!invited && !access.staff && !access.booker) {
      throw errors.protectedNotFound('booking_roster_invitation');
    }
    return this.invitationView(organizationId, row, booking);
  }

  /** The open invitations that name the signed-in person. */
  async myInvitations(principal: Principal): Promise<BookingRosterInvitationView[]> {
    const organizationId = organizationOf(principal);
    if (!principal.personId) return [];
    const selfIds = await this.customers.selfIds(principal);
    const now = this.clock.now();
    const rows = await this.db
      .selectFrom('booking_roster_invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('recipient_person_id', 'in', selfIds)
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
      const decision = await this.authorization.decide(
        principal,
        EnrollmentActions.manageBookingRoster,
        { type: 'booking_roster', organizationId, subjectPersonIds: [body.personId] },
      );
      if (!decision.allowed) {
        throw errors.validation(
          'You can add yourself or someone you register for. Invite anyone else, so they answer for themselves.',
          { path: 'personId', code: 'ROSTER_INVITATION_REQUIRED' },
        );
      }
    }
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
      return this.memberView(trx, organizationId, booking, row);
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
          throw errors.notFound('person', body.recipientPersonId);
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
   * The invited person joins. An invitation that names a person is accepted by that person, for
   * themselves (signing in proves who they are; the token is not needed). An invitation to a
   * contact is accepted by whoever holds its token, for themselves or for someone they may
   * register (their child).
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
    const { selfIds } = await this.recipientCheck(principal, organizationId, invitationId, body);
    const joiner = body.personId ?? actorPersonId;
    const found = await this.loadInvitation(this.db, organizationId, invitationId);
    if (!found) throw errors.protectedNotFound('booking_roster_invitation');
    if (found.recipient_person_id) {
      if (!selfIds.includes(joiner)) {
        throw errors.validation(
          'This invitation names you. Join first; then add your child from the roster.',
          { path: 'personId', code: 'ROSTER_INVITATION_NAMES_PERSON' },
        );
      }
    } else {
      // Self, or a person the caller may register: the same authority a registration needs.
      await this.authorization.require(principal, EnrollmentActions.acceptBookingRosterInvitation, {
        type: 'booking_roster_invitation',
        id: invitationId,
        organizationId,
        subjectPersonIds: [joiner],
        protected: true,
      });
    }
    const now = this.clock.now();
    await this.expireIfDue(principal, organizationId, invitationId, now, correlationId);
    return this.uow.run(async ({ trx }) => {
      await this.capabilities.require(organizationId, 'rental_rosters', trx);
      const invitation = await this.loadInvitation(trx, organizationId, invitationId, true);
      if (!invitation) throw errors.protectedNotFound('booking_roster_invitation');
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
            person_id: member.person_id ?? person.id,
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
          accepted_by_person_id: actorPersonId,
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
        details: { invitationId: invitation.id },
      });
      return {
        invitation: this.toInvitation(accepted, now),
        member: await this.memberView(trx, organizationId, booking, joined),
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
    await this.recipientCheck(principal, organizationId, invitationId, body);
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
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
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
      const own =
        found.person_id !== null &&
        (
          await this.authorization.decide(principal, EnrollmentActions.removeBookingRosterMember, {
            type: 'booking_roster_member',
            organizationId,
            subjectPersonIds: [found.person_id],
          })
        ).allowed;
      if (!own) throw errors.protectedNotFound('booking');
    }
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
      return this.memberView(trx, organizationId, booking, removed);
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

  /**
   * Whether the caller is the person an invitation is for: the person it names, or the holder of
   * its token. Anyone else gets the answer an unknown invitation gets (§4.10).
   */
  private async recipientCheck(
    principal: Principal,
    organizationId: string,
    invitationId: string,
    body: { token?: string },
  ): Promise<{ selfIds: string[] }> {
    const invitation = await this.loadInvitation(this.db, organizationId, invitationId);
    if (!invitation) throw errors.protectedNotFound('booking_roster_invitation');
    const selfIds = principal.personId ? await this.customers.selfIds(principal) : [];
    const named =
      invitation.recipient_person_id !== null && selfIds.includes(invitation.recipient_person_id);
    const holdsToken = body.token !== undefined && hashToken(body.token) === invitation.token_hash;
    if (!named && !holdsToken) throw errors.protectedNotFound('booking_roster_invitation');
    return { selfIds };
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
  ): Promise<BookingRosterMember> {
    const [member] = (await this.memberViews(db, organizationId, booking, [row])).members;
    if (!member) throw errors.internal('a roster member could not be shown');
    return member;
  }

  /**
   * The rows as readers see them: names from the person directory, the latest invitation behind
   * each row, and the waiver status for the rental offering's required waiver families from the
   * catalog policy port (the worst of them when several are required). Nothing is evaluated while
   * liability waivers are off or the offering requires none.
   */
  private async memberViews(
    db: Reader,
    organizationId: string,
    booking: BookingRow,
    rows: readonly MemberRow[],
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
    const personIds = [...new Set(rows.map((r) => r.person_id).filter((id) => id !== null))];
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
    const names = await this.persons.displayNames(organizationId, personIds, trx);
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
      return {
        id: row.id,
        bookingId: row.booking_id,
        personId: row.person_id,
        displayName: row.person_id ? (names.get(row.person_id)?.displayName ?? null) : null,
        invitedContact:
          row.person_id === null && row.invited_contact_kind && row.invited_contact_value
            ? { kind: row.invited_contact_kind, value: row.invited_contact_value }
            : null,
        status: row.status,
        // A removed row is no longer judged: it is history, not somebody who is coming.
        waiverStatus:
          row.status === 'removed' || row.person_id === null
            ? 'not_evaluated'
            : (statusOf.get(row.person_id) ?? 'not_evaluated'),
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

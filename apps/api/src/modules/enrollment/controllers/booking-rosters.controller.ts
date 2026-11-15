import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AcceptBookingRosterInvitationBody,
  AddBookingRosterMemberBody,
  CreateBookingRosterInvitationBody,
  DeclineBookingRosterInvitationBody,
  OpenBookingRosterInvitationBody,
  RemoveBookingRosterMemberBody,
  RevokeBookingRosterInvitationBody,
  z,
  type BookingRoster,
  type BookingRosterInvitation,
  type BookingRosterInvitationAccepted,
  type BookingRosterInvitationIssued,
  type BookingRosterInvitationView,
  type BookingRosterMember,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  RateLimited,
  ZodBody,
  ZodParams,
} from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { BookingRostersService } from '../services/booking-rosters.service';

const IdParams = z.object({ id: z.uuid() });
const MemberParams = z.object({ id: z.uuid(), memberId: z.uuid() });

/** A roster is a list of names beside a booking: it is no §5.3 record category of any system. */
const NOT_A_RECORD = 'A rental roster row is not a §5.3 record category';

/**
 * Rental-group rosters (SPK-COND-005, proposed amendment PA-09; capability `rental_rosters`,
 * DEC-103). Adding, inviting and accepting need the capability; reading, declining, revoking and
 * removing never do.
 */
@Controller()
export class BookingRostersController {
  constructor(private readonly rosters: BookingRostersService) {}

  @Get('bookings/:id/roster')
  roster(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<BookingRoster> {
    return this.rosters.roster(principal, params.id);
  }

  @Post('bookings/:id/roster')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  add(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AddBookingRosterMemberBody) body: z.infer<typeof AddBookingRosterMemberBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<BookingRosterMember> {
    return this.rosters.addMember(principal, params.id, body, correlationId);
  }

  @Post('bookings/:id/roster/invitations')
  // §4.14: the invitation token is stored only as a hash; never keep it with the idempotency key.
  @Idempotent({ withhold: ['token'] })
  @NoRecordAuthority(NOT_A_RECORD)
  invite(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateBookingRosterInvitationBody)
    body: z.infer<typeof CreateBookingRosterInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<BookingRosterInvitationIssued> {
    return this.rosters.invite(principal, params.id, body, correlationId);
  }

  @Post('bookings/:id/roster/members/:memberId/remove')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  remove(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(MemberParams) params: z.infer<typeof MemberParams>,
    @ZodBody(RemoveBookingRosterMemberBody) body: z.infer<typeof RemoveBookingRosterMemberBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<BookingRosterMember> {
    return this.rosters.removeMember(principal, params.id, params.memberId, body, correlationId);
  }

  @Get('me/booking-roster-invitations')
  mine(@CurrentPrincipal() principal: Principal): Promise<BookingRosterInvitationView[]> {
    return this.rosters.myInvitations(principal);
  }

  /** Without a token: the person the invitation names, someone who acts for them, renter, staff. */
  @Get('booking-roster-invitations/:id')
  invitation(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<BookingRosterInvitationView> {
    return this.rosters.invitation(principal, params.id, undefined);
  }

  /**
   * The same read for the holder of a contact invitation's token. The token travels in the body,
   * never in the address, so it reaches no access log, proxy log or history (§4.14; security
   * review L-1). A pure read: nothing changes, so no idempotency key is required.
   */
  @Post('booking-roster-invitations/:id/open')
  // §4.14: the token-bearing routes share the invitations limit per address, as account invitations.
  @RateLimited('invitations')
  @HttpCode(200)
  @NoRecordAuthority('Reading a roster invitation changes no record')
  open(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OpenBookingRosterInvitationBody) body: z.infer<typeof OpenBookingRosterInvitationBody>,
  ): Promise<BookingRosterInvitationView> {
    return this.rosters.invitation(principal, params.id, body.token);
  }

  @Post('booking-roster-invitations/:id/accept')
  @RateLimited('invitations')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AcceptBookingRosterInvitationBody)
    body: z.infer<typeof AcceptBookingRosterInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<BookingRosterInvitationAccepted> {
    return this.rosters.accept(principal, params.id, body, correlationId);
  }

  @Post('booking-roster-invitations/:id/decline')
  @RateLimited('invitations')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  decline(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DeclineBookingRosterInvitationBody)
    body: z.infer<typeof DeclineBookingRosterInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<BookingRosterInvitation> {
    return this.rosters.decline(principal, params.id, body, correlationId);
  }

  @Post('booking-roster-invitations/:id/revoke')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  revoke(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RevokeBookingRosterInvitationBody)
    body: z.infer<typeof RevokeBookingRosterInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<BookingRosterInvitation> {
    return this.rosters.revoke(principal, params.id, body, correlationId);
  }
}

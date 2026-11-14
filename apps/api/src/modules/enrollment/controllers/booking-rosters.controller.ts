import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AcceptBookingRosterInvitationBody,
  AddBookingRosterMemberBody,
  BookingRosterInvitationQuery,
  CreateBookingRosterInvitationBody,
  DeclineBookingRosterInvitationBody,
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
  ZodBody,
  ZodParams,
  ZodQuery,
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
  @Idempotent()
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

  @Get('booking-roster-invitations/:id')
  invitation(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(BookingRosterInvitationQuery) query: BookingRosterInvitationQuery,
  ): Promise<BookingRosterInvitationView> {
    return this.rosters.invitation(principal, params.id, query.token);
  }

  @Post('booking-roster-invitations/:id/accept')
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

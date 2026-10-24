import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AcceptTeamInvitationBody,
  ChangeRosterBody,
  CreateJoinRequestBody,
  CreateTeamInvitationBody,
  DecideJoinRequestBody,
  EligibilityQuery,
  RevokeTeamInvitationBody,
  RosterQuery,
  z,
  type EligibilityEvaluation,
  type JoinRequest,
  type JoinRequestDecided,
  type Principal,
  type RosterResponse,
  type TeamInvitation,
  type TeamInvitationAccepted,
  type TeamInvitationIssued,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { RosterService } from '../services/roster.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Rosters with effective dates (SPK-COMP-005), eligibility explanations (SPK-CAP-004),
 * invitations (§4.8 POST /team-entries/{id}/invitations) and join requests (SPK-CAP-001).
 */
@Controller()
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  @Get('team-entries/:id/roster')
  listRoster(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(RosterQuery) query: z.infer<typeof RosterQuery>,
  ): Promise<RosterResponse> {
    return this.roster.listRoster(principal, params.id, query);
  }

  @Post('team-entries/:id/roster')
  @HttpCode(200)
  @Idempotent()
  changeRoster(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ChangeRosterBody) body: z.infer<typeof ChangeRosterBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<RosterResponse> {
    return this.roster.changeRoster(principal, params.id, body, correlationId);
  }

  @Get('team-entries/:id/eligibility')
  explainEligibility(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(EligibilityQuery) query: z.infer<typeof EligibilityQuery>,
  ): Promise<EligibilityEvaluation> {
    return this.roster.explainEligibility(principal, params.id, query);
  }

  @Post('team-entries/:id/invitations')
  @Idempotent()
  invite(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateTeamInvitationBody) body: z.infer<typeof CreateTeamInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamInvitationIssued> {
    return this.roster.invite(principal, params.id, body, correlationId);
  }

  @Post('team-invitations/:id/accept')
  @HttpCode(200)
  @Idempotent()
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AcceptTeamInvitationBody) body: z.infer<typeof AcceptTeamInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamInvitationAccepted> {
    return this.roster.accept(principal, params.id, body, correlationId);
  }

  @Post('team-invitations/:id/revoke')
  @HttpCode(200)
  @Idempotent()
  revoke(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RevokeTeamInvitationBody) body: z.infer<typeof RevokeTeamInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamInvitation> {
    return this.roster.revoke(principal, params.id, body, correlationId);
  }

  @Post('team-entries/:id/join-requests')
  @Idempotent()
  requestToJoin(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateJoinRequestBody) body: z.infer<typeof CreateJoinRequestBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<JoinRequest> {
    return this.roster.requestToJoin(principal, params.id, body, correlationId);
  }

  @Post('join-requests/:id/decide')
  @HttpCode(200)
  @Idempotent()
  decide(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DecideJoinRequestBody) body: z.infer<typeof DecideJoinRequestBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<JoinRequestDecided> {
    return this.roster.decide(principal, params.id, body, correlationId);
  }
}

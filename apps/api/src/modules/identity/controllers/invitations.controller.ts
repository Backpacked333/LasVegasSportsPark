import { Controller, HttpCode, Post } from '@nestjs/common';
import {
  AcceptInvitationBody,
  CreateInvitationBody,
  RevokeInvitationBody,
  z,
  type Invitation,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { InvitationsService, type InvitationAccepted } from '../services/invitations.service';

const IdParams = z.object({ id: z.uuid() });

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateInvitationBody) body: z.infer<typeof CreateInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Invitation & { token: string }> {
    return this.invitations.create(principal, body, correlationId);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @Idempotent()
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AcceptInvitationBody) body: z.infer<typeof AcceptInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<InvitationAccepted> {
    return this.invitations.accept(principal, params.id, body.token, correlationId);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @Idempotent()
  revoke(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RevokeInvitationBody) body: z.infer<typeof RevokeInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Invitation> {
    return this.invitations.revoke(principal, params.id, body, correlationId);
  }
}

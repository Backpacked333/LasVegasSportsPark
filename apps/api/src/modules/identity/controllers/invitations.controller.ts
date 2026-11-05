import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AcceptInvitationBody,
  CreateInvitationBody,
  DeclineInvitationBody,
  ListInvitationsQuery,
  RevokeInvitationBody,
  z,
  type Invitation,
  type InvitationView,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  RecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { InvitationsService, type InvitationAccepted } from '../services/invitations.service';

const IdParams = z.object({ id: z.uuid() });

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  // §4.14: the invitation token is stored only as a hash; never keep it with the idempotency key.
  @Idempotent({ withhold: ['token'] })
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

  /** ID-03: classified for §5.6 like accept and revoke (relationship evidence, unproven). */
  @Post(':id/decline')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('relationship_evidence')
  decline(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DeclineInvitationBody) body: z.infer<typeof DeclineInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Invitation> {
    return this.invitations.decline(principal, params.id, body, correlationId);
  }

  /** GET /v1/invitations (ID-03): staff list (identity.read_invitations). */
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListInvitationsQuery) query: z.infer<typeof ListInvitationsQuery>,
  ): Promise<Page<InvitationView>> {
    return this.invitations.listForStaff(principal, query);
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

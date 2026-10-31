import { Controller, Get } from '@nestjs/common';
import {
  ListMyAccessGrantsQuery,
  ListMyInvitationsQuery,
  z,
  type GrantView,
  type InvitationView,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, ZodParams, ZodQuery } from '../../../kernel';
import { AuthorityReadsService } from '../services/authority-reads.service';
import { InvitationsService } from '../services/invitations.service';

const IdParams = z.object({ id: z.uuid() });

/** The signed-in person's own identity reads (ID-03, ID-04; SPK-IAM-001/003/004/006). */
@Controller('me')
export class MeController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly reads: AuthorityReadsService,
  ) {}

  @Get('invitations')
  listInvitations(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyInvitationsQuery) query: z.infer<typeof ListMyInvitationsQuery>,
  ): Promise<Page<InvitationView>> {
    return this.invitations.listMine(principal, query);
  }

  @Get('invitations/:id')
  getInvitation(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<InvitationView> {
    return this.invitations.getMine(principal, params.id);
  }

  @Get('access-grants')
  accessGrants(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyAccessGrantsQuery) query: z.infer<typeof ListMyAccessGrantsQuery>,
  ): Promise<Page<GrantView>> {
    return this.reads.myAccessGrants(principal, query);
  }

  @Get('households')
  async households(@CurrentPrincipal() principal: Principal) {
    return { items: await this.reads.myHouseholds(principal) };
  }
}

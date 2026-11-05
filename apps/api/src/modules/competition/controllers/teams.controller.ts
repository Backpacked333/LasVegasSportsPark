import { Controller, Get, Patch } from '@nestjs/common';
import { UpdateTeamBody, z, type Principal, type Team } from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { TeamsService } from '../services/teams.service';

const IdParams = z.object({ id: z.uuid() });

/** The continuing team identity (§4.5); created together with its first season entry. */
@Controller()
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get('teams/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Team> {
    return this.teams.get(principal, params.id);
  }

  @Patch('teams/:id')
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateTeamBody) body: z.infer<typeof UpdateTeamBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Team> {
    return this.teams.update(principal, params.id, body, correlationId);
  }
}

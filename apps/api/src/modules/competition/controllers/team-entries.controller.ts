import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApproveTeamEntryBody,
  CreateTeamEntryBody,
  ListTeamEntriesQuery,
  RejectTeamEntryBody,
  WithdrawTeamEntryBody,
  z,
  type Principal,
  type TeamEntry,
  type TeamEntryCreated,
  type TeamEntryWorkspace,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { TeamEntriesService } from '../services/team-entries.service';

const IdParams = z.object({ id: z.uuid() });

/** Season team entries (SPK-COMP-004, SPK-CAP-001, SPK-CAP-005) and the captain workspace. */
@Controller()
export class TeamEntriesController {
  constructor(private readonly entries: TeamEntriesService) {}

  /** Create a new team's entry, enter an existing team (staff) or renew a prior entry (SPK-AT-003). */
  @Post('team-entries')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateTeamEntryBody) body: z.infer<typeof CreateTeamEntryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamEntryCreated> {
    return this.entries.create(principal, body, correlationId);
  }

  @Get('team-entries')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListTeamEntriesQuery) query: z.infer<typeof ListTeamEntriesQuery>,
  ): Promise<TeamEntry[]> {
    return this.entries.list(principal, query);
  }

  /** Captain workspace: readiness, roster, pending requests, upcoming fixtures (SPK-CAP-001/002). */
  @Get('team-entries/:id')
  getWorkspace(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<TeamEntryWorkspace> {
    return this.entries.getWorkspace(principal, params.id);
  }

  @Post('team-entries/:id/approve')
  @HttpCode(200)
  @Idempotent()
  approve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ApproveTeamEntryBody) body: z.infer<typeof ApproveTeamEntryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamEntry> {
    return this.entries.approve(principal, params.id, body, correlationId);
  }

  @Post('team-entries/:id/reject')
  @HttpCode(200)
  @Idempotent()
  reject(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RejectTeamEntryBody) body: z.infer<typeof RejectTeamEntryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamEntry> {
    return this.entries.reject(principal, params.id, body, correlationId);
  }

  @Post('team-entries/:id/withdraw')
  @HttpCode(200)
  @Idempotent()
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawTeamEntryBody) body: z.infer<typeof WithdrawTeamEntryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamEntry> {
    return this.entries.withdraw(principal, params.id, body, correlationId);
  }
}

import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateAvailabilityRequestBody,
  DeclineTeamInvitationBody,
  HandoverTeamRoleBody,
  ListAvailabilityRequestsQuery,
  ListMyTeamInvitationsQuery,
  MyFixturesQuery,
  MyTeamEntriesQuery,
  z,
  type AvailabilityRequest,
  type FixtureDetail,
  type MatchSheet,
  type MyTeamEntry,
  type Page,
  type Principal,
  type TeamInvitationView,
  type TeamRoleHandover,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  RecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { AvailabilityRequestsService } from '../services/availability-requests.service';
import { MatchSheetService } from '../services/match-sheet.service';
import { MyCompetitionService } from '../services/my-competition.service';
import { RosterService } from '../services/roster.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Stage-3 team workspace reads and commands: my teams and fixtures (CMP-02), team invitation
 * reads and decline (CMP-03), role handover (CMP-13), availability requests (CMP-14) and the
 * field-limited match sheet (CMP-06).
 */
@Controller()
export class TeamWorkspaceController {
  constructor(
    private readonly mine: MyCompetitionService,
    private readonly roster: RosterService,
    private readonly requests: AvailabilityRequestsService,
    private readonly matchSheets: MatchSheetService,
  ) {}

  /** SPK-CAP-001, SCR-C-21: the teams I and the people I may view are on, with the next fixture. */
  @Get('me/team-entries')
  myTeamEntries(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(MyTeamEntriesQuery) query: z.infer<typeof MyTeamEntriesQuery>,
  ): Promise<MyTeamEntry[]> {
    return this.mine.teamEntries(principal, query);
  }

  /** SCR-C-04: fixtures of those teams in a window of at most 120 days. */
  @Get('me/fixtures')
  myFixtures(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(MyFixturesQuery) query: z.infer<typeof MyFixturesQuery>,
  ): Promise<FixtureDetail[]> {
    return this.mine.fixturesOf(principal, query);
  }

  @Get('me/team-invitations')
  myTeamInvitations(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyTeamInvitationsQuery) query: z.infer<typeof ListMyTeamInvitationsQuery>,
  ): Promise<Page<TeamInvitationView>> {
    return this.roster.listMyInvitations(principal, query);
  }

  @Get('team-invitations/:id')
  getTeamInvitation(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<TeamInvitationView> {
    return this.roster.getInvitation(principal, params.id);
  }

  @Post('team-invitations/:id/decline')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('roster')
  declineTeamInvitation(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DeclineTeamInvitationBody) body: z.infer<typeof DeclineTeamInvitationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamInvitationView> {
    return this.roster.decline(principal, params.id, body, correlationId);
  }

  @Post('team-entries/:id/roles/handover')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('roster')
  handoverRole(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(HandoverTeamRoleBody) body: z.infer<typeof HandoverTeamRoleBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamRoleHandover> {
    return this.roster.handoverRole(principal, params.id, body, correlationId);
  }

  @Post('fixtures/:id/availability-requests')
  @Idempotent()
  @NoRecordAuthority('Not a §5.3 record category')
  requestAvailability(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateAvailabilityRequestBody) body: z.infer<typeof CreateAvailabilityRequestBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AvailabilityRequest> {
    return this.requests.request(principal, params.id, body, correlationId);
  }

  @Get('fixtures/:id/availability-requests')
  listAvailabilityRequests(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(ListAvailabilityRequestsQuery) query: z.infer<typeof ListAvailabilityRequestsQuery>,
  ): Promise<AvailabilityRequest[]> {
    return this.requests.list(principal, params.id, query);
  }

  @Get('fixtures/:id/match-sheet')
  matchSheet(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<MatchSheet> {
    return this.matchSheets.get(principal, params.id);
  }
}

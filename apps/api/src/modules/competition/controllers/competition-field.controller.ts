import { Controller, Get, Post } from '@nestjs/common';
import {
  CreateResultReminderBody,
  ListPlayerProfilesQuery,
  RecordFixtureAttendanceBody,
  RecordPlayerProfileBody,
  z,
  type FixtureAttendance,
  type FixtureAttendanceMark,
  type PlayerProfile,
  type Principal,
  type ResultReminder,
  type ResultsAwaiting,
  type SeasonPlayerProfiles,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { FixtureAttendanceService } from '../services/fixture-attendance.service';
import { PlayerProfilesService } from '../services/player-profiles.service';
import { ResultsAwaitingService } from '../services/results-awaiting.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Placement and field-side work (migrations 0464 to 0466): staff player profiles and team balance
 * for the placement board (SPK-PLACE-002), player check-in on the match sheet (SPK-UX-007,
 * SPK-STAFF-005), and results waiting after the game with reminders to captains
 * (SPK-RESULT-001, SPK-UX-006).
 */
@Controller()
export class CompetitionFieldController {
  constructor(
    private readonly profiles: PlayerProfilesService,
    private readonly attendance: FixtureAttendanceService,
    private readonly awaiting: ResultsAwaitingService,
  ) {}

  @Get('seasons/:id/player-profiles')
  listPlayerProfiles(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(ListPlayerProfilesQuery) query: z.infer<typeof ListPlayerProfilesQuery>,
  ): Promise<SeasonPlayerProfiles> {
    return this.profiles.list(principal, params.id, query);
  }

  @Post('seasons/:id/player-profiles')
  @Idempotent()
  @NoRecordAuthority('Staff placement assessment, not a §5.3 record category')
  recordPlayerProfile(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RecordPlayerProfileBody) body: z.infer<typeof RecordPlayerProfileBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PlayerProfile> {
    return this.profiles.record(principal, params.id, body, correlationId);
  }

  @Get('fixtures/:id/attendance')
  getAttendance(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<FixtureAttendance> {
    return this.attendance.get(principal, params.id);
  }

  @Post('fixtures/:id/attendance')
  @Idempotent()
  @NoRecordAuthority('Field check-in observation, not a §5.3 record category')
  recordAttendance(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RecordFixtureAttendanceBody) body: z.infer<typeof RecordFixtureAttendanceBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<FixtureAttendanceMark> {
    return this.attendance.record(principal, params.id, body, correlationId);
  }

  @Get('seasons/:id/results-awaiting')
  resultsAwaiting(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<ResultsAwaiting> {
    return this.awaiting.list(principal, params.id);
  }

  @Post('fixtures/:id/result-reminders')
  @Idempotent()
  @NoRecordAuthority('A reminder to captains, not a §5.3 record category')
  remindResult(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateResultReminderBody) body: z.infer<typeof CreateResultReminderBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ResultReminder> {
    return this.awaiting.remind(principal, params.id, body, correlationId);
  }
}

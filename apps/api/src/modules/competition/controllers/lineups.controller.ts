import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  RecordGameLogBody,
  SaveLineupBody,
  ShareLineupBody,
  TeamSheetQuery,
  z,
  type FixtureGameLogs,
  type GameLog,
  type Lineup,
  type Principal,
  type TeamSheet,
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
import { LineupsService } from '../services/lineups.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * The coach's team sheet (migration 0475; SPK-CAP-001, SPK-CAP-003, SPK-UX-007, SPK-RESULT-001):
 * players with answers and season minutes, the lineup and its share, the side's game log, and the
 * game log scores for the official's match check.
 */
@Controller()
export class LineupsController {
  constructor(private readonly lineups: LineupsService) {}

  @Get('fixtures/:id/lineup')
  teamSheet(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(TeamSheetQuery) query: z.infer<typeof TeamSheetQuery>,
  ): Promise<TeamSheet> {
    return this.lineups.teamSheet(principal, params.id, query);
  }

  @Post('fixtures/:id/lineup')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('A side’s lineup for one game, not a §5.3 record category')
  saveLineup(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(SaveLineupBody) body: z.infer<typeof SaveLineupBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Lineup> {
    return this.lineups.saveLineup(principal, params.id, body, correlationId);
  }

  @Post('fixtures/:id/lineup/share')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('A side’s lineup for one game, not a §5.3 record category')
  shareLineup(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ShareLineupBody) body: z.infer<typeof ShareLineupBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Lineup> {
    return this.lineups.shareLineup(principal, params.id, body, correlationId);
  }

  @Post('fixtures/:id/game-log')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('The side’s own game notes; the result stays the official report')
  recordGameLog(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RecordGameLogBody) body: z.infer<typeof RecordGameLogBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<GameLog> {
    return this.lineups.recordGameLog(principal, params.id, body, correlationId);
  }

  @Get('fixtures/:id/game-logs')
  gameLogs(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<FixtureGameLogs> {
    return this.lineups.gameLogs(principal, params.id);
  }
}

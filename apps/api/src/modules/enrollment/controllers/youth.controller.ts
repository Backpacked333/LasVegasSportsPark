import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ConvertTrialBody,
  CreateTrialBody,
  FamilyCalendarQuery,
  IssueMakeupBody,
  ListMakeupEntitlementsQuery,
  RecordTrialOutcomeBody,
  RedeemMakeupBody,
  RevokeMakeupBody,
  z,
  type FamilyCalendar,
  type MakeupEntitlement,
  type Principal,
  type SessionBooking,
  type TrialConversion,
  type TrialParticipation,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { FamilyCalendarService } from '../services/family-calendar.service';
import { MakeupsService } from '../services/makeups.service';
import { TrialsService } from '../services/trials.service';

const IdParams = z.object({ id: z.uuid() });

/** Youth programs: makeups, trials and the family calendar (SPK-YOUTH-003/004/007). */
@Controller()
export class YouthController {
  constructor(
    private readonly makeups: MakeupsService,
    private readonly trials: TrialsService,
    private readonly calendar: FamilyCalendarService,
  ) {}

  @Post('makeup-entitlements')
  @Idempotent()
  issueMakeup(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(IssueMakeupBody) body: z.infer<typeof IssueMakeupBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MakeupEntitlement> {
    return this.makeups.issue(principal, body, correlationId);
  }

  @Get('makeup-entitlements')
  listMakeups(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMakeupEntitlementsQuery) query: ListMakeupEntitlementsQuery,
  ): Promise<MakeupEntitlement[]> {
    return this.makeups.list(principal, query);
  }

  @Get('makeup-entitlements/:id')
  getMakeup(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<MakeupEntitlement> {
    return this.makeups.get(principal, params.id);
  }

  @Post('makeup-entitlements/:id/redeem')
  @Idempotent()
  redeemMakeup(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RedeemMakeupBody) body: z.infer<typeof RedeemMakeupBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<SessionBooking> {
    return this.makeups.redeem(principal, params.id, body, correlationId);
  }

  @Post('makeup-entitlements/:id/revoke')
  @HttpCode(200)
  @Idempotent()
  revokeMakeup(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RevokeMakeupBody) body: z.infer<typeof RevokeMakeupBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MakeupEntitlement> {
    return this.makeups.revoke(principal, params.id, body, correlationId);
  }

  @Post('trial-participations')
  @Idempotent()
  createTrial(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateTrialBody) body: z.infer<typeof CreateTrialBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TrialParticipation> {
    return this.trials.create(principal, body, correlationId);
  }

  @Get('trial-participations/:id')
  getTrial(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<TrialParticipation> {
    return this.trials.get(principal, params.id);
  }

  @Post('trial-participations/:id/outcome')
  @HttpCode(200)
  @Idempotent()
  trialOutcome(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RecordTrialOutcomeBody) body: z.infer<typeof RecordTrialOutcomeBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TrialParticipation> {
    return this.trials.recordOutcome(principal, params.id, body, correlationId);
  }

  @Post('trial-participations/:id/convert')
  @Idempotent()
  convertTrial(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ConvertTrialBody) body: z.infer<typeof ConvertTrialBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TrialConversion> {
    return this.trials.convert(principal, params.id, body, correlationId);
  }

  @Get('me/family-calendar')
  familyCalendar(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(FamilyCalendarQuery) query: FamilyCalendarQuery,
  ): Promise<FamilyCalendar> {
    return this.calendar.get(principal, query);
  }
}

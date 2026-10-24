import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateSessionCheckinBody,
  IssuePassBody,
  ListVisitsQuery,
  RecheckSessionCheckinBody,
  RecordDepartureBody,
  RecordVisitsBody,
  RevokePassBody,
  ScanPassBody,
  VoidVisitBody,
  WithdrawSessionCheckinBody,
  z,
  type Departure,
  type IssuedPass,
  type Page,
  type Pass,
  type PassScan,
  type Principal,
  type RecordedVisits,
  type SessionCheckin,
  type Visit,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CheckinsService } from '../services/checkins.service';
import { PassesService } from '../services/passes.service';
import { VisitsService } from '../services/visits.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Passes (SPK-ENTRY-002, SPK-ENTRY-003). */
@Controller('passes')
export class PassesController {
  constructor(private readonly passes: PassesService) {}

  @Post()
  @Idempotent()
  issue(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(IssuePassBody) body: IssuePassBody,
    @CorrelationId() correlationId: string,
  ): Promise<IssuedPass> {
    return this.passes.issue(principal, body, correlationId);
  }

  /** A scan writes nothing but its audit record, so it needs no idempotency key. */
  @Post('scan')
  @HttpCode(200)
  scan(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(ScanPassBody) body: ScanPassBody,
    @CorrelationId() correlationId: string,
  ): Promise<PassScan> {
    return this.passes.scan(principal, body, correlationId);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @Idempotent()
  revoke(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RevokePassBody) body: RevokePassBody,
    @CorrelationId() correlationId: string,
  ): Promise<Pass> {
    return this.passes.revoke(principal, params.id, body, correlationId);
  }
}

/** Facility arrivals (SPK-ENTRY-001, SPK-ENTRY-006). */
@Controller('visits')
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Post()
  @Idempotent()
  record(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordVisitsBody) body: RecordVisitsBody,
    @CorrelationId() correlationId: string,
  ): Promise<RecordedVisits> {
    return this.visits.record(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListVisitsQuery) query: ListVisitsQuery,
  ): Promise<Page<Visit>> {
    return this.visits.list(principal, query);
  }

  @Post(':id/void')
  @HttpCode(200)
  @Idempotent()
  void(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(VoidVisitBody) body: VoidVisitBody,
    @CorrelationId() correlationId: string,
  ): Promise<Visit> {
    return this.visits.void(principal, params.id, body, correlationId);
  }
}

/** Departures (SPK-ENTRY-001, SPK-ENTRY-008). */
@Controller('departures')
export class DeparturesController {
  constructor(private readonly visits: VisitsService) {}

  @Post()
  @Idempotent()
  record(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordDepartureBody) body: RecordDepartureBody,
    @CorrelationId() correlationId: string,
  ): Promise<Departure> {
    return this.visits.depart(principal, body, correlationId);
  }
}

/** Session check-ins (SPK-ENTRY-003, SPK-ENTRY-004). */
@Controller('session-checkins')
export class SessionCheckinsController {
  constructor(private readonly checkins: CheckinsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateSessionCheckinBody) body: CreateSessionCheckinBody,
    @CorrelationId() correlationId: string,
  ): Promise<SessionCheckin> {
    return this.checkins.create(principal, body, correlationId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<SessionCheckin> {
    return this.checkins.get(principal, params.id);
  }

  @Post(':id/recheck')
  @HttpCode(200)
  @Idempotent()
  recheck(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RecheckSessionCheckinBody) body: RecheckSessionCheckinBody,
    @CorrelationId() correlationId: string,
  ): Promise<SessionCheckin> {
    return this.checkins.recheck(principal, params.id, body, correlationId);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Idempotent()
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawSessionCheckinBody) body: WithdrawSessionCheckinBody,
    @CorrelationId() correlationId: string,
  ): Promise<SessionCheckin> {
    return this.checkins.withdraw(principal, params.id, body, correlationId);
  }
}

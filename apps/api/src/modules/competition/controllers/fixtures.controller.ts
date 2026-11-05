import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateFixtureBody,
  RecordAvailabilityBody,
  UpdateFixtureBody,
  z,
  type FixtureAvailabilityResponse,
  type FixtureCommandResult,
  type FixtureDetail,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { FixturesService } from '../services/fixtures.service';

const IdParams = z.object({ id: z.uuid() });

/** Fixtures (§4.4 Matches, SPK-FIX-005 scheduling through the scheduling port) and RSVPs (SPK-CAP-003). */
@Controller()
export class FixturesController {
  constructor(private readonly fixtures: FixturesService) {}

  @Post('fixtures')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateFixtureBody) body: z.infer<typeof CreateFixtureBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<FixtureCommandResult> {
    return this.fixtures.create(principal, body, correlationId);
  }

  @Get('fixtures/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<FixtureDetail> {
    return this.fixtures.get(principal, params.id);
  }

  @Patch('fixtures/:id')
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateFixtureBody) body: z.infer<typeof UpdateFixtureBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<FixtureCommandResult> {
    return this.fixtures.update(principal, params.id, body, correlationId);
  }

  /** RSVP (§4.8 POST /v1/fixtures/{id}/availability): not attendance, not eligibility. */
  @Post('fixtures/:id/availability')
  @HttpCode(200)
  @Idempotent()
  recordAvailability(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RecordAvailabilityBody) body: z.infer<typeof RecordAvailabilityBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<FixtureAvailabilityResponse> {
    return this.fixtures.recordAvailability(principal, params.id, body, correlationId);
  }
}

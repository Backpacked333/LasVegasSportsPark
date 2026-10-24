import { Controller, Get } from '@nestjs/common';
import { z, type FixtureReadiness, type Principal } from '@sportspark/contracts';
import { CurrentPrincipal, ZodParams } from '../../../kernel';
import { ReadinessService } from '../services/readiness.service';

const IdParams = z.object({ id: z.uuid() });

/** `GET /v1/fixtures/{id}/readiness` (§4.8, SPK-READY-001..004): derived on every read. */
@Controller()
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('fixtures/:id/readiness')
  evaluate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<FixtureReadiness> {
    return this.readiness.evaluate(principal, params.id);
  }
}

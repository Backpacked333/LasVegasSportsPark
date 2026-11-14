import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  RecordWaiverAcceptanceBody,
  RecordWaiverOverrideBody,
  SetOfferingRequiredWaiversBody,
  z,
  type Acknowledgment,
  type OfferingRequiredWaivers,
  type PersonWaivers,
  type Principal,
  type WaiverOverride,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../catalog.shared';
import { WaiversService } from '../services/waivers.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Liability waivers (SPK-REG-011, proposed amendment PA-01; capability `liability_waivers`,
 * DEC-095). The waiver wording and rule are policy versions of kind `waiver` (policy version
 * routes); these routes cover the acceptance, the person read, the override and the requirement.
 */
@Controller()
export class WaiversController {
  constructor(private readonly waivers: WaiversService) {}

  @Get('people/:id/waivers')
  personWaivers(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PersonWaivers> {
    return this.waivers.personWaivers(principal, params.id);
  }

  @Post('waiver-acceptances')
  @Idempotent()
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordWaiverAcceptanceBody) body: z.infer<typeof RecordWaiverAcceptanceBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Acknowledgment> {
    return this.waivers.accept(principal, body, correlationId);
  }

  @Post('waiver-overrides')
  @Idempotent()
  override(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordWaiverOverrideBody) body: z.infer<typeof RecordWaiverOverrideBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<WaiverOverride> {
    return this.waivers.override(principal, body, correlationId);
  }

  @Get('offerings/:id/required-waivers')
  requiredWaivers(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<OfferingRequiredWaivers> {
    return this.waivers.offeringRequiredWaivers(principal, params.id);
  }

  @Post('offerings/:id/required-waivers')
  @HttpCode(200)
  @Idempotent()
  setRequiredWaivers(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(SetOfferingRequiredWaiversBody) body: z.infer<typeof SetOfferingRequiredWaiversBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<OfferingRequiredWaivers> {
    return this.waivers.setOfferingRequiredWaivers(principal, params.id, body, correlationId);
  }
}

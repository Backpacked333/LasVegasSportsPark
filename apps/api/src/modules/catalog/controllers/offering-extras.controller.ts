import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateOfferingAddonBody,
  CreateOfferingUniformBody,
  RetireOfferingExtraBody,
  z,
  type OfferingAddon,
  type OfferingPurchaseOptions,
  type OfferingUniform,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, RecordAuthority, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../catalog.shared';
import { OfferingExtrasService } from '../services/offering-extras.service';

const IdParams = z.object({ id: z.uuid() });
type Id = z.infer<typeof IdParams>;

/**
 * Add-ons (SPK-PAY-014, proposed amendment PA-03) and uniforms (SPK-REG-012, proposed amendment
 * PA-07) of an offering, and the purchase options a customer chooses from.
 *
 * Record authority (§5.3, §5.6): an add-on and a uniform are configuration of their offering,
 * the program category, like its price rules.
 */
@Controller()
export class OfferingExtrasController {
  constructor(private readonly extras: OfferingExtrasService) {}

  @Post('offerings/:id/addons')
  @RecordAuthority('program')
  @Idempotent()
  createAddon(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: Id,
    @ZodBody(CreateOfferingAddonBody) body: z.infer<typeof CreateOfferingAddonBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<OfferingAddon> {
    return this.extras.createAddon(principal, params.id, body, correlationId);
  }

  @Get('offerings/:id/addons')
  listAddons(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: Id,
  ): Promise<OfferingAddon[]> {
    return this.extras.listAddons(principal, params.id);
  }

  @Post('offering-addons/:id/retire')
  @RecordAuthority('program')
  @HttpCode(200)
  @Idempotent()
  retireAddon(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: Id,
    @ZodBody(RetireOfferingExtraBody) body: z.infer<typeof RetireOfferingExtraBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<OfferingAddon> {
    return this.extras.retireAddon(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/uniforms')
  @RecordAuthority('program')
  @Idempotent()
  createUniform(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: Id,
    @ZodBody(CreateOfferingUniformBody) body: z.infer<typeof CreateOfferingUniformBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<OfferingUniform> {
    return this.extras.createUniform(principal, params.id, body, correlationId);
  }

  @Get('offerings/:id/uniforms')
  listUniforms(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: Id,
  ): Promise<OfferingUniform[]> {
    return this.extras.listUniforms(principal, params.id);
  }

  @Post('offering-uniforms/:id/retire')
  @RecordAuthority('program')
  @HttpCode(200)
  @Idempotent()
  retireUniform(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: Id,
    @ZodBody(RetireOfferingExtraBody) body: z.infer<typeof RetireOfferingExtraBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<OfferingUniform> {
    return this.extras.retireUniform(principal, params.id, body, correlationId);
  }

  @Get('offerings/:id/purchase-options')
  purchaseOptions(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: Id,
  ): Promise<OfferingPurchaseOptions> {
    return this.extras.purchaseOptions(principal, params.id);
  }
}

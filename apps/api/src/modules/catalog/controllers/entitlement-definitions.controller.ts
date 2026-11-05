import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateEntitlementDefinitionBody,
  UpdateEntitlementDefinitionBody,
  z,
  type EntitlementDefinition,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../catalog.shared';
import { EntitlementDefinitionsService } from '../services/entitlement-definitions.service';

const IdParams = z.object({ id: z.uuid() });

/** What participation a purchase grants (§4.4 EntitlementDefinition). */
@Controller('entitlement-definitions')
export class EntitlementDefinitionsController {
  constructor(private readonly definitions: EntitlementDefinitionsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateEntitlementDefinitionBody)
    body: z.infer<typeof CreateEntitlementDefinitionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<EntitlementDefinition> {
    return this.definitions.create(principal, body, correlationId);
  }

  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<EntitlementDefinition[]> {
    return this.definitions.list(principal);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<EntitlementDefinition> {
    return this.definitions.get(principal, params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateEntitlementDefinitionBody)
    body: z.infer<typeof UpdateEntitlementDefinitionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<EntitlementDefinition> {
    return this.definitions.update(principal, params.id, body, correlationId);
  }
}

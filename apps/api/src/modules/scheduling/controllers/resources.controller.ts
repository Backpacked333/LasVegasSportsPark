import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import {
  CreateConflictUnitBody,
  CreateOperatingHoursBody,
  CreateResourceBody,
  CreateResourceConfigurationBody,
  ListOperatingHoursQuery,
  ListResourcesQuery,
  UpdateResourceBody,
  UpdateResourceConfigurationBody,
  z,
  type ConflictUnit,
  type OperatingHours,
  type Principal,
  type Resource,
  type ResourceConfiguration,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { ResourcesService } from '../services/resources.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Physical inventory endpoints (SPK-SCHED-001/002). */
@Controller()
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Post('resources')
  @Idempotent()
  createResource(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateResourceBody) body: CreateResourceBody,
    @CorrelationId() correlationId: string,
  ): Promise<Resource> {
    return this.resources.createResource(principal, body, correlationId);
  }

  @Get('resources')
  listResources(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListResourcesQuery) query: z.infer<typeof ListResourcesQuery>,
  ): Promise<Resource[]> {
    return this.resources.listResources(principal, query.facilityId);
  }

  @Get('resources/:id')
  getResource(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Resource> {
    return this.resources.getResource(principal, params.id);
  }

  @Patch('resources/:id')
  @Idempotent()
  updateResource(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateResourceBody) body: UpdateResourceBody,
    @CorrelationId() correlationId: string,
  ): Promise<Resource> {
    return this.resources.updateResource(principal, params.id, body, correlationId);
  }

  @Post('resource-configurations')
  @Idempotent()
  createConfiguration(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateResourceConfigurationBody) body: CreateResourceConfigurationBody,
    @CorrelationId() correlationId: string,
  ): Promise<ResourceConfiguration> {
    return this.resources.createConfiguration(principal, body, correlationId);
  }

  @Get('resource-configurations')
  listConfigurations(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListResourcesQuery) query: z.infer<typeof ListResourcesQuery>,
  ): Promise<ResourceConfiguration[]> {
    return this.resources.listConfigurations(principal, query.facilityId);
  }

  @Patch('resource-configurations/:id')
  @Idempotent()
  updateConfiguration(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateResourceConfigurationBody) body: UpdateResourceConfigurationBody,
    @CorrelationId() correlationId: string,
  ): Promise<ResourceConfiguration> {
    return this.resources.updateConfiguration(principal, params.id, body, correlationId);
  }

  @Post('conflict-units')
  @Idempotent()
  createConflictUnit(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateConflictUnitBody) body: CreateConflictUnitBody,
    @CorrelationId() correlationId: string,
  ): Promise<ConflictUnit> {
    return this.resources.createConflictUnit(principal, body, correlationId);
  }

  @Get('conflict-units')
  listConflictUnits(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListResourcesQuery) query: z.infer<typeof ListResourcesQuery>,
  ): Promise<ConflictUnit[]> {
    return this.resources.listConflictUnits(principal, query.facilityId);
  }

  @Post('operating-hours')
  @Idempotent()
  createOperatingHours(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateOperatingHoursBody) body: CreateOperatingHoursBody,
    @CorrelationId() correlationId: string,
  ): Promise<OperatingHours> {
    return this.resources.createOperatingHours(principal, body, correlationId);
  }

  @Get('operating-hours')
  listOperatingHours(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListOperatingHoursQuery) query: z.infer<typeof ListOperatingHoursQuery>,
  ): Promise<OperatingHours[]> {
    return this.resources.listOperatingHours(principal, query.facilityId, query.resourceId);
  }

  @Delete('operating-hours/:id')
  @Idempotent()
  deleteOperatingHours(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @CorrelationId() correlationId: string,
  ): Promise<{ id: string }> {
    return this.resources.deleteOperatingHours(principal, params.id, correlationId);
  }
}

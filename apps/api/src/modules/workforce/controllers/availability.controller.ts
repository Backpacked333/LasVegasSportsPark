import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateAvailabilityBody,
  ListAvailabilityQuery,
  WithdrawAvailabilityBody,
  z,
  type AvailabilityWindow,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { AvailabilityService } from '../services/availability.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Availability windows (SPK-STAFF-001). */
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAvailabilityBody) body: CreateAvailabilityBody,
    @CorrelationId() correlationId: string,
  ): Promise<AvailabilityWindow> {
    return this.availability.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAvailabilityQuery) query: ListAvailabilityQuery,
  ): Promise<AvailabilityWindow[]> {
    return this.availability.list(principal, query);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Idempotent()
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawAvailabilityBody) body: WithdrawAvailabilityBody,
    @CorrelationId() correlationId: string,
  ): Promise<AvailabilityWindow> {
    return this.availability.withdraw(principal, params.id, body, correlationId);
  }
}

import { Controller, Get, Post } from '@nestjs/common';
import {
  AddHouseholdMemberBody,
  CreateHouseholdBody,
  z,
  type Household,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { HouseholdsService } from '../services/households.service';

const IdParams = z.object({ id: z.uuid() });

@Controller('households')
export class HouseholdsController {
  constructor(private readonly households: HouseholdsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateHouseholdBody) body: z.infer<typeof CreateHouseholdBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Household> {
    return this.households.createHousehold(principal, body, correlationId);
  }

  /** S 4c household record: the household and its members, for staff who read authority. */
  @Get(':id')
  read(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Household> {
    return this.households.read(principal, params.id);
  }

  @Post(':id/members')
  @Idempotent()
  addMember(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AddHouseholdMemberBody) body: z.infer<typeof AddHouseholdMemberBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Household> {
    return this.households.addMember(principal, params.id, body, correlationId);
  }
}

import { Controller, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateStaffMembershipBody,
  EndStaffMembershipBody,
  UpdateStaffMembershipBody,
  z,
  type Principal,
  type StaffMembership,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { StaffMembershipsService } from '../services/staff-memberships.service';

const IdParams = z.object({ id: z.uuid() });

@Controller('staff-memberships')
export class StaffMembershipsController {
  constructor(private readonly memberships: StaffMembershipsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateStaffMembershipBody) body: z.infer<typeof CreateStaffMembershipBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<StaffMembership> {
    return this.memberships.create(principal, body, correlationId);
  }

  @Patch(':id')
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateStaffMembershipBody) body: z.infer<typeof UpdateStaffMembershipBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<StaffMembership> {
    return this.memberships.update(principal, params.id, body, correlationId);
  }

  @Post(':id/end')
  @HttpCode(200)
  @Idempotent()
  end(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(EndStaffMembershipBody) body: z.infer<typeof EndStaffMembershipBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<StaffMembership> {
    return this.memberships.end(principal, params.id, body, correlationId);
  }
}

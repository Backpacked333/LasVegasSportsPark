import { Controller, Get } from '@nestjs/common';
import { AssignedStaffQuery, type AssignedStaff, type Principal } from '@sportspark/contracts';
import { CurrentPrincipal, ZodQuery } from '../../../kernel';
import { AssignedStaffService } from '../services/assigned-staff.service';

/** Staff assigned to activities, for the arrival screen's session coach (SPK-STAFF-002). */
@Controller('assigned-staff')
export class AssignedStaffController {
  constructor(private readonly assigned: AssignedStaffService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(AssignedStaffQuery) query: AssignedStaffQuery,
  ): Promise<AssignedStaff> {
    return this.assigned.list(principal, query);
  }
}

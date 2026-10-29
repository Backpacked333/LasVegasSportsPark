import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateStaffMembershipBody,
  EndStaffMembershipBody,
  UpdateStaffMembershipBody,
  ListStaffMembershipsQuery,
  StaffDirectoryQuery,
  z,
  type Page,
  type Principal,
  type StaffDirectoryEntry,
  type StaffMembership,
  type StaffMembershipView,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
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

  /** GET /v1/staff-memberships (ID-05): administrators only. */
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListStaffMembershipsQuery) query: z.infer<typeof ListStaffMembershipsQuery>,
  ): Promise<Page<StaffMembershipView>> {
    return this.memberships.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<StaffMembershipView> {
    return this.memberships.get(principal, params.id);
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

/** GET /v1/staff-directory (ID-05): staff in effect now, names and roles only. */
@Controller('staff-directory')
export class StaffDirectoryController {
  constructor(private readonly memberships: StaffMembershipsService) {}

  @Get()
  directory(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(StaffDirectoryQuery) query: z.infer<typeof StaffDirectoryQuery>,
  ): Promise<Page<StaffDirectoryEntry>> {
    return this.memberships.directory(principal, query);
  }
}

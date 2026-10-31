import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  ApproveAccessPolicyBody,
  DraftAccessPolicyBody,
  ListAccessDevicesQuery,
  ListDeviceCommandsQuery,
  RegisterAccessDeviceBody,
  RetireAccessDeviceBody,
  RetireAccessPolicyBody,
  UpdateAccessDeviceBody,
  z,
  type AccessDevice,
  type AccessPolicy,
  type DeviceCommand,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { AccessDevicesService } from '../services/access-devices.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });
/** §5.6: device inventory and access policies are not a §5.3 record category. */
const NOT_A_RECORD_CATEGORY = 'Not a §5.3 record category';

/**
 * Access devices (ENT-05; §3.16 "Access hardware"; capability `access_hardware`, DEC-016,
 * DEC-080). Facilities operators and general managers act; front desk staff read.
 */
@Controller('access-devices')
export class AccessDevicesController {
  constructor(private readonly devices: AccessDevicesService) {}

  @Post()
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD_CATEGORY)
  register(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RegisterAccessDeviceBody) body: RegisterAccessDeviceBody,
    @CorrelationId() correlationId: string,
  ): Promise<AccessDevice> {
    return this.devices.register(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAccessDevicesQuery) query: ListAccessDevicesQuery,
  ): Promise<Page<AccessDevice>> {
    return this.devices.list(principal, query);
  }

  @Patch(':id')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD_CATEGORY)
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateAccessDeviceBody) body: UpdateAccessDeviceBody,
    @CorrelationId() correlationId: string,
  ): Promise<AccessDevice> {
    return this.devices.update(principal, params.id, body, correlationId);
  }

  @Post(':id/retire')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD_CATEGORY)
  retire(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetireAccessDeviceBody) body: RetireAccessDeviceBody,
    @CorrelationId() correlationId: string,
  ): Promise<AccessDevice> {
    return this.devices.retire(principal, params.id, body, correlationId);
  }

  @Post(':id/policies')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD_CATEGORY)
  draftPolicy(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DraftAccessPolicyBody) body: DraftAccessPolicyBody,
    @CorrelationId() correlationId: string,
  ): Promise<AccessPolicy> {
    return this.devices.draftPolicy(principal, params.id, body, correlationId);
  }

  @Get(':id/policies')
  policies(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<AccessPolicy[]> {
    return this.devices.policies(principal, params.id);
  }

  @Get(':id/commands')
  commands(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(ListDeviceCommandsQuery) query: ListDeviceCommandsQuery,
  ): Promise<Page<DeviceCommand>> {
    return this.devices.commands(principal, params.id, query);
  }
}

/** Access policies: four-eyes approval and retirement (ENT-05). */
@Controller('access-policies')
export class AccessPoliciesController {
  constructor(private readonly devices: AccessDevicesService) {}

  @Post(':id/approve')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD_CATEGORY)
  approve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ApproveAccessPolicyBody) body: ApproveAccessPolicyBody,
    @CorrelationId() correlationId: string,
  ): Promise<AccessPolicy> {
    return this.devices.approvePolicy(principal, params.id, body, correlationId);
  }

  @Post(':id/retire')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD_CATEGORY)
  retire(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetireAccessPolicyBody) body: RetireAccessPolicyBody,
    @CorrelationId() correlationId: string,
  ): Promise<AccessPolicy> {
    return this.devices.retirePolicy(principal, params.id, body, correlationId);
  }
}

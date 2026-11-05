import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import {
  CapabilityParams,
  ChangeCapabilityBody,
  errors,
  ListAuditRecordsQuery,
  ListFacilitiesQuery,
  ListProviderEventsQuery,
  staffFacilityScope,
  z,
  type AdminSettings,
  type CapabilityView,
  type ChangeCapabilityInput,
  type FacilityList,
  type FacilitySummaryView,
  type Integrations,
  type ListAuditRecordsQueryInput,
  type ListFacilitiesQueryInput,
  type ListProviderEventsQueryInput,
  type MePermissions,
  type Page,
  type Principal,
  type ProviderEventView,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { AuditLogService, type AuditRecord } from '../audit/audit-reader';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { AuthorizationService } from '../authorization/authorization.service';
import { CoreActions } from '../authorization/core-actions';
import { MePermissionsService } from '../authorization/me-permissions.service';
import { CapabilityService } from '../capabilities/capability.service';
import { FacilityDirectory, type FacilitySummary } from '../facilities/facility-directory';
import { Idempotent } from '../http/idempotency.interceptor';
import { NoRecordAuthority } from '../http/record-authority.decorator';
import { CurrentCorrelationId } from '../http/request-context';
import { ZodBody, ZodParams, ZodQuery } from '../http/zod-validation.pipe';
import { IntegrationRegistry } from '../integrations/integration-registry';
import { DATABASE } from '../tokens';

const IdParams = z.object({ id: z.uuid() });

function organizationOf(principal: Principal): string {
  if (principal.kind === 'anonymous' || !principal.organizationId) {
    throw errors.authenticationRequired();
  }
  return principal.organizationId;
}

/** Whether a staff principal may act at the facility through any held role (null otherwise). */
function inStaffScope(principal: Principal, facilityId: string): boolean | null {
  if (principal.kind !== 'staff') return null;
  const scope = staffFacilityScope(principal, principal.staffRoles);
  return scope === null || scope.includes(facilityId);
}

function view(principal: Principal, facility: FacilitySummary): FacilitySummaryView {
  return { ...facility, inStaffScope: inStaffScope(principal, facility.id) };
}

/**
 * The facility directory for every signed-in principal (K-04, SPK-SCHED-008): each facility's IANA
 * time zone, so customer and staff screens show facility-local times. Names, zones and addresses
 * are configuration (DEC-001); nothing customer-private is returned.
 */
@Controller('facilities')
export class FacilitiesController {
  constructor(private readonly directory: FacilityDirectory) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListFacilitiesQuery) query: ListFacilitiesQueryInput,
  ): Promise<FacilityList> {
    const organizationId = organizationOf(principal);
    const facilities = await this.directory.list(organizationId, { statuses: query.status });
    return { items: facilities.map((f) => view(principal, f)) };
  }

  @Get(':id')
  async get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<FacilitySummaryView> {
    const organizationId = organizationOf(principal);
    const facility = (await this.directory.describe(organizationId, [params.id])).get(params.id);
    // §4.10: another organization's facility is simply not found.
    if (!facility) throw errors.notFound('facility', params.id);
    return view(principal, facility);
  }
}

/** GET /v1/me/permissions (K-05, SPK-UX-005). */
@Controller('me')
export class MePermissionsController {
  constructor(private readonly permissions: MePermissionsService) {}

  @Get('permissions')
  describe(@CurrentPrincipal() principal: Principal): Promise<MePermissions> {
    return this.permissions.describe(principal);
  }
}

/**
 * Administration reads (K-04 settings, K-09 integration register) and the capability switches
 * (K-12). Changing organization or facility settings and integration configuration stays
 * Proposed (core.manage_organization_settings, core.manage_facility, core.manage_integration).
 */
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly authorization: AuthorizationService,
    private readonly integrations: IntegrationRegistry,
    private readonly capabilities: CapabilityService,
  ) {}

  @Get('settings')
  async settings(@CurrentPrincipal() principal: Principal): Promise<AdminSettings> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CoreActions.viewSettings, {
      type: 'organization_settings',
      organizationId,
    });
    const organization = await this.db
      .selectFrom('organizations')
      .select(['id', 'slug', 'name', 'status', 'revision', 'settings'])
      .where('id', '=', organizationId)
      .executeTakeFirst();
    if (!organization) throw errors.notFound('organization');
    const facilities = await this.db
      .selectFrom('facilities')
      .select(['id', 'slug', 'name', 'timezone', 'status', 'address', 'revision', 'settings'])
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .orderBy('id')
      .execute();
    return {
      organization: {
        ...organization,
        settings: (organization.settings ?? {}) as Record<string, unknown>,
      },
      facilities: facilities.map((f) => ({
        ...f,
        address: f.address ?? null,
        settings: (f.settings ?? {}) as Record<string, unknown>,
      })),
    };
  }

  @Get('integrations')
  integrationRegister(@CurrentPrincipal() principal: Principal): Promise<Integrations> {
    return this.integrations.describe(principal);
  }

  @Get('capabilities')
  async listCapabilities(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ items: CapabilityView[] }> {
    return { items: await this.capabilities.listForPrincipal(principal) };
  }

  @Post('capabilities/:capability/enable')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('Not a §5.3 record category')
  enable(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(CapabilityParams) params: z.infer<typeof CapabilityParams>,
    @ZodBody(ChangeCapabilityBody) body: ChangeCapabilityInput,
    @CurrentCorrelationId() correlationId: string | null,
  ): Promise<CapabilityView> {
    return this.capabilities.change(principal, params.capability, 'enable', body, correlationId);
  }

  @Post('capabilities/:capability/disable')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('Not a §5.3 record category')
  disable(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(CapabilityParams) params: z.infer<typeof CapabilityParams>,
    @ZodBody(ChangeCapabilityBody) body: ChangeCapabilityInput,
    @CurrentCorrelationId() correlationId: string | null,
  ): Promise<CapabilityView> {
    return this.capabilities.change(principal, params.capability, 'disable', body, correlationId);
  }
}

/** The audit log and provider-event reads (K-08, §4.14, §4.12). */
@Controller()
export class AuditController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get('audit-records')
  auditRecords(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAuditRecordsQuery) query: ListAuditRecordsQueryInput,
    @CurrentCorrelationId() correlationId: string | null,
  ): Promise<Page<AuditRecord>> {
    return this.auditLog.listAuditRecords(principal, query, correlationId);
  }

  @Get('provider-events')
  providerEvents(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListProviderEventsQuery) query: ListProviderEventsQueryInput,
  ): Promise<Page<ProviderEventView>> {
    return this.auditLog.listProviderEvents(principal, query);
  }
}

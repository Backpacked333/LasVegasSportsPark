import {
  CapabilityEnforcementSchema,
  CapabilityIdSchema,
  DecisionReferenceSchema,
} from '../capabilities';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { pageSchema, PageRequestSchema } from '../pagination';
import { StaffRole } from '../principal';
import { z } from '../zod';

/**
 * Kernel contracts (§4.3, §4.8, §4.12, §4.14, §5.1, §1.6): the facility directory, the principal's
 * permitted actions and navigation areas, the audit and provider-event reads, the integration
 * register and the per-organization capability switches. The Idempotency-Key header of the
 * commands and the client header are added from the route facts (`applyRouteFacts`, K-02/K-03).
 */
const TAG = 'Core';

const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

// ---------------------------------------------------------------------------------------------
// Facility directory (K-04, SPK-SCHED-008, §4.3)
// ---------------------------------------------------------------------------------------------

export const FacilityStatusSchema = z
  .enum(['active', 'closed', 'archived'])
  .openapi('FacilityStatus');
export type FacilityStatusValue = z.infer<typeof FacilityStatusSchema>;

export const FacilitySummarySchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    /** IANA time zone every facility-local time is interpreted in (SPK-SCHED-008). */
    timezone: z.string(),
    status: FacilityStatusSchema,
    /** Postal address as configured; null until set (DEC-001). */
    address: z.record(z.string(), z.unknown()).nullable(),
    /**
     * Whether the staff principal may act here through any held role (§2.1, §4.14); null for a
     * customer or system principal.
     */
    inStaffScope: z.boolean().nullable(),
  })
  .openapi('FacilitySummary');
export type FacilitySummaryView = z.infer<typeof FacilitySummarySchema>;

export const FacilityListSchema = z
  .object({ items: z.array(FacilitySummarySchema) })
  .openapi('FacilityList');
export type FacilityList = z.infer<typeof FacilityListSchema>;

/** `?status=active,closed` or repeated `status`; default active and closed. */
export const ListFacilitiesQuery = z.object({
  status: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.split(',').map((v) => v.trim()) : value),
      z.array(FacilityStatusSchema).min(1),
    )
    .optional(),
});
export type ListFacilitiesQueryInput = z.infer<typeof ListFacilitiesQuery>;

export const AdminOrganizationSettingsSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    status: z.enum(['active', 'suspended', 'archived']),
    revision: z.number().int(),
    settings: z.record(z.string(), z.unknown()),
  })
  .openapi('AdminOrganizationSettings');

export const AdminFacilitySettingsSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    timezone: z.string(),
    status: FacilityStatusSchema,
    address: z.record(z.string(), z.unknown()).nullable(),
    revision: z.number().int(),
    settings: z.record(z.string(), z.unknown()),
  })
  .openapi('AdminFacilitySettings');

export const AdminSettingsSchema = z
  .object({
    organization: AdminOrganizationSettingsSchema,
    facilities: z.array(AdminFacilitySettingsSchema),
  })
  .openapi('AdminSettings');
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;

openApiRegistry.registerPath({
  method: 'get',
  path: '/facilities',
  summary:
    "The organization's facilities with their IANA time zones (any signed-in principal; SPK-SCHED-008)",
  tags: [TAG],
  request: { query: ListFacilitiesQuery },
  responses: {
    200: ok('Facilities, by name', FacilityListSchema),
    400: err('Validation failed'),
    401: err('Authentication required'),
  },
});
openApiRegistry.registerPath({
  method: 'get',
  path: '/facilities/{id}',
  summary: 'One facility of the organization (another organization: NOT_FOUND)',
  tags: [TAG],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: ok('Facility', FacilitySummarySchema),
    401: err('Authentication required'),
    404: err('Not found'),
  },
});
openApiRegistry.registerPath({
  method: 'get',
  path: '/admin/settings',
  summary:
    'Organization and facility settings with revisions (read only; core.view_settings; changing them is Proposed)',
  tags: [TAG],
  responses: {
    200: ok('Settings', AdminSettingsSchema),
    403: err('Access denied'),
  },
});

// ---------------------------------------------------------------------------------------------
// The principal's permitted actions and navigation areas (K-05, SPK-UX-005, §4.14)
// ---------------------------------------------------------------------------------------------

export const NAVIGATION_AREA_IDS = [
  'today',
  'schedule',
  'leagues',
  'programs',
  'teams',
  'people',
  'registrations',
  'arrival',
  'staff',
  'finance',
  'communications',
  'facilities',
  'reports',
  'admin',
] as const;
export const NavigationAreaSchema = z.enum(NAVIGATION_AREA_IDS).openapi('NavigationArea');
export type NavigationAreaId = z.infer<typeof NavigationAreaSchema>;

export const MePermittedActionSchema = z
  .object({
    id: z.string(),
    /** Facilities the action may be used in; null: every facility of the organization. */
    facilityIds: z.array(z.uuid()).nullable(),
  })
  .openapi('MePermittedAction');

export const MeConditionalActionSchema = z
  .object({
    id: z.string(),
    /** The principal may act on themselves as the subject person. */
    self: z.boolean(),
    /** The grant the principal must hold over every subject person, if any. */
    subjectPermission: z.string().nullable(),
    /** The role the principal must hold on the team entry, if any. */
    teamRole: z.string().nullable(),
  })
  .openapi('MeConditionalAction');

export const MeNavigationAreaSchema = z
  .object({
    id: NavigationAreaSchema,
    visible: z.boolean(),
    actionIds: z.array(z.string()),
  })
  .openapi('MeNavigationArea');

export const MeCapabilitySchema = z
  .object({
    id: CapabilityIdSchema,
    enabled: z.boolean(),
    enforcement: CapabilityEnforcementSchema,
  })
  .openapi('MeCapability');

export const MePermissionsSchema = z
  .object({
    evaluatedAt: z.iso.datetime(),
    principalKind: z.enum(['customer', 'staff', 'system']),
    staffRoles: z.array(StaffRole),
    /** Actions the principal's staff roles allow outright, within their facility scope. */
    actions: z.array(MePermittedActionSchema),
    /** Actions allowed per record through self, relationship or team authority. */
    conditionalActions: z.array(MeConditionalActionSchema),
    /** The fourteen SPK-UX-005 areas (mapping Proposed), visible when an allowed action lives there. */
    areas: z.array(MeNavigationAreaSchema),
    /** The organization's capability switches (K-12, DEC-016). */
    capabilities: z.array(MeCapabilitySchema),
  })
  .openapi('MePermissions');
export type MePermissions = z.infer<typeof MePermissionsSchema>;

openApiRegistry.registerPath({
  method: 'get',
  path: '/me/permissions',
  summary:
    "The principal's permitted actions, conditional actions, navigation areas and capabilities (SPK-UX-005)",
  tags: [TAG],
  responses: {
    200: ok('Permissions', MePermissionsSchema),
    401: err('Authentication required'),
  },
});

// ---------------------------------------------------------------------------------------------
// Audit records and provider events (K-08, §4.14, §4.12)
// ---------------------------------------------------------------------------------------------

export const AuditActorSchema = z
  .object({
    kind: z.string(),
    accountId: z.string().nullable(),
    personId: z.string().nullable(),
    staffRoles: z.array(z.string()),
    sessionId: z.string().nullable(),
    actorLabel: z.string(),
  })
  .openapi('AuditActor');

export const AuditRecordSchema = z
  .object({
    id: z.uuid(),
    occurredAt: z.iso.datetime(),
    actor: AuditActorSchema,
    action: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    beforeRevision: z.number().int().nullable(),
    afterRevision: z.number().int().nullable(),
    reason: z.string().nullable(),
    correlationId: z.string().nullable(),
    operationId: z.uuid().nullable(),
    details: z.record(z.string(), z.unknown()),
  })
  .openapi('AuditRecord');
export type AuditRecordView = z.infer<typeof AuditRecordSchema>;

export const ListAuditRecordsQuery = PageRequestSchema.extend({
  targetType: z.string().min(1).max(100).optional(),
  targetId: z.string().min(1).max(200).optional(),
  actorPersonId: z.uuid().optional(),
  action: z.string().min(1).max(200).optional(),
  operationId: z.uuid().optional(),
  correlationId: z.string().min(1).max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type ListAuditRecordsQueryInput = z.infer<typeof ListAuditRecordsQuery>;

export const AuditRecordPageSchema = pageSchema(AuditRecordSchema).openapi('AuditRecordPage');

export const ProviderEventStatusSchema = z
  .enum(['received', 'processed', 'failed', 'ignored', 'dead'])
  .openapi('ProviderEventStatus');

export const ProviderEventSchema = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    providerEventId: z.string(),
    eventType: z.string(),
    signatureVerified: z.boolean(),
    status: ProviderEventStatusSchema,
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    receivedAt: z.iso.datetime(),
    processedAt: z.iso.datetime().nullable(),
  })
  .openapi('ProviderEvent');
export type ProviderEventView = z.infer<typeof ProviderEventSchema>;

export const ListProviderEventsQuery = PageRequestSchema.extend({
  provider: z.string().min(1).max(100).optional(),
  status: ProviderEventStatusSchema.optional(),
  eventType: z.string().min(1).max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type ListProviderEventsQueryInput = z.infer<typeof ListProviderEventsQuery>;

export const ProviderEventPageSchema = pageSchema(ProviderEventSchema).openapi('ProviderEventPage');

openApiRegistry.registerPath({
  method: 'get',
  path: '/audit-records',
  summary:
    'Audited privileged actions by target, actor, action, operation or correlation (core.view_audit; the read is itself audited, §4.14)',
  tags: [TAG],
  request: { query: ListAuditRecordsQuery },
  responses: {
    200: ok('Audit records, newest first', AuditRecordPageSchema),
    400: err('Validation failed'),
    403: err('Access denied'),
  },
});
openApiRegistry.registerPath({
  method: 'get',
  path: '/provider-events',
  summary:
    'Provider events received by the inbox, never their payloads (core.view_provider_events, §4.12, §4.14)',
  tags: [TAG],
  request: { query: ListProviderEventsQuery },
  responses: {
    200: ok('Provider events, newest first', ProviderEventPageSchema),
    400: err('Validation failed'),
    403: err('Access denied'),
  },
});

// ---------------------------------------------------------------------------------------------
// Integration register (K-09, §5.1, §5.2)
// ---------------------------------------------------------------------------------------------

export const ProviderGateSchema = z
  .enum(['identity', 'payments', 'messaging', 'hosting', 'accounting', 'hardware', 'assistant'])
  .openapi('ProviderGate');
export type ProviderGateValue = z.infer<typeof ProviderGateSchema>;

export const IntegrationScenarioSchema = z
  .enum(['success', 'failure', 'timeout_unknown', 'duplicate'])
  .openapi('IntegrationScenario');

export const IntegrationAdapterSchema = z
  .object({
    /** `<module>.<port>` */
    id: z.string(),
    gate: ProviderGateSchema,
    port: z.string(),
    adapter: z.object({ name: z.string(), kind: z.enum(['fake', 'local', 'provider']) }),
    productionAllowed: z.boolean(),
    scenarios: z.array(IntegrationScenarioSchema),
    reconciliationOwner: StaffRole.nullable(),
  })
  .openapi('IntegrationAdapter');

/** The §5.1 integration register fields; null until the gate's decision is recorded. */
export const IntegrationRegisterSchema = z
  .object({
    productAndVendor: z.string().nullable(),
    accountOwner: z.string().nullable(),
    authorizedAccess: z.string().nullable(),
    supportedOperations: z.string().nullable(),
    sandboxAvailability: z.string().nullable(),
    documentation: z.string().nullable(),
    eventBehavior: z.string().nullable(),
    rateLimits: z.string().nullable(),
    idempotency: z.string().nullable(),
    failureHandling: z.string().nullable(),
    reconciliationOwner: z.string().nullable(),
    exitProcedure: z.string().nullable(),
  })
  .openapi('IntegrationRegister');

export const IntegrationGateSchema = z
  .object({
    gate: ProviderGateSchema,
    decisionRef: z.string(),
    status: z.enum(['pending_decision']),
    register: IntegrationRegisterSchema,
    /** §5.1 evidence: documented, tested, accepted, live; null while pending. */
    evidenceLevel: z.enum(['documented', 'tested', 'accepted', 'live']).nullable(),
    adapters: z.array(IntegrationAdapterSchema),
  })
  .openapi('IntegrationGate');

export const IntegrationsSchema = z
  .object({ gates: z.array(IntegrationGateSchema) })
  .openapi('Integrations');
export type Integrations = z.infer<typeof IntegrationsSchema>;

openApiRegistry.registerPath({
  method: 'get',
  path: '/admin/integrations',
  summary:
    'Provider-selection gates with their decision references and the registered adapters (core.view_integrations, §5.1, §5.2)',
  tags: [TAG],
  responses: {
    200: ok('Integration register', IntegrationsSchema),
    403: err('Access denied'),
  },
});

// ---------------------------------------------------------------------------------------------
// Capability switches (K-12, §1.6, §6.5 Package G, DEC-016)
// ---------------------------------------------------------------------------------------------

export const CapabilitySchema = z
  .object({
    capability: CapabilityIdSchema,
    enabled: z.boolean(),
    enforcement: CapabilityEnforcementSchema,
    description: z.string(),
    /** The only references that can enable or disable it: DEC-016 and its own record. */
    applicabilityReferences: z.array(z.string()),
    relatedDecisions: z.array(z.string()),
    owningModules: z.array(z.string()),
    /** The last change; null while the switch was never changed (disabled). */
    decisionReference: z.string().nullable(),
    reason: z.string().nullable(),
    changedByPersonId: z.uuid().nullable(),
    changedAt: z.iso.datetime().nullable(),
    revision: z.number().int().nullable(),
  })
  .openapi('Capability');
export type CapabilityView = z.infer<typeof CapabilitySchema>;

export const CapabilityListSchema = z
  .object({ items: z.array(CapabilitySchema) })
  .openapi('CapabilityList');

export const ChangeCapabilityBody = withCommandMeta({})
  .extend({
    decisionReference: DecisionReferenceSchema,
    reason: z.string().trim().min(1).max(2000),
    expectedRevision: Revision.optional(),
  })
  .openapi('ChangeCapabilityRequest');
export type ChangeCapabilityInput = z.infer<typeof ChangeCapabilityBody>;

export const CapabilityParams = z.object({ capability: CapabilityIdSchema });

openApiRegistry.registerPath({
  method: 'get',
  path: '/admin/capabilities',
  summary:
    "The organization's capability switches with their applicability decisions (core.view_capabilities, DEC-016)",
  tags: [TAG],
  responses: {
    200: ok('Capabilities', CapabilityListSchema),
    403: err('Access denied'),
  },
});
for (const change of ['enable', 'disable'] as const) {
  openApiRegistry.registerPath({
    method: 'post',
    path: `/admin/capabilities/{capability}/${change}`,
    summary: `${change === 'enable' ? 'Enable' : 'Disable'} a capability for the organization, naming DEC-016 or its own Register E record (core.manage_capabilities, system administrator; audited, kept in history)`,
    tags: [TAG],
    request: {
      params: CapabilityParams,
      body: { content: { 'application/json': { schema: ChangeCapabilityBody } } },
    },
    responses: {
      200: ok('The capability after the change', CapabilitySchema),
      400: err(
        'Validation failed (details.code NOT_AN_APPLICABILITY_DECISION when the reference cannot enable it)',
      ),
      403: err('Access denied'),
      409: err('STALE_REVISION, or INVALID_TRANSITION when it is already in that state'),
    },
  });
}

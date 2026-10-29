import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';
import { AccessControlEventBody } from './entry';
import { ActorSnapshotSchema } from './facilities';

/**
 * Access hardware contract (ENT-05; §3.16 "Access hardware": device inventory, access policy,
 * revocation, event ingestion, outages, audit; SPK-COND-004; SPK-ENTRY-002).
 *
 * Whether the complex uses access hardware is pending (DEC-080, DEC-016): registering and editing
 * devices and creating or approving policies need the organization's `access_hardware`
 * capability; retirements, event ingestion and command delivery always run. The hardware vendor is
 * not selected (DEC-023): commands go to the deterministic fake adapter behind ACCESS_DEVICE_PORT.
 * Hardware access is only ever a facility arrival, never attendance, a check-in or pickup
 * authority (SPK-COND-004).
 */

const Reason = z.string().trim().min(1).max(2000);
const DeviceRef = z.string().trim().min(1).max(200);
const LocalTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'must be an HH:MM time (24:00 ends the day)');

export const AccessDeviceKindSchema = z
  .enum(['door', 'turnstile', 'gate', 'scanner'])
  .openapi('AccessDeviceKind');
export type AccessDeviceKind = z.infer<typeof AccessDeviceKindSchema>;

export const AccessDeviceSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    kind: AccessDeviceKindSchema,
    name: z.string(),
    /** The provider's identifier of the device (unique in the organization). */
    providerDeviceRef: z.string(),
    status: z.enum(['active', 'retired']),
    /**
     * Observed health: `online` after a heartbeat; `offline` only when the device's heartbeat
     * timeout is configured and exceeded; otherwise `unknown` (no timeout is assumed).
     */
    health: z.enum(['online', 'offline', 'unknown']),
    /** Device configuration with no default: null means outages are not detected. */
    heartbeatTimeoutSeconds: z.number().int().nullable(),
    lastHeartbeatAt: Instant.nullable(),
    registeredAt: Instant,
    retiredAt: Instant.nullable(),
    retiredReason: z.string().nullable(),
    /** The approved policy in force; null means the device was sent deny-all. */
    activePolicyId: z.uuid().nullable(),
    registeredBy: ActorSnapshotSchema,
    revision: Revision,
  })
  .openapi('AccessDevice');
export type AccessDevice = z.infer<typeof AccessDeviceSchema>;

export const RegisterAccessDeviceBody = withCommandMeta({
  facilityId: z.uuid(),
  kind: AccessDeviceKindSchema,
  name: z.string().trim().min(1).max(200),
  providerDeviceRef: DeviceRef,
  heartbeatTimeoutSeconds: z.number().int().min(1).max(86_400).optional(),
}).openapi('RegisterAccessDeviceRequest');
export type RegisterAccessDeviceBody = z.infer<typeof RegisterAccessDeviceBody>;

export const UpdateAccessDeviceBody = withCommandMeta({
  name: z.string().trim().min(1).max(200).optional(),
  /** Null clears the timeout (outages are then not detected). */
  heartbeatTimeoutSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
})
  .extend({ expectedRevision: Revision })
  .refine((v) => v.name !== undefined || v.heartbeatTimeoutSeconds !== undefined, {
    message: 'change the name or the heartbeat timeout',
    path: ['name'],
  })
  .openapi('UpdateAccessDeviceRequest');
export type UpdateAccessDeviceBody = z.infer<typeof UpdateAccessDeviceBody>;

export const RetireAccessDeviceBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('RetireAccessDeviceRequest');
export type RetireAccessDeviceBody = z.infer<typeof RetireAccessDeviceBody>;

export const ListAccessDevicesQuery = PageRequestSchema.extend({
  facilityId: z.uuid(),
  status: z.enum(['active', 'retired']).optional(),
});
export type ListAccessDevicesQuery = z.infer<typeof ListAccessDevicesQuery>;

// ---------------------------------------------------------------------------------------------
// Access policies: drafted by one person, approved by another (four eyes), one active per device
// ---------------------------------------------------------------------------------------------

export const WeekdaySchema = z
  .enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
  .openapi('Weekday');

/** A weekly window in the facility's local time (SPK-SCHED-008); `to` is after `from`. */
export const AccessScheduleWindowSchema = z
  .object({
    days: z
      .array(WeekdaySchema)
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'each day once'),
    from: LocalTime,
    to: LocalTime,
  })
  .refine((w) => w.from < w.to, { message: 'the window ends after it starts', path: ['to'] })
  .openapi('AccessScheduleWindow');
export type AccessScheduleWindow = z.infer<typeof AccessScheduleWindowSchema>;

export const DraftAccessPolicyBody = withCommandMeta({
  allowedHolderKinds: z
    .array(z.enum(['person', 'household']))
    .min(1)
    .max(2)
    .refine((kinds) => new Set(kinds).size === kinds.length, 'each holder kind once'),
  /** Only active passes can ever be admitted; absent means ['active']. */
  allowedPassStatuses: z.array(z.literal('active')).min(1).max(1).optional(),
  schedule: z.array(AccessScheduleWindowSchema).min(1).max(28),
}).openapi('DraftAccessPolicyRequest');
export type DraftAccessPolicyBody = z.infer<typeof DraftAccessPolicyBody>;

export const AccessPolicySchema = z
  .object({
    id: z.uuid(),
    deviceId: z.uuid(),
    facilityId: z.uuid(),
    allowedHolderKinds: z.array(z.enum(['person', 'household'])),
    allowedPassStatuses: z.array(z.literal('active')),
    schedule: z.array(AccessScheduleWindowSchema),
    status: z.enum(['draft', 'active', 'retired']),
    authoredByPersonId: z.uuid(),
    approvedByPersonId: z.uuid().nullable(),
    approvedAt: Instant.nullable(),
    retiredAt: Instant.nullable(),
    retiredReason: z.string().nullable(),
    createdAt: Instant,
    revision: Revision,
  })
  .openapi('AccessPolicy');
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;

export const ApproveAccessPolicyBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('ApproveAccessPolicyRequest');
export type ApproveAccessPolicyBody = z.infer<typeof ApproveAccessPolicyBody>;

export const RetireAccessPolicyBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('RetireAccessPolicyRequest');
export type RetireAccessPolicyBody = z.infer<typeof RetireAccessPolicyBody>;

// ---------------------------------------------------------------------------------------------
// Device commands (delivered by the job entry.deliver_device_commands, outside transactions)
// ---------------------------------------------------------------------------------------------

export const DeviceCommandStatusSchema = z
  .enum(['pending', 'delivered', 'failed', 'unknown', 'superseded'])
  .openapi('DeviceCommandStatus');
export type DeviceCommandStatus = z.infer<typeof DeviceCommandStatusSchema>;

export const DeviceCommandSchema = z
  .object({
    id: z.uuid(),
    deviceId: z.uuid(),
    kind: z.enum(['revoke_credential', 'sync_policy']),
    /** The revoked pass (revoke_credential); its reference is never stored or sent. */
    passId: z.uuid().nullable(),
    /** The policy a sync installs; null on a sync_policy means deny-all. */
    policyId: z.uuid().nullable(),
    status: DeviceCommandStatusSchema,
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    lastAttemptAt: Instant.nullable(),
    deliveredAt: Instant.nullable(),
    createdAt: Instant,
    revision: Revision,
  })
  .openapi('DeviceCommand');
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;

export const ListDeviceCommandsQuery = PageRequestSchema.extend({
  status: DeviceCommandStatusSchema.optional(),
});
export type ListDeviceCommandsQuery = z.infer<typeof ListDeviceCommandsQuery>;

// ---------------------------------------------------------------------------------------------
// Provider webhook events (the fake access-control provider; the vendor is not selected, DEC-023)
// ---------------------------------------------------------------------------------------------

/** IF-38 `device.heartbeat`: the device is alive at `at`. */
export const DeviceHeartbeatEventBody = z
  .object({
    id: z.string().min(1).max(200),
    type: z.literal('device.heartbeat'),
    data: z.object({ organizationId: z.uuid(), deviceRef: DeviceRef, at: Instant }),
  })
  .openapi('DeviceHeartbeatEvent');
export type DeviceHeartbeatEventBody = z.infer<typeof DeviceHeartbeatEventBody>;

/** IF-38 `device.command_receipt`: the device's own answer about a command (settles it once). */
export const DeviceCommandReceiptEventBody = z
  .object({
    id: z.string().min(1).max(200),
    type: z.literal('device.command_receipt'),
    data: z.object({
      organizationId: z.uuid(),
      commandId: z.uuid(),
      outcome: z.enum(['delivered', 'failed']),
    }),
  })
  .openapi('DeviceCommandReceiptEvent');
export type DeviceCommandReceiptEventBody = z.infer<typeof DeviceCommandReceiptEventBody>;

export const AccessControlWebhookBody = z
  .union([AccessControlEventBody, DeviceHeartbeatEventBody, DeviceCommandReceiptEventBody])
  .openapi('AccessControlWebhookEvent');
export type AccessControlWebhookBody = z.infer<typeof AccessControlWebhookBody>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

const IdParams = z.object({ id: z.uuid() });
const TAG = 'Entry';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });

function command(
  method: 'post' | 'patch',
  path: string,
  summary: string,
  body: z.ZodType,
  response: z.ZodType,
  status = 200,
) {
  openApiRegistry.registerPath({
    method,
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotencyHeader,
      body: { content: { 'application/json': { schema: body } } },
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err(
        'Access denied, or the access_hardware capability is disabled (CAPABILITY_DISABLED)',
      ),
      404: err('Not found or not visible'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
    },
  });
}

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape> | null,
  response: z.ZodType,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      query: request ?? undefined,
    },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

command(
  'post',
  '/access-devices',
  'Register an access device; it is sent deny-all until a policy is approved (capability access_hardware, DEC-016, DEC-080)',
  RegisterAccessDeviceBody,
  AccessDeviceSchema,
  201,
);
command(
  'patch',
  '/access-devices/{id}',
  'Rename a device or set its heartbeat timeout (capability access_hardware)',
  UpdateAccessDeviceBody,
  AccessDeviceSchema,
);
command(
  'post',
  '/access-devices/{id}/retire',
  'Retire an access device (never gated)',
  RetireAccessDeviceBody,
  AccessDeviceSchema,
);
command(
  'post',
  '/access-devices/{id}/policies',
  'Draft an access policy for a device; another person approves it (capability access_hardware)',
  DraftAccessPolicyBody,
  AccessPolicySchema,
  201,
);
command(
  'post',
  '/access-policies/{id}/approve',
  'Approve a drafted policy (not its author); the previous one retires and the device is synchronized (capability access_hardware)',
  ApproveAccessPolicyBody,
  AccessPolicySchema,
);
command(
  'post',
  '/access-policies/{id}/retire',
  'Retire a policy (a draft is withdrawn); without a replacement the device is sent deny-all (never gated)',
  RetireAccessPolicyBody,
  AccessPolicySchema,
);
query(
  '/access-devices',
  'Access devices of a facility',
  ListAccessDevicesQuery,
  pageSchema(AccessDeviceSchema),
);
query(
  '/access-devices/{id}/policies',
  'Access policies of a device (drafts, the active one and retired ones)',
  null,
  z.array(AccessPolicySchema),
);
query(
  '/access-devices/{id}/commands',
  'Commands queued for a device and their delivery outcomes',
  ListDeviceCommandsQuery,
  pageSchema(DeviceCommandSchema),
);
openApiRegistry.registerPath({
  method: 'post',
  path: '/webhooks/access-control/{provider}',
  summary:
    'Access hardware event, heartbeat or command receipt (signed); an access event is recorded as a visit only, never attendance or pickup (SPK-COND-004)',
  tags: [TAG],
  security: [],
  request: {
    params: z.object({ provider: z.string() }),
    body: { content: { 'application/json': { schema: AccessControlWebhookBody } } },
  },
  responses: {
    202: ok('Recorded in the inbox', z.object({ inboxEventId: z.uuid(), duplicate: z.boolean() })),
    401: err('Signature invalid'),
    404: err('Unknown provider'),
  },
});

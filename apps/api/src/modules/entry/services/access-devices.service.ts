import { Injectable, Inject } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type AccessDevice,
  type AccessPolicy,
  type DeviceCommand,
  type DraftAccessPolicyBody,
  type ListAccessDevicesQuery,
  type ListDeviceCommandsQuery,
  type Page,
  type Principal,
  type RegisterAccessDeviceBody,
  type RetireAccessDeviceBody,
  type RetireAccessPolicyBody,
  type ApproveAccessPolicyBody,
  type UpdateAccessDeviceBody,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  CLOCK,
  ensureUpdated,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type ActionDefinition,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  toAccessDevice,
  toAccessPolicy,
  toDeviceCommand,
  type AccessDeviceRow,
  type AccessPolicyRow,
} from '../access-hardware.shared';
import { EntryActions } from '../entry.actions';
import { EntryEvents } from '../entry.events';
import { organizationOf } from '../entry.shared';
import { AccessDeviceMachine, AccessPolicyMachine } from '../entry.state-machines';
import { ActivityResolver } from './activity-resolver';
import { DeviceCommandQueue } from './device-command-queue';

const DeviceCursor = z.object({ at: z.iso.datetime(), id: z.uuid() });
const CommandCursor = z.object({ at: z.iso.datetime(), id: z.uuid() });

/**
 * Access device inventory and access policies (ENT-05; §3.16 "Access hardware": device inventory,
 * access policy, revocation, outages, audit; SPK-COND-004).
 *
 * Whether the complex uses access hardware is pending (DEC-080; DEC-016): registering and editing
 * devices and drafting or approving policies require the organization's `access_hardware`
 * capability (CAPABILITY_DISABLED otherwise). Retiring devices and policies is never gated, and
 * neither are revocation commands, event ingestion or delivery (DeviceDeliveryService).
 *
 * Deny-all by default: a newly registered device is sent deny-all in the same transaction; an
 * approved policy (four eyes: never its author, database check) replaces the active one and is
 * sent to the device; retiring the active policy without a replacement sends deny-all again.
 * Facilities operators and general managers act (proposed roles); every change is audited and
 * announced (entry.access_device_changed). The device's heartbeat timeout is configuration with
 * no default: without it outages are not detected.
 */
@Injectable()
export class AccessDevicesService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly capabilities: CapabilityService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly resolver: ActivityResolver,
    private readonly queue: DeviceCommandQueue,
  ) {}

  async register(
    principal: Principal,
    body: RegisterAccessDeviceBody,
    correlationId: string | null,
  ): Promise<AccessDevice> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, EntryActions.registerAccessDevice, {
        type: 'facility',
        id: body.facilityId,
        organizationId,
        facilityId: body.facilityId,
      });
      await this.capabilities.require(organizationId, 'access_hardware', trx);
      await this.resolver.facility(organizationId, body.facilityId, trx);
      const now = this.clock.now();
      const device = await trx
        .insertInto('access_devices')
        .values({
          id: newId(),
          organization_id: organizationId,
          facility_id: body.facilityId,
          kind: body.kind,
          name: body.name,
          provider_device_ref: body.providerDeviceRef,
          heartbeat_timeout_seconds: body.heartbeatTimeoutSeconds ?? null,
          last_heartbeat_at: null,
          registered_at: now,
          registered_by: json(snapshotActor(principal)),
          registered_by_person_id: principal.personId,
          retired_at: null,
          retired_reason: null,
        })
        .onConflict((oc) => oc.constraint('access_devices_ref_unique').doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!device) {
        throw errors.resourceConflict(
          'A device with this provider reference is already registered (a retired device keeps its reference).',
          { code: 'device_ref_in_use', providerDeviceRef: body.providerDeviceRef },
        );
      }
      // Deny-all until a policy is approved (§3.16 access policy; nothing admits by default).
      await this.queue.syncPolicy(trx, principal, device, null, correlationId);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.registerAccessDevice.id,
        targetType: 'access_device',
        targetId: device.id,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId,
        details: {
          facilityId: device.facility_id,
          kind: device.kind,
          providerDeviceRef: device.provider_device_ref,
          heartbeatTimeoutSeconds: device.heartbeat_timeout_seconds,
        },
      });
      await this.changed(trx, device, 'registered', correlationId);
      return toAccessDevice(device, null);
    });
  }

  async update(
    principal: Principal,
    id: string,
    body: UpdateAccessDeviceBody,
    correlationId: string | null,
  ): Promise<AccessDevice> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const device = await this.requireDevice(trx, principal, id, EntryActions.updateAccessDevice);
      await this.capabilities.require(organizationId, 'access_hardware', trx);
      assertExpectedRevision(body.expectedRevision, device.revision);
      if (device.status !== 'active') {
        throw errors.invalidTransition('AccessDevice', device.status, 'update');
      }
      const changes: Record<string, unknown> = {};
      if (body.name !== undefined) changes['name'] = body.name;
      if (body.heartbeatTimeoutSeconds !== undefined) {
        changes['heartbeatTimeoutSeconds'] = body.heartbeatTimeoutSeconds;
      }
      const result = await trx
        .updateTable('access_devices')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.heartbeatTimeoutSeconds !== undefined
            ? { heartbeat_timeout_seconds: body.heartbeatTimeoutSeconds }
            : {}),
          revision: device.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', device.revision)
        .executeTakeFirst();
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(body.expectedRevision, device.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.updateAccessDevice.id,
        targetType: 'access_device',
        targetId: id,
        beforeRevision: device.revision,
        afterRevision: device.revision + 1,
        reason: body.reason ?? null,
        correlationId,
        details: changes,
      });
      const updated = await this.loadDevice(trx, organizationId, id);
      await this.changed(trx, updated, 'updated', correlationId);
      return toAccessDevice(updated, await this.activePolicyId(trx, updated));
    });
  }

  /** Retirement is never gated (DEC-016); the device's active policy retires and drafts withdraw. */
  async retire(
    principal: Principal,
    id: string,
    body: RetireAccessDeviceBody,
    correlationId: string | null,
  ): Promise<AccessDevice> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const device = await this.requireDevice(trx, principal, id, EntryActions.retireAccessDevice);
      assertExpectedRevision(body.expectedRevision, device.revision);
      const status = AccessDeviceMachine.next(device.status, 'retire');
      const now = this.clock.now();
      const result = await trx
        .updateTable('access_devices')
        .set({
          status,
          retired_at: now,
          retired_reason: body.reason,
          revision: device.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', device.revision)
        .executeTakeFirst();
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(body.expectedRevision, device.revision + 1),
      );
      const policies = await trx
        .selectFrom('access_policies')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('device_id', '=', id)
        .where('status', 'in', ['draft', 'active'])
        .forUpdate()
        .execute();
      for (const policy of policies) {
        await this.closePolicy(trx, principal, policy, 'The device was retired.', correlationId);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.retireAccessDevice.id,
        targetType: 'access_device',
        targetId: id,
        beforeRevision: device.revision,
        afterRevision: device.revision + 1,
        reason: body.reason,
        correlationId,
        details: { closedPolicyIds: policies.map((p) => p.id) },
      });
      const updated = await this.loadDevice(trx, organizationId, id);
      await this.changed(trx, updated, 'retired', correlationId);
      return toAccessDevice(updated, null);
    });
  }

  async draftPolicy(
    principal: Principal,
    deviceId: string,
    body: DraftAccessPolicyBody,
    correlationId: string | null,
  ): Promise<AccessPolicy> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const device = await this.requireDevice(
        trx,
        principal,
        deviceId,
        EntryActions.draftAccessPolicy,
      );
      await this.capabilities.require(organizationId, 'access_hardware', trx);
      if (device.status !== 'active') {
        throw errors.invalidTransition('AccessDevice', device.status, 'draft_policy');
      }
      const author = principal.personId;
      if (!author) {
        throw errors.accessDenied('An access policy is authored by a person (four eyes).', {
          code: 'author_required',
        });
      }
      const policy = await trx
        .insertInto('access_policies')
        .values({
          id: newId(),
          organization_id: organizationId,
          device_id: device.id,
          facility_id: device.facility_id,
          allowed_holder_kinds: [...body.allowedHolderKinds],
          allowed_pass_statuses: [...(body.allowedPassStatuses ?? ['active'])],
          schedule: json(body.schedule),
          authored_by: json(snapshotActor(principal)),
          authored_by_person_id: author,
          approved_by: null,
          approved_by_person_id: null,
          approved_at: null,
          retired_at: null,
          retired_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.draftAccessPolicy.id,
        targetType: 'access_policy',
        targetId: policy.id,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId,
        details: {
          deviceId: device.id,
          allowedHolderKinds: policy.allowed_holder_kinds,
          windows: body.schedule.length,
        },
      });
      await this.changed(trx, device, 'policy_drafted', correlationId);
      return toAccessPolicy(policy);
    });
  }

  /**
   * Approves a draft (four eyes: never its author, refused here and by the database). The active
   * policy of the device retires, this one becomes active and is sent to the device; undelivered
   * older synchronizations are superseded.
   */
  async approvePolicy(
    principal: Principal,
    id: string,
    body: ApproveAccessPolicyBody,
    correlationId: string | null,
  ): Promise<AccessPolicy> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const found = await this.loadPolicy(trx, organizationId, id);
      if (!found) throw errors.notFound('access_policy', id);
      // The device row is locked first: policy changes of one device are serialized.
      const device = await this.requireDevice(
        trx,
        principal,
        found.device_id,
        EntryActions.approveAccessPolicy,
      );
      await this.capabilities.require(organizationId, 'access_hardware', trx);
      const policy = (await this.loadPolicy(trx, organizationId, id, true)) ?? found;
      assertExpectedRevision(body.expectedRevision, policy.revision);
      const status = AccessPolicyMachine.next(policy.status, 'approve');
      if (!principal.personId || principal.personId === policy.authored_by_person_id) {
        throw errors.accessDenied('The author of an access policy cannot approve it (four eyes).', {
          code: 'author_cannot_approve',
        });
      }
      if (device.status !== 'active') {
        throw errors.invalidTransition('AccessDevice', device.status, 'approve_policy');
      }
      const previous = await trx
        .selectFrom('access_policies')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('device_id', '=', device.id)
        .where('status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();
      if (previous) {
        await this.closePolicy(
          trx,
          principal,
          previous,
          'Replaced by a newly approved policy.',
          correlationId,
        );
      }
      const now = this.clock.now();
      const result = await trx
        .updateTable('access_policies')
        .set({
          status,
          approved_by: json(snapshotActor(principal)),
          approved_by_person_id: principal.personId,
          approved_at: now,
          revision: policy.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', policy.revision)
        .executeTakeFirst()
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw errors.resourceConflict('Another policy of this device was just approved.', {
              code: 'policy_already_active',
            });
          }
          throw error;
        });
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(body.expectedRevision, policy.revision + 1),
      );
      const approved = (await this.loadPolicy(trx, organizationId, id)) as AccessPolicyRow;
      const facility = await this.resolver.facility(organizationId, device.facility_id, trx);
      await this.queue.syncPolicy(
        trx,
        principal,
        device,
        { row: approved, timezone: facility.timezone },
        correlationId,
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.approveAccessPolicy.id,
        targetType: 'access_policy',
        targetId: id,
        beforeRevision: policy.revision,
        afterRevision: policy.revision + 1,
        reason: body.reason ?? null,
        correlationId,
        details: { deviceId: device.id, replacedPolicyId: previous?.id ?? null },
      });
      await this.changed(trx, device, 'policy_activated', correlationId);
      return toAccessPolicy(approved);
    });
  }

  /**
   * Retires the active policy (the device is then sent deny-all) or withdraws a draft. Never gated
   * (DEC-016).
   */
  async retirePolicy(
    principal: Principal,
    id: string,
    body: RetireAccessPolicyBody,
    correlationId: string | null,
  ): Promise<AccessPolicy> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const found = await this.loadPolicy(trx, organizationId, id);
      if (!found) throw errors.notFound('access_policy', id);
      const device = await this.requireDevice(
        trx,
        principal,
        found.device_id,
        EntryActions.retireAccessPolicy,
      );
      const policy = (await this.loadPolicy(trx, organizationId, id, true)) ?? found;
      assertExpectedRevision(body.expectedRevision, policy.revision);
      const wasActive = policy.status === 'active';
      await this.closePolicy(trx, principal, policy, body.reason, correlationId);
      if (wasActive && device.status === 'active') {
        // No replacement: nothing is admitted until another policy is approved.
        await this.queue.syncPolicy(trx, principal, device, null, correlationId);
      }
      await this.changed(
        trx,
        device,
        wasActive ? 'policy_retired' : 'policy_withdrawn',
        correlationId,
      );
      return toAccessPolicy((await this.loadPolicy(trx, organizationId, id)) as AccessPolicyRow);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads (entry.read_access_devices; never gated)
  // -------------------------------------------------------------------------------------------

  async list(principal: Principal, query: ListAccessDevicesQuery): Promise<Page<AccessDevice>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EntryActions.readAccessDevices, {
      type: 'facility',
      id: query.facilityId,
      organizationId,
      facilityId: query.facilityId,
    });
    const db = this.uow.reader();
    const cursor = decodeCursor(query.cursor, DeviceCursor);
    let q = db
      .selectFrom('access_devices')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', query.facilityId)
      .orderBy('registered_at')
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) {
      q = q.where(
        sql<boolean>`(registered_at, id) > (${new Date(cursor.at)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const page = rows.slice(0, query.limit);
    const active = page.length
      ? await db
          .selectFrom('access_policies')
          .select(['id', 'device_id'])
          .where('organization_id', '=', organizationId)
          .where(
            'device_id',
            'in',
            page.map((d) => d.id),
          )
          .where('status', '=', 'active')
          .execute()
      : [];
    const last = rows.length > query.limit ? page[page.length - 1] : undefined;
    return {
      items: page.map((d) =>
        toAccessDevice(d, active.find((p) => p.device_id === d.id)?.id ?? null),
      ),
      nextCursor: last
        ? encodeCursor({ at: new Date(last.registered_at).toISOString(), id: last.id })
        : null,
    };
  }

  async policies(principal: Principal, deviceId: string): Promise<AccessPolicy[]> {
    const organizationId = organizationOf(principal);
    const db = this.uow.reader();
    await this.requireDevice(db, principal, deviceId, EntryActions.readAccessDevices, false);
    const rows = await db
      .selectFrom('access_policies')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('device_id', '=', deviceId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toAccessPolicy);
  }

  async commands(
    principal: Principal,
    deviceId: string,
    query: ListDeviceCommandsQuery,
  ): Promise<Page<DeviceCommand>> {
    const organizationId = organizationOf(principal);
    const db = this.uow.reader();
    await this.requireDevice(db, principal, deviceId, EntryActions.readAccessDevices, false);
    const cursor = decodeCursor(query.cursor, CommandCursor);
    let q = db
      .selectFrom('device_commands')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('device_id', '=', deviceId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) {
      q = q.where(
        sql<boolean>`(created_at, id) < (${new Date(cursor.at)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : undefined;
    return {
      items: page.map(toDeviceCommand),
      nextCursor: last
        ? encodeCursor({ at: new Date(last.created_at).toISOString(), id: last.id })
        : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /** Loads the device (locked inside a command) and authorizes the action at its facility. */
  private async requireDevice(
    db: Db | Trx,
    principal: Principal,
    id: string,
    action: ActionDefinition,
    lock = true,
  ): Promise<AccessDeviceRow> {
    const organizationId = organizationOf(principal);
    let q = db
      .selectFrom('access_devices')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (lock) q = q.forUpdate();
    const device = await q.executeTakeFirst();
    if (!device) throw errors.notFound('access_device', id);
    await this.authorization.require(principal, action, {
      type: 'access_device',
      id,
      organizationId,
      facilityId: device.facility_id,
    });
    return device;
  }

  /** Retires an active policy or withdraws a draft (AccessPolicyMachine), audited. */
  private async closePolicy(
    trx: Trx,
    principal: Principal,
    policy: AccessPolicyRow,
    reason: string,
    correlationId: string | null,
  ): Promise<void> {
    const event = policy.status === 'draft' ? 'withdraw' : 'retire';
    const status = AccessPolicyMachine.next(policy.status, event);
    const result = await trx
      .updateTable('access_policies')
      .set({
        status,
        retired_at: this.clock.now(),
        retired_reason: reason,
        revision: policy.revision + 1,
      })
      .where('organization_id', '=', policy.organization_id)
      .where('id', '=', policy.id)
      .where('revision', '=', policy.revision)
      .executeTakeFirst();
    ensureUpdated(result.numUpdatedRows, () =>
      errors.staleRevision(policy.revision, policy.revision + 1),
    );
    await this.audit.record(trx, {
      organizationId: policy.organization_id,
      actor: principal,
      action: EntryActions.retireAccessPolicy.id,
      targetType: 'access_policy',
      targetId: policy.id,
      beforeRevision: policy.revision,
      afterRevision: policy.revision + 1,
      reason,
      correlationId,
      details: { deviceId: policy.device_id, event, from: policy.status },
    });
  }

  private async changed(
    trx: Trx,
    device: AccessDeviceRow,
    change: string,
    correlationId: string | null,
  ): Promise<void> {
    await this.outbox.enqueue(trx, EntryEvents.accessDeviceChanged, {
      organizationId: device.organization_id,
      aggregateType: 'access_device',
      aggregateId: device.id,
      payload: { deviceId: device.id, change },
      correlationId,
    });
  }

  private async loadDevice(trx: Trx, organizationId: string, id: string) {
    return trx
      .selectFrom('access_devices')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  private async loadPolicy(trx: Trx, organizationId: string, id: string, lock = false) {
    let q = trx
      .selectFrom('access_policies')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async activePolicyId(trx: Trx, device: AccessDeviceRow): Promise<string | null> {
    const row = await trx
      .selectFrom('access_policies')
      .select('id')
      .where('organization_id', '=', device.organization_id)
      .where('device_id', '=', device.id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return row?.id ?? null;
  }
}

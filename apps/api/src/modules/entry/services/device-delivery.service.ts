import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DeviceCommandReceiptEventBody,
  DeviceHeartbeatEventBody,
  systemPrincipal,
  type Principal,
} from '@sportspark/contracts';
import { sql } from 'kysely';
import {
  AuditWriter,
  CLOCK,
  MODULE_SETTINGS,
  OperationalExceptions,
  Outbox,
  renewJobLease,
  runWithTransaction,
  UnitOfWork,
  type Clock,
  type InboundEvent,
  type PeriodicJobContext,
  type PeriodicJobResult,
  type Trx,
} from '../../../kernel';
import {
  DELIVER_DEVICE_COMMANDS_JOB,
  DETECT_DEVICE_OUTAGES_JOB,
  DEVICE_COMMAND_UNDELIVERED,
  DEVICE_OFFLINE,
  HARDWARE_QUEUE,
  type AccessDeviceRow,
  type DeviceCommandRow,
} from '../access-hardware.shared';
import { EntryEvents } from '../entry.events';
import {
  ACCESS_DEVICE_PORT,
  type AccessDeviceCommand,
  type AccessDeviceCommandResult,
  type AccessDevicePort,
} from '../entry.ports';
import type { EntrySettingsValue } from '../entry.settings';
import { DeviceCommandMachine, type DeviceCommandEvent } from '../entry.state-machines';
import { DeviceCommandQueue } from './device-command-queue';

interface ClaimedCommand {
  command: DeviceCommandRow;
  deviceRef: string;
  passReferenceHash: string | null;
}

/**
 * Device command delivery, receipts, heartbeats and outages (ENT-05; §3.16 "Access hardware":
 * revocation, outages, audit; §4.11 provider calls outside transactions; §4.12 durable background
 * work with a failure owner). None of this is gated by the `access_hardware` capability (DEC-016):
 * revocations and retirements must reach devices that already exist.
 *
 * - `entry.deliver_device_commands` (failure owner: facilities operator) sends each due command
 *   outside any transaction and records the outcome as a fact: delivered, failed (refused) or
 *   unknown (no answer). Failed and unknown commands are retried with an exponential backoff, and
 *   due commands are taken in turns per device, so one unreachable device never starves the
 *   others (`deliverDue`); after ENTRY_DEVICE_COMMAND_ESCALATE_AFTER_ATTEMPTS undelivered attempts
 *   (technical default 3) one `entry.device_command_undelivered` exception asks the facilities
 *   operator to look at the device. Only active devices are sent commands.
 * - A device's receipt (`device.command_receipt`) settles a pending or unknown command once; a
 *   duplicate or late receipt changes nothing.
 * - A heartbeat (`device.heartbeat`) marks the device online. `entry.detect_device_outages` marks
 *   it offline, and raises `entry.device_offline`, only when the device's heartbeat timeout is
 *   configured and exceeded; without a timeout (no default exists) its health is never judged.
 * - `entry.pass_revoked` queues a credential revocation for every active device.
 */
@Injectable()
export class DeviceDeliveryService {
  private readonly logger = new Logger(DeviceDeliveryService.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ACCESS_DEVICE_PORT) private readonly devices: AccessDevicePort,
    @Inject(MODULE_SETTINGS('entry')) private readonly settings: EntrySettingsValue,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly queue: DeviceCommandQueue,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Revocation (handler `entry.queue_device_revocations` on entry.pass_revoked)
  // -------------------------------------------------------------------------------------------

  async passRevoked(
    trx: Trx,
    organizationId: string,
    passId: string,
    correlationId: string | null,
  ): Promise<void> {
    const system = systemPrincipal(organizationId, 'entry.queue_device_revocations');
    await this.queue.revokeCredential(trx, system, organizationId, passId, correlationId);
  }

  // -------------------------------------------------------------------------------------------
  // Delivery job
  // -------------------------------------------------------------------------------------------

  /**
   * One pass of `entry.deliver_device_commands` (ASYNC-02; §3.16 a revocation reaches every
   * device, §4.12). A command is due when it is undelivered, its device is active, and it was never
   * attempted or its retry time has come. The first retry has no delay: it goes out on the next
   * pass that reaches the command, which is a later pass of the same run when the run makes more
   * than one pass (`remaining` > 0), otherwise the next run. The retry after attempt n (n ≥ 2)
   * waits ENTRY_DEVICE_COMMAND_RETRY_BASE_SECONDS·2^(n−2), at most
   * ENTRY_DEVICE_COMMAND_RETRY_MAX_SECONDS. Due commands are taken fairly: each device's commands
   * take turns (never attempted first, then the least recently attempted, then the oldest), and a
   * pass takes every device's first turn before any device's second, so an unreachable device
   * with a long backlog can never keep another device's commands from being sent. `remaining`
   * counts the due commands this pass could not take. After its second attempt a command is not
   * due again before its backoff, so later passes reach other commands instead of re-sending the
   * same ones. Each pass reads the clock afresh (`context.now`), so "at most twice in one run"
   * holds only while the run's passes finish within ENTRY_DEVICE_COMMAND_RETRY_BASE_SECONDS; a
   * slower run (an adapter waiting out its timeout on a dead door) can reach a command's next
   * retry in the same run.
   */
  async deliverDue(context: PeriodicJobContext): Promise<PeriodicJobResult> {
    const now = context.now;
    const base = this.settings.DEVICE_COMMAND_RETRY_BASE_SECONDS;
    const max = this.settings.DEVICE_COMMAND_RETRY_MAX_SECONDS;
    const retryDelaySeconds = sql<number>`case when c.attempts <= 1 then 0::float8 else least(${base}::float8 * power(2::float8, least(c.attempts - 2, 30)), ${max}::float8) end`;
    const due = await this.uow
      .reader()
      .with('due', (db) =>
        db
          .selectFrom('device_commands as c')
          .innerJoin('access_devices as d', (join) =>
            join
              .onRef('d.organization_id', '=', 'c.organization_id')
              .onRef('d.id', '=', 'c.device_id'),
          )
          .select(['c.id', 'c.organization_id', 'c.created_at', 'c.last_attempt_at'])
          .select(
            sql<number>`row_number() over (partition by c.organization_id, c.device_id order by c.last_attempt_at asc nulls first, c.created_at, c.id)`.as(
              'turn',
            ),
          )
          .where('c.status', 'in', ['pending', 'failed', 'unknown'])
          .where('d.status', '=', 'active')
          .where('c.created_at', '<=', now)
          .where(
            sql<boolean>`(c.last_attempt_at is null or c.last_attempt_at + make_interval(secs => ${retryDelaySeconds}) <= ${now}::timestamptz)`,
          ),
      )
      .selectFrom('due')
      .select(['id', 'organization_id'])
      .orderBy('turn')
      .orderBy('last_attempt_at', (ob) => ob.asc().nullsFirst())
      .orderBy('created_at')
      .orderBy('id')
      .limit(context.batchSize + 1)
      .execute();
    const batch = due.slice(0, context.batchSize);
    let processed = 0;
    for (const [index, { id, organization_id }] of batch.entries()) {
      // K-06 (ASYNC-06, SPK-AT-023): the run's lease is renewed before each provider call, outside
      // any transaction; once another runner holds the job (or the runner gave up on this run) no
      // further command is sent, and what is left stays due for the run that holds the job.
      if (!(await renewJobLease(context))) {
        return { processed, remaining: due.length - index };
      }
      if (await this.deliverOne(organization_id, id)) processed += 1;
    }
    return { processed, remaining: due.length - batch.length };
  }

  /** One command: claim (count the attempt) → send outside any transaction → record the outcome. */
  async deliverOne(organizationId: string, commandId: string): Promise<boolean> {
    const claimed = await this.claim(organizationId, commandId);
    if (!claimed) return false;
    const { command } = claimed;
    const request: AccessDeviceCommand = {
      organizationId,
      deviceRef: claimed.deviceRef,
      commandId: command.id,
      kind: command.kind,
      payload:
        command.kind === 'revoke_credential'
          ? { passReferenceHash: claimed.passReferenceHash ?? undefined }
          : command.policy_snapshot
            ? { policy: command.policy_snapshot }
            : {},
    };
    let result: AccessDeviceCommandResult;
    try {
      result = await this.devices.sendCommand(request);
    } catch (error) {
      // An adapter must not throw for an outcome; if it does, the outcome is not known.
      result = {
        outcome: 'unknown',
        error: error instanceof Error ? error.message.slice(0, 500) : 'adapter error',
      };
    }
    await this.recordOutcome(organizationId, command.id, result);
    return true;
  }

  private async claim(organizationId: string, commandId: string): Promise<ClaimedCommand | null> {
    return this.uow.run(async ({ trx }) => {
      const command = await trx
        .selectFrom('device_commands')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', commandId)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!command || !['pending', 'failed', 'unknown'].includes(command.status)) return null;
      const device = await trx
        .selectFrom('access_devices')
        .select(['provider_device_ref', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', command.device_id)
        .executeTakeFirstOrThrow();
      if (device.status !== 'active') return null;
      const status =
        command.status === 'pending'
          ? command.status
          : DeviceCommandMachine.next(command.status, 'retry');
      await trx
        .updateTable('device_commands')
        .set({
          status,
          settled_by: null,
          attempts: command.attempts + 1,
          last_attempt_at: this.clock.now(),
          revision: command.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', command.id)
        .where('revision', '=', command.revision)
        .execute();
      const pass = command.pass_id
        ? await trx
            .selectFrom('passes')
            .select('reference_hash')
            .where('organization_id', '=', organizationId)
            .where('id', '=', command.pass_id)
            .executeTakeFirst()
        : undefined;
      return {
        command: { ...command, status, attempts: command.attempts + 1 },
        deviceRef: device.provider_device_ref,
        passReferenceHash: pass?.reference_hash ?? null,
      };
    });
  }

  private async recordOutcome(
    organizationId: string,
    commandId: string,
    result: AccessDeviceCommandResult,
  ): Promise<void> {
    await this.uow.run(async ({ trx }) => {
      const command = await this.lockCommand(trx, organizationId, commandId);
      // Superseded meanwhile, or already settled by the device's receipt: nothing to record.
      if (!command || command.status !== 'pending') return;
      const event: DeviceCommandEvent =
        result.outcome === 'delivered' ? 'deliver' : result.outcome === 'failed' ? 'fail' : 'lose';
      const system = systemPrincipal(organizationId, DELIVER_DEVICE_COMMANDS_JOB);
      const settled = await this.settle(trx, system, command, event, 'adapter', {
        error: result.outcome === 'delivered' ? null : result.error,
      });
      if (settled.status !== 'delivered') await this.escalateIfDue(trx, settled);
    });
  }

  /**
   * After the configured number of undelivered attempts, one exception per command asks the
   * facilities operator to check the device (delivery keeps retrying).
   */
  private async escalateIfDue(trx: Trx, command: DeviceCommandRow): Promise<void> {
    const threshold = this.settings.DEVICE_COMMAND_ESCALATE_AFTER_ATTEMPTS;
    if (command.attempts < threshold || command.escalation_exception_id) return;
    const device = await this.loadDevice(trx, command.organization_id, command.device_id);
    const raised = await this.exceptions.raise(trx, {
      organizationId: command.organization_id,
      facilityId: device.facility_id,
      category: DEVICE_COMMAND_UNDELIVERED,
      severity: command.kind === 'revoke_credential' ? 'high' : 'warning',
      title:
        command.kind === 'revoke_credential'
          ? 'A revoked pass could not be removed from an access device'
          : 'An access policy could not be delivered to an access device',
      affectedType: 'device_command',
      affectedId: command.id,
      ownerQueue: HARDWARE_QUEUE,
      dedupeKey: `${DEVICE_COMMAND_UNDELIVERED}:${command.id}`,
      details: {
        deviceId: command.device_id,
        commandId: command.id,
        kind: command.kind,
        attempts: command.attempts,
        lastError: command.last_error,
        nextAction: 'check_the_device_or_retire_it',
      },
    });
    await trx
      .updateTable('device_commands')
      .set({ escalation_exception_id: raised.id, revision: command.revision + 1 })
      .where('organization_id', '=', command.organization_id)
      .where('id', '=', command.id)
      .where('revision', '=', command.revision)
      .execute();
  }

  // -------------------------------------------------------------------------------------------
  // Provider signals (inbox handler `entry.access_device_signal`)
  // -------------------------------------------------------------------------------------------

  async handleSignal(event: InboundEvent, trx: Trx): Promise<void> {
    await runWithTransaction(trx, async () => {
      if (!event.organizationId || !event.signatureVerified) return;
      if (event.eventType === 'device.command_receipt') {
        const parsed = DeviceCommandReceiptEventBody.safeParse(event.payload);
        if (!parsed.success || parsed.data.data.organizationId !== event.organizationId) return;
        await this.receipt(trx, event.organizationId, parsed.data);
      } else if (event.eventType === 'device.heartbeat') {
        const parsed = DeviceHeartbeatEventBody.safeParse(event.payload);
        if (!parsed.success || parsed.data.data.organizationId !== event.organizationId) return;
        await this.heartbeat(trx, event.organizationId, parsed.data);
      }
    });
  }

  /** A receipt settles a pending or unknown command once (IF-38); anything else changes nothing. */
  private async receipt(
    trx: Trx,
    organizationId: string,
    body: DeviceCommandReceiptEventBody,
  ): Promise<void> {
    const command = await this.lockCommand(trx, organizationId, body.data.commandId);
    if (!command || (command.status !== 'pending' && command.status !== 'unknown')) {
      if (!command) this.logger.warn(`receipt for unknown device command ${body.data.commandId}`);
      return;
    }
    const system = systemPrincipal(organizationId, 'entry.device_command_receipt');
    const settled = await this.settle(
      trx,
      system,
      command,
      body.data.outcome === 'delivered' ? 'deliver' : 'fail',
      'receipt',
      { error: body.data.outcome === 'delivered' ? null : 'the device reported a failure' },
    );
    if (settled.status !== 'delivered') await this.escalateIfDue(trx, settled);
  }

  /**
   * A heartbeat newer than the last one marks the device online, unless its configured timeout has
   * already passed since the heartbeat (a late, stale heartbeat proves nothing about now).
   */
  private async heartbeat(
    trx: Trx,
    organizationId: string,
    body: DeviceHeartbeatEventBody,
  ): Promise<void> {
    const device = await trx
      .selectFrom('access_devices')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('provider_device_ref', '=', body.data.deviceRef)
      .where('status', '=', 'active')
      .forUpdate()
      .executeTakeFirst();
    if (!device) return;
    const now = this.clock.now();
    const reported = new Date(body.data.at);
    const at = reported.getTime() > now.getTime() ? now : reported;
    const last = device.last_heartbeat_at ? new Date(device.last_heartbeat_at) : null;
    if (last && at.getTime() <= last.getTime()) return;
    const fresh =
      device.heartbeat_timeout_seconds === null ||
      at.getTime() + device.heartbeat_timeout_seconds * 1000 >= now.getTime();
    const health = fresh ? 'online' : device.health;
    await trx
      .updateTable('access_devices')
      .set({ last_heartbeat_at: at, health })
      .where('organization_id', '=', organizationId)
      .where('id', '=', device.id)
      .execute();
    if (health === device.health) return;
    const system = systemPrincipal(organizationId, 'entry.device_heartbeat');
    await this.healthChanged(trx, system, device, health);
    // The outage the operator was told about is over.
    const open = await this.exceptions.list(
      organizationId,
      {
        statuses: ['open', 'acknowledged'],
        category: DEVICE_OFFLINE,
        affectedType: 'access_device',
        affectedId: device.id,
      },
      trx,
    );
    for (const exception of open.items) {
      await this.exceptions.transition(trx, system, exception.id, 'resolved', {
        reason: 'The device sent a heartbeat.',
        resolution: { heartbeatAt: at.toISOString() },
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Outage job
  // -------------------------------------------------------------------------------------------

  async detectOutages(context: PeriodicJobContext): Promise<PeriodicJobResult> {
    const silent = await this.uow
      .reader()
      .selectFrom('access_devices')
      .select(['id', 'organization_id'])
      .where('status', '=', 'active')
      .where('heartbeat_timeout_seconds', 'is not', null)
      .where('health', '<>', 'offline')
      .where(
        sql<boolean>`coalesce(last_heartbeat_at, registered_at) + make_interval(secs => heartbeat_timeout_seconds) < ${context.now}::timestamptz`,
      )
      .orderBy('id')
      .limit(context.batchSize + 1)
      .execute();
    const batch = silent.slice(0, context.batchSize);
    let processed = 0;
    for (const { id, organization_id } of batch) {
      const marked = await this.uow.run(async ({ trx }) => {
        const device = await trx
          .selectFrom('access_devices')
          .selectAll()
          .where('organization_id', '=', organization_id)
          .where('id', '=', id)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (
          !device ||
          device.status !== 'active' ||
          device.health === 'offline' ||
          device.heartbeat_timeout_seconds === null
        ) {
          return false;
        }
        const since = new Date(device.last_heartbeat_at ?? device.registered_at);
        if (since.getTime() + device.heartbeat_timeout_seconds * 1000 >= context.now.getTime()) {
          return false;
        }
        await trx
          .updateTable('access_devices')
          .set({ health: 'offline' })
          .where('organization_id', '=', organization_id)
          .where('id', '=', id)
          .execute();
        const system = systemPrincipal(organization_id, DETECT_DEVICE_OUTAGES_JOB);
        await this.healthChanged(trx, system, device, 'offline');
        await this.exceptions.raise(trx, {
          organizationId: organization_id,
          facilityId: device.facility_id,
          category: DEVICE_OFFLINE,
          severity: 'warning',
          title: 'An access device stopped sending heartbeats',
          affectedType: 'access_device',
          affectedId: device.id,
          ownerQueue: HARDWARE_QUEUE,
          dedupeKey: `${DEVICE_OFFLINE}:${device.id}`,
          details: {
            deviceId: device.id,
            lastHeartbeatAt: device.last_heartbeat_at
              ? new Date(device.last_heartbeat_at).toISOString()
              : null,
            heartbeatTimeoutSeconds: device.heartbeat_timeout_seconds,
            nextAction: 'check_the_device_and_use_the_outage_procedure',
          },
        });
        return true;
      });
      if (marked) processed += 1;
    }
    return { processed, remaining: silent.length - batch.length };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private async settle(
    trx: Trx,
    principal: Principal,
    command: DeviceCommandRow,
    event: DeviceCommandEvent,
    settledBy: 'adapter' | 'receipt',
    input: { error: string | null },
  ): Promise<DeviceCommandRow> {
    const status = DeviceCommandMachine.next(command.status, event);
    const now = this.clock.now();
    const updated = await trx
      .updateTable('device_commands')
      .set({
        status,
        settled_by: status === 'delivered' || status === 'failed' ? settledBy : null,
        delivered_at: status === 'delivered' ? now : null,
        last_error: status === 'delivered' ? null : (input.error?.slice(0, 2000) ?? null),
        revision: command.revision + 1,
      })
      .where('organization_id', '=', command.organization_id)
      .where('id', '=', command.id)
      .where('revision', '=', command.revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId: command.organization_id,
      actor: principal,
      action: `entry.device_command_${status}`,
      targetType: 'device_command',
      targetId: command.id,
      beforeRevision: command.revision,
      afterRevision: updated.revision,
      details: {
        deviceId: command.device_id,
        kind: command.kind,
        attempts: command.attempts,
        settledBy,
        error: updated.last_error,
      },
    });
    if (status === 'delivered' && command.escalation_exception_id) {
      const open = await this.exceptions.get(
        command.organization_id,
        command.escalation_exception_id,
        trx,
      );
      if (open && (open.status === 'open' || open.status === 'acknowledged')) {
        await this.exceptions.transition(trx, principal, open.id, 'resolved', {
          reason: 'The command was delivered.',
          resolution: { deliveredAt: now.toISOString(), settledBy },
        });
      }
    }
    return updated;
  }

  private async healthChanged(
    trx: Trx,
    principal: Principal,
    device: AccessDeviceRow,
    health: 'online' | 'offline' | 'unknown',
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId: device.organization_id,
      actor: principal,
      action: 'entry.access_device_health',
      targetType: 'access_device',
      targetId: device.id,
      details: { from: device.health, to: health },
    });
    await this.outbox.enqueue(trx, EntryEvents.accessDeviceChanged, {
      organizationId: device.organization_id,
      aggregateType: 'access_device',
      aggregateId: device.id,
      payload: { deviceId: device.id, change: health },
      correlationId: null,
    });
  }

  private async lockCommand(trx: Trx, organizationId: string, id: string) {
    return trx
      .selectFrom('device_commands')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  private async loadDevice(trx: Trx, organizationId: string, id: string) {
    return trx
      .selectFrom('access_devices')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }
}

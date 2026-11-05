import { Inject, Injectable } from '@nestjs/common';
import { newId, type AccessScheduleWindow, type Principal } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { AuditWriter, CLOCK, snapshotActor, type Clock, type Trx } from '../../../kernel';
import {
  type AccessDeviceRow,
  type AccessPolicyRow,
  type DeviceCommandRow,
  type PolicySnapshot,
} from '../access-hardware.shared';
import { DeviceCommandMachine } from '../entry.state-machines';

/**
 * Queues device commands inside the caller's transaction (ENT-05, §4.11: the provider is called
 * later by the delivery job, outside any transaction).
 *
 * - A policy synchronization (`sync_policy`) carries the policy as sent, or nothing for deny-all.
 *   Queuing one supersedes the device's undelivered older synchronizations, so a retried older
 *   sync can never overwrite the newer policy (DeviceCommandMachine `supersede`).
 * - A credential revocation (`revoke_credential`) is queued once per device and pass (database
 *   unique index); the pass is named, and only its reference hash is ever sent.
 */
@Injectable()
export class DeviceCommandQueue {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditWriter,
  ) {}

  /** Queues the device's policy (null: deny-all), superseding older undelivered syncs. */
  async syncPolicy(
    trx: Trx,
    principal: Principal,
    device: AccessDeviceRow,
    policy: { row: AccessPolicyRow; timezone: string } | null,
    correlationId: string | null,
  ): Promise<DeviceCommandRow> {
    const older = await trx
      .selectFrom('device_commands')
      .select(['id', 'status', 'revision'])
      .where('organization_id', '=', device.organization_id)
      .where('device_id', '=', device.id)
      .where('kind', '=', 'sync_policy')
      .where('status', 'in', ['pending', 'failed', 'unknown'])
      .forUpdate()
      .execute();
    for (const command of older) {
      const status = DeviceCommandMachine.next(command.status, 'supersede');
      await trx
        .updateTable('device_commands')
        .set({ status, settled_by: null, revision: command.revision + 1 })
        .where('organization_id', '=', device.organization_id)
        .where('id', '=', command.id)
        .where('revision', '=', command.revision)
        .execute();
    }
    const snapshot: PolicySnapshot | null = policy
      ? {
          policyId: policy.row.id,
          allowedHolderKinds: [...policy.row.allowed_holder_kinds],
          allowedPassStatuses: [...policy.row.allowed_pass_statuses],
          schedule: policy.row.schedule as AccessScheduleWindow[],
          timezone: policy.timezone,
        }
      : null;
    const row = await trx
      .insertInto('device_commands')
      .values({
        id: newId(),
        organization_id: device.organization_id,
        device_id: device.id,
        kind: 'sync_policy',
        pass_id: null,
        policy_id: policy?.row.id ?? null,
        policy_snapshot: snapshot ? json(snapshot) : null,
        last_error: null,
        last_attempt_at: null,
        delivered_at: null,
        settled_by: null,
        escalation_exception_id: null,
        requested_by: json(snapshotActor(principal)),
        created_at: this.clock.now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId: device.organization_id,
      actor: principal,
      action: 'entry.queue_device_command',
      targetType: 'device_command',
      targetId: row.id,
      afterRevision: 1,
      correlationId,
      details: {
        deviceId: device.id,
        kind: row.kind,
        policyId: row.policy_id,
        denyAll: row.policy_id === null,
        superseded: older.map((c) => c.id),
      },
    });
    return row;
  }

  /**
   * Queues the revocation of a pass on every active device of the organization (passes carry no
   * facility). Replay-safe: a device that already has the revocation gets nothing new.
   */
  async revokeCredential(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    passId: string,
    correlationId: string | null,
  ): Promise<number> {
    const devices = await trx
      .selectFrom('access_devices')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .orderBy('id')
      .execute();
    const queued: string[] = [];
    for (const device of devices) {
      const row = await trx
        .insertInto('device_commands')
        .values({
          id: newId(),
          organization_id: organizationId,
          device_id: device.id,
          kind: 'revoke_credential',
          pass_id: passId,
          policy_id: null,
          policy_snapshot: null,
          last_error: null,
          last_attempt_at: null,
          delivered_at: null,
          settled_by: null,
          escalation_exception_id: null,
          requested_by: json(snapshotActor(principal)),
          created_at: this.clock.now(),
        })
        .onConflict((oc) =>
          oc
            .columns(['organization_id', 'device_id', 'pass_id'])
            .where('kind', '=', 'revoke_credential')
            .doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (row) queued.push(row.id);
    }
    if (queued.length > 0) {
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'entry.queue_device_command',
        targetType: 'pass',
        targetId: passId,
        correlationId,
        details: { kind: 'revoke_credential', commandIds: queued },
      });
    }
    return queued.length;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  systemPrincipal,
  type Principal,
  type PushDevice,
  type PushDeviceList,
  type RegisterPushDeviceInput,
  type RevokePushDeviceInput,
} from '@sportspark/contracts';
import { isUniqueViolation, type PushDevicesTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CommunicationsActions } from '../communications.actions';
import { PushDeviceRegistered, PushDeviceRevoked } from '../communications.events';
import { PushDeviceMachine } from '../communications.machines';
import { iso, isoOrNull, organizationOf, personOf } from '../communications.shared';
import { hashToken } from './calendar-feeds.service';

export type PushDeviceRow = Selectable<PushDevicesTable>;

/** Why a device stopped receiving pushes (stored in `revoked_reason`). */
export const PUSH_REVOKED_REREGISTERED = 'reregistered';
export const PUSH_REVOKED_ACCOUNT_RELINKED = 'account_relinked';

export function toPushDevice(row: PushDeviceRow): PushDevice {
  return {
    id: row.id,
    personId: row.person_id,
    accountId: row.account_id,
    platform: row.platform,
    tokenHint: row.token_hint,
    appVersion: row.app_version,
    status: row.status,
    registeredAt: iso(row.registered_at),
    lastSeenAt: iso(row.last_seen_at),
    revokedAt: isoOrNull(row.revoked_at),
    revokedReason: row.revoked_reason,
    revision: row.revision,
  };
}

/** The last characters of a token: all a response, an audit record or a log line ever shows. */
export function tokenHintOf(token: string): string {
  return token.slice(-4);
}

/**
 * Push device registration (COM-01; SPK-UX-001 "push notification registration", SPK-COMMS-003/004,
 * SPK-IAM-006, SPK-AT-025). A registration belongs to the signed-in account and its person; the
 * push channel addresses every active device of the recipient (RecipientAddresses).
 *
 * - Registering the token already active for this account refreshes it (last seen, app version):
 *   re-registration on every app launch is idempotent and keeps one row.
 * - The same token active for another account (another person signed in on the device) is
 *   revoked ('reregistered') and the new registration inserted, in one transaction; the partial
 *   unique index on the token hash guarantees one active registration per token, and a racing
 *   registration that loses the insert retries once.
 * - Revoking erases the token; a revoked device receives nothing. Account recovery (identity's
 *   `account_relinked`) revokes every device of the account last seen at or before the relink
 *   instant (`revokeForAccount`); one the recovered sign-in registers or refreshes afterwards
 *   stays active. That comparison orders two wall-clock stamps taken by different processes, so
 *   it assumes synchronized API clocks (see `revokeForAccount`).
 * The token is stored only while active and never returned, logged or audited (`tokenHint` only).
 */
@Injectable()
export class PushDevicesService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async register(
    principal: Principal,
    input: RegisterPushDeviceInput,
    correlationId: string | null,
  ): Promise<PushDevice> {
    const organizationId = organizationOf(principal);
    const personId = personOf(principal);
    const accountId = accountOf(principal);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.uow.run(async ({ trx }) =>
          toPushDevice(
            await this.registerIn(trx, principal, input, {
              organizationId,
              personId,
              accountId,
              correlationId,
            }),
          ),
        );
      } catch (error) {
        // A concurrent registration of the same token committed its row first: the next pass sees
        // it (refresh, or revoke-and-insert) instead of a second active row.
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }

  private async registerIn(
    trx: Trx,
    principal: Principal,
    input: RegisterPushDeviceInput,
    who: {
      organizationId: string;
      personId: string;
      accountId: string;
      correlationId: string | null;
    },
  ): Promise<PushDeviceRow> {
    const { organizationId, personId, accountId, correlationId } = who;
    await this.authorize(principal, organizationId, personId);
    const now = this.clock.now();
    const tokenHash = hashToken(input.token);
    const active = await trx
      .selectFrom('push_devices')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .where('status', '=', 'active')
      .forUpdate()
      .executeTakeFirst();
    if (active && active.organization_id === organizationId && active.account_id === accountId) {
      // Re-registration by the same account: one row, refreshed. The account's current person is
      // taken over so a device keeps addressing the account's person after a merge (SPK-IAM-007).
      await trx
        .updateTable('push_devices')
        .set({
          person_id: personId,
          platform: input.platform,
          app_version: input.appVersion ?? active.app_version,
          last_seen_at: now,
          revision: active.revision + 1,
        })
        .where('id', '=', active.id)
        .where('revision', '=', active.revision)
        .execute();
      return this.loadOrThrow(trx, organizationId, active.id);
    }
    let replaced: string | null = null;
    if (active) {
      // The device now belongs to another account: the older registration stops receiving pushes.
      await this.revokeRow(trx, active, PUSH_REVOKED_REREGISTERED, {
        actor: systemPrincipal(active.organization_id, 'communications.push_reregistered'),
        correlationId,
        reason: null,
      });
      replaced = active.id;
    }
    const id = newId();
    const tokenHint = tokenHintOf(input.token);
    await trx
      .insertInto('push_devices')
      .values({
        id,
        organization_id: organizationId,
        person_id: personId,
        account_id: accountId,
        platform: input.platform,
        token: input.token,
        token_hash: tokenHash,
        token_hint: tokenHint,
        app_version: input.appVersion ?? null,
        registered_at: now,
        last_seen_at: now,
        revoked_at: null,
        revoked_reason: null,
      })
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: CommunicationsActions.registerPushDevice.id,
      targetType: 'push_device',
      targetId: id,
      afterRevision: 1,
      reason: input.reason ?? null,
      correlationId,
      // §4.14: never the token, only its hint.
      details: {
        platform: input.platform,
        tokenHint,
        appVersion: input.appVersion ?? null,
        replacedDeviceId: replaced,
      },
    });
    await this.outbox.enqueue(trx, PushDeviceRegistered, {
      organizationId,
      aggregateType: 'push_device',
      aggregateId: id,
      payload: { deviceId: id, personId, accountId, platform: input.platform },
      correlationId,
    });
    return this.loadOrThrow(trx, organizationId, id);
  }

  async listMine(principal: Principal): Promise<PushDeviceList> {
    const organizationId = organizationOf(principal);
    const personId = personOf(principal);
    const accountId = accountOf(principal);
    await this.authorize(principal, organizationId, personId);
    const rows = await this.uow
      .reader()
      .selectFrom('push_devices')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('account_id', '=', accountId)
      .orderBy('registered_at', 'desc')
      .orderBy('id', 'desc')
      .limit(100)
      .execute();
    return { devices: rows.map(toPushDevice) };
  }

  async revoke(
    principal: Principal,
    id: string,
    input: RevokePushDeviceInput,
    correlationId: string | null,
  ): Promise<PushDevice> {
    const organizationId = organizationOf(principal);
    const personId = personOf(principal);
    const accountId = accountOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('push_devices')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      // Another account's device is not revealed (§4.10).
      if (!row || row.account_id !== accountId) throw errors.protectedNotFound('push device');
      await this.authorize(principal, organizationId, personId);
      assertExpectedRevision(input.expectedRevision, row.revision);
      await this.revokeRow(trx, row, input.reason, {
        actor: principal,
        correlationId,
        reason: input.reason,
      });
      return toPushDevice(await this.loadOrThrow(trx, organizationId, id));
    });
  }

  /**
   * SPK-AT-025, SPK-IAM-006 (`communications.revoke_push_on_relink`): the account was recovered
   * to another sign-in identity at `relinkedAt` (the event's `occurredAt`, stamped in the relink
   * transaction), so the devices registered under the old sign-in receive nothing more.
   *
   * §4.12: the handler applies the state the event describes, not the state at handler time.
   * After the relink commits, only the new sign-in resolves to the account. A device whose
   * `last_seen_at` is after `relinkedAt` is taken to have been registered, or refreshed with the
   * same token, by the recovered sign-in: its owner holds that device, so it stays active even
   * when the follow-up runs late (backlog, retry, a dead-lettered event requeued later).
   * Registration and refresh are the only writers of `last_seen_at`. A device last seen at or
   * before the relink instant is revoked. Replay-safe: an already revoked device is left as it
   * is, and a replay compares against the same instant.
   *
   * Assumption (not enforced here): `relinkedAt` comes from the clock of the process that ran
   * the relink, `last_seen_at` from the clock of the process that handled the registration or
   * refresh, so the comparison is only as good as the agreement between those clocks; all API
   * processes must share a synchronized clock. A registration or refresh by the old sign-in stays
   * active when its stamp falls after `relinkedAt`: one made up to the clock offset between the
   * two processes before the relink was stamped (an instance whose clock runs ahead, or a
   * backward clock step), or one authenticated before the relink committed and stamped after
   * it. The window is the clock offset plus the relink's commit latency plus the request's own
   * latency. The handler runs once and nothing re-checks the device afterwards, so such a device
   * keeps receiving pushes until the recovered owner revokes it
   * (`POST /me/push-devices/{id}/revoke`) or another account registers its token. A clock-free
   * comparison needs the sign-in generation on both sides (the relinked account revision in the
   * event, the account revision the principal was resolved at stored on the device row): an
   * identity/kernel follow-up, README "Known gaps".
   */
  async revokeForAccount(
    trx: Trx,
    organizationId: string,
    accountId: string,
    relinkedAt: Date,
    correlationId: string | null,
  ): Promise<number> {
    const rows = await trx
      .selectFrom('push_devices')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('account_id', '=', accountId)
      .where('status', '=', 'active')
      .where('last_seen_at', '<=', relinkedAt)
      .orderBy('id')
      .forUpdate()
      .execute();
    for (const row of rows) {
      await this.revokeRow(trx, row, PUSH_REVOKED_ACCOUNT_RELINKED, {
        actor: systemPrincipal(organizationId, 'communications.revoke_push_on_relink'),
        correlationId,
        reason: 'account recovered to another sign-in identity',
        details: { relinkedAt: relinkedAt.toISOString() },
      });
    }
    return rows.length;
  }

  private async revokeRow(
    trx: Trx,
    row: PushDeviceRow,
    revokedReason: string,
    options: {
      actor: Principal;
      correlationId: string | null;
      reason: string | null;
      details?: Record<string, string>;
    },
  ): Promise<void> {
    const to = PushDeviceMachine.next(row.status, 'revoke');
    const updated = await trx
      .updateTable('push_devices')
      .set({
        status: to,
        token: null,
        revoked_at: this.clock.now(),
        revoked_reason: revokedReason,
        revision: row.revision + 1,
      })
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw errors.staleRevision(row.revision, row.revision + 1);
    }
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: options.actor,
      action: 'communications.revoke_push_device',
      targetType: 'push_device',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      reason: options.reason,
      correlationId: options.correlationId,
      details: {
        revokedReason,
        tokenHint: row.token_hint,
        accountId: row.account_id,
        ...options.details,
      },
    });
    await this.outbox.enqueue(trx, PushDeviceRevoked, {
      organizationId: row.organization_id,
      aggregateType: 'push_device',
      aggregateId: row.id,
      payload: {
        deviceId: row.id,
        personId: row.person_id,
        accountId: row.account_id,
        reason: revokedReason,
      },
      correlationId: options.correlationId,
    });
  }

  private async authorize(
    principal: Principal,
    organizationId: string,
    personId: string,
  ): Promise<void> {
    await this.authorization.require(principal, CommunicationsActions.registerPushDevice, {
      type: 'push_device',
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
  }

  private async loadOrThrow(trx: Trx, organizationId: string, id: string): Promise<PushDeviceRow> {
    const row = await trx
      .selectFrom('push_devices')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('push device');
    return row;
  }
}

/** A push registration belongs to the signed-in account (customer-facing `/me` commands). */
function accountOf(principal: Principal): string {
  if (!principal.accountId) {
    throw errors.authenticationRequired('Push devices are registered by a signed-in account.');
  }
  return principal.accountId;
}

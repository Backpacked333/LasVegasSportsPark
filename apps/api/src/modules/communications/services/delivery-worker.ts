import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  systemPrincipal,
  type DeliveryFailureCodeValue,
  type DeliveryReceipt,
} from '@sportspark/contracts';
import { json, type Db, type DeliveryChannel } from '@sportspark/db';
import { sql } from 'kysely';
import {
  APP_CONFIG,
  AuditWriter,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  type AppConfig,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  DeliveryDelivered,
  DeliveryFailed,
  DeliveryProviderAccepted,
  DeliveryUnknown,
} from '../communications.events';
import { DeliveryAttemptMachine, type DeliveryEvent } from '../communications.machines';
import { COMMUNICATIONS_POLICY, type CommunicationsPolicy } from '../communications.policy';
import type { AttemptRow, NotificationRow, RecipientRow } from '../communications.shared';
import {
  CHANNEL_PROVIDERS,
  type ChannelProviderPort,
  type ChannelSendResult,
  type ExternalChannel,
} from '../ports';
import { AudienceResolver } from './audience-resolver';
import { NotificationsService } from './notifications.service';
import { RecipientAddresses } from './recipient-addresses';

export interface DeliverySummary {
  claimed: number;
  accepted: number;
  failed: number;
  unknown: number;
  revoked: number;
  skipped: number;
}
type DeliveryOutcome = Exclude<keyof DeliverySummary, 'claimed'>;

interface ClaimedAttempt {
  id: string;
  organization_id: string;
  notification_id: string;
  recipient_id: string;
  channel: DeliveryChannel;
  provider: string;
  attempted_at: Date | string | null;
}

type RecordedResult =
  ChannelSendResult | { outcome: 'failed'; error: string; failureCode: DeliveryFailureCodeValue };

/**
 * Hands queued external attempts to channel providers (SPK-COMMS-004, §4.11): claims a batch with a
 * lock lease (FOR UPDATE SKIP LOCKED), re-checks a protected recipient's authority immediately
 * before the hand-off (invariant 10, SPK-AT-017), resolves the address, records that the call is
 * about to happen, calls the provider OUTSIDE any transaction and records exactly the outcome the
 * provider gave. An interrupted hand-off is recorded as `unknown`, never retried blindly, so one
 * logical message is never sent twice because a worker died (§4.12).
 *
 * The kernel's outbox dispatcher runs handlers inside a transaction, so this worker is a separate
 * poller: the dispatch handler releases attempts (`ready_at`) and this loop delivers them.
 */
@Injectable()
export class DeliveryWorker {
  private readonly logger = new Logger(DeliveryWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(COMMUNICATIONS_POLICY) private readonly policy: CommunicationsPolicy,
    @Inject(CHANNEL_PROVIDERS) private readonly providers: ChannelProviderPort[],
    private readonly uow: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly resolver: AudienceResolver,
    private readonly addresses: RecipientAddresses,
    private readonly notifications: NotificationsService,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.tick(), this.config.OUTBOX_POLL_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Best-effort nudge after a dispatch commits; the poll loop is the durable path. */
  kick(): void {
    if (!this.started) return;
    setTimeout(() => void this.tick(), 25);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let summary = await this.runOnce();
      while (summary.claimed > 0) summary = await this.runOnce();
    } catch (error) {
      this.logger.error(`delivery loop failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Processes one batch; safe to call concurrently from several workers. */
  async runOnce(limit: number = this.policy.deliveryBatchSize): Promise<DeliverySummary> {
    const summary: DeliverySummary = {
      claimed: 0,
      accepted: 0,
      failed: 0,
      unknown: 0,
      revoked: 0,
      skipped: 0,
    };
    const claimed = await this.claim(limit);
    summary.claimed = claimed.length;
    for (const attempt of claimed) {
      const outcome = await this.deliver(attempt);
      summary[outcome] += 1;
    }
    return summary;
  }

  private async claim(limit: number): Promise<ClaimedAttempt[]> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.policy.deliveryLeaseSeconds * 1000);
    return this.db.transaction().execute(async (trx) => {
      const result = await sql<ClaimedAttempt>`
        with claimed as (
          select id from delivery_attempts
          where status = 'queued'
            and channel <> 'in_app'
            and ready_at is not null and ready_at <= ${now}
            and (locked_until is null or locked_until < ${now})
          order by ready_at, id
          limit ${limit}
          for update skip locked
        )
        update delivery_attempts a
        set locked_until = ${leaseUntil}
        from claimed
        where a.id = claimed.id
        returning a.id, a.organization_id, a.notification_id, a.recipient_id, a.channel, a.provider, a.attempted_at
      `.execute(trx);
      return result.rows;
    });
  }

  private async deliver(claimed: ClaimedAttempt): Promise<DeliveryOutcome> {
    const organizationId = claimed.organization_id;
    const notification = await this.notifications.load(
      this.db,
      organizationId,
      claimed.notification_id,
    );
    const recipient = await this.db
      .selectFrom('notification_recipients')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', claimed.recipient_id)
      .executeTakeFirst();
    if (!notification || !recipient || claimed.channel === 'in_app') return 'skipped';
    const channel: ExternalChannel = claimed.channel;

    // 1. Authority re-check immediately before the hand-off (SPK-COMMS-003, invariant 10).
    if (recipient.status !== 'authorized') {
      await this.record(claimed, notification, recipient, {
        outcome: 'failed',
        failureCode: 'RECIPIENT_REVOKED',
        error: 'recipient is no longer authorized',
      });
      return 'revoked';
    }
    if (notification.protected) {
      const ok = await this.resolver.isStillAuthorized(
        organizationId,
        {
          personId: recipient.person_id,
          basis: recipient.resolved_basis,
          basisDetail: recipient.basis_detail,
          subjectPersonIds: recipient.subject_person_ids,
        },
        notification.facility_id,
      );
      if (!ok) {
        await this.uow.run(({ trx }) =>
          this.notifications.revokeRecipient(
            trx,
            notification,
            recipient,
            'authority_revoked_before_handoff',
            notification.correlation_id,
          ),
        );
        return 'revoked';
      }
    }

    // 2. A hand-off that started but never recorded its outcome is not repeated blindly.
    if (claimed.attempted_at !== null) {
      await this.record(claimed, notification, recipient, {
        outcome: 'unknown',
        error: 'a previous hand-off was interrupted before its outcome was recorded',
      });
      return 'unknown';
    }

    // 3. Address resolution (contact points stay in identity).
    const address = await this.addresses.resolve(organizationId, recipient.person_id, channel);
    if (!address) {
      await this.record(claimed, notification, recipient, {
        outcome: 'failed',
        failureCode: 'NO_ADDRESS',
        error: `no ${channel} contact point for the recipient`,
      });
      return 'failed';
    }
    const provider = this.providers.find(
      (p) => p.name === claimed.provider && p.channel === channel,
    );
    if (!provider) {
      await this.record(claimed, notification, recipient, {
        outcome: 'failed',
        failureCode: 'PROVIDER_ERROR',
        error: `no ${channel} provider named ${claimed.provider} is registered`,
      });
      return 'failed';
    }

    // 4. Durable "about to call" mark, then the provider call outside any transaction (§4.11).
    await this.db
      .updateTable('delivery_attempts')
      .set({ attempted_at: this.clock.now() })
      .where('id', '=', claimed.id)
      .where('status', '=', 'queued')
      .execute();
    let result: ChannelSendResult;
    try {
      result = await provider.send({
        attemptId: claimed.id,
        organizationId,
        notificationId: notification.id,
        channel,
        personId: recipient.person_id,
        address,
        title: notification.title,
        body: notification.body,
        category: notification.category,
        correlationId: notification.correlation_id,
      });
    } catch (error) {
      result = {
        outcome: 'unknown',
        error: `provider adapter failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 5. Record exactly what the provider said.
    await this.record(claimed, notification, recipient, result);
    return result.outcome === 'accepted'
      ? 'accepted'
      : result.outcome === 'failed'
        ? 'failed'
        : 'unknown';
  }

  private async record(
    claimed: ClaimedAttempt,
    notification: NotificationRow,
    recipient: RecipientRow,
    result: RecordedResult,
  ): Promise<void> {
    await this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('delivery_attempts')
        .selectAll()
        .where('id', '=', claimed.id)
        .forUpdate()
        .executeTakeFirst();
      // A receipt or a revocation that landed first is an independent fact; never overwrite it (§4.6).
      if (!current || current.status !== 'queued') return;
      const event: DeliveryEvent =
        result.outcome === 'accepted'
          ? 'accept'
          : result.outcome === 'failed'
            ? 'fail'
            : 'lose_track';
      await this.applyTransition(trx, current, event, {
        notification,
        recipient,
        providerMessageId: result.outcome === 'accepted' ? result.providerMessageId : null,
        failureCode:
          result.outcome === 'failed'
            ? 'failureCode' in result
              ? result.failureCode
              : 'PROVIDER_REJECTED'
            : null,
        error: result.outcome === 'accepted' ? null : result.error,
        response: 'response' in result ? (result.response ?? null) : null,
        at: this.clock.now(),
        source: 'worker',
      });
    });
  }

  /**
   * Inbox handler core: a provider receipt resolves `queued`/`provider_accepted`/`unknown` into
   * accepted, delivered or failed. Duplicates and out-of-order receipts are ignored rather than
   * rewriting a later fact (§4.11 "tolerate duplicates and reordering").
   */
  async applyReceipt(
    trx: Trx,
    receipt: DeliveryReceipt,
    inboxEventId: string,
  ): Promise<'applied' | 'ignored' | 'unmatched'> {
    const current = await trx
      .selectFrom('delivery_attempts')
      .selectAll()
      .where('organization_id', '=', receipt.organizationId)
      .where('id', '=', receipt.attemptId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) return 'unmatched';
    if (
      current.provider_message_id !== null &&
      current.provider_message_id !== receipt.providerMessageId
    ) {
      return 'unmatched';
    }
    const event: DeliveryEvent =
      receipt.status === 'delivered' ? 'deliver' : receipt.status === 'failed' ? 'fail' : 'accept';
    if (!DeliveryAttemptMachine.can(current.status, event)) return 'ignored';
    const notification = await this.notifications.load(
      trx,
      current.organization_id,
      current.notification_id,
    );
    const recipient = await trx
      .selectFrom('notification_recipients')
      .selectAll()
      .where('id', '=', current.recipient_id)
      .executeTakeFirstOrThrow();
    if (!notification) return 'unmatched';
    await this.applyTransition(trx, current, event, {
      notification,
      recipient,
      providerMessageId: current.provider_message_id ?? receipt.providerMessageId,
      failureCode: receipt.status === 'failed' ? 'PROVIDER_REJECTED' : null,
      error: receipt.error,
      response: { inboxEventId, status: receipt.status },
      at: receipt.occurredAt ? new Date(receipt.occurredAt) : this.clock.now(),
      source: 'receipt',
    });
    return 'applied';
  }

  private async applyTransition(
    trx: Trx,
    current: AttemptRow,
    event: DeliveryEvent,
    input: {
      notification: NotificationRow;
      recipient: RecipientRow;
      providerMessageId: string | null;
      failureCode: DeliveryFailureCodeValue | null;
      error: string | null;
      response: Record<string, unknown> | null;
      at: Date;
      source: 'worker' | 'receipt';
    },
  ): Promise<void> {
    const organizationId = current.organization_id;
    const to = DeliveryAttemptMachine.next(current.status, event);
    const now = this.clock.now();
    await trx
      .updateTable('delivery_attempts')
      .set({
        status: to,
        provider_message_id: input.providerMessageId ?? current.provider_message_id,
        attempted_at: current.attempted_at ?? now,
        accepted_at:
          to === 'provider_accepted'
            ? input.at
            : (current.accepted_at ?? (to === 'delivered' ? input.at : null)),
        delivered_at: to === 'delivered' ? input.at : current.delivered_at,
        failed_at: to === 'failed' ? input.at : null,
        failure_code: to === 'failed' ? input.failureCode : null,
        error: input.error,
        provider_response: input.response ? json(input.response) : undefined,
        locked_until: null,
        revision: current.revision + 1,
      })
      .where('id', '=', current.id)
      .where('revision', '=', current.revision)
      .execute();
    const actor = systemPrincipal(organizationId, `communications.delivery_${input.source}`);
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: `communications.delivery_${to}`,
      targetType: 'delivery_attempt',
      targetId: current.id,
      beforeRevision: current.revision,
      afterRevision: current.revision + 1,
      correlationId: input.notification.correlation_id,
      details: {
        notificationId: current.notification_id,
        channel: current.channel,
        provider: current.provider,
        from: current.status,
        failureCode: input.failureCode,
        source: input.source,
      },
    });
    const payload = {
      attemptId: current.id,
      notificationId: current.notification_id,
      recipientId: current.recipient_id,
      channel: current.channel,
      provider: current.provider,
    };
    const envelope = {
      organizationId,
      aggregateType: 'delivery_attempt',
      aggregateId: current.id,
      correlationId: input.notification.correlation_id,
    };
    switch (to) {
      case 'provider_accepted':
        await this.outbox.enqueue(trx, DeliveryProviderAccepted, { ...envelope, payload });
        break;
      case 'delivered':
        await this.outbox.enqueue(trx, DeliveryDelivered, { ...envelope, payload });
        break;
      case 'unknown':
        await this.outbox.enqueue(trx, DeliveryUnknown, {
          ...envelope,
          payload: { ...payload, error: input.error },
        });
        break;
      case 'failed': {
        const failureCode = input.failureCode ?? 'PROVIDER_REJECTED';
        await this.outbox.enqueue(trx, DeliveryFailed, {
          ...envelope,
          payload: { ...payload, failureCode, error: input.error ?? failureCode },
        });
        // SPK-UX-006 "failed urgent communications": an essential notice that did not reach a
        // person is an operational exception for the front desk; revocations are not failures.
        if (input.notification.category === 'operational' && failureCode !== 'RECIPIENT_REVOKED') {
          await this.exceptions.raise(trx, {
            organizationId,
            facilityId: input.notification.facility_id,
            category: 'communications.delivery_failed',
            severity: 'warning',
            title: `${current.channel} delivery of "${input.notification.title}" failed (${failureCode})`,
            affectedType: 'delivery_attempt',
            affectedId: current.id,
            ownerQueue: 'front_desk',
            dedupeKey: `communications:delivery_attempt:${current.id}`,
            details: {
              notificationId: current.notification_id,
              recipientId: current.recipient_id,
              channel: current.channel,
              failureCode,
            },
          });
        }
        break;
      }
      default:
        break;
    }
  }
}

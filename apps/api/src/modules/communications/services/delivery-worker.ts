import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  systemPrincipal,
  type DeliveryFailureCodeValue,
  type DeliveryReceipt,
  type Principal,
  type ReconcileDeliveryInput,
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
  RecoveryMode,
} from '../../../kernel';
import {
  DeliveryDelivered,
  DeliveryFailed,
  DeliveryProviderAccepted,
  DeliveryUnknown,
} from '../communications.events';
import { DeliveryAttemptMachine, type DeliveryEvent } from '../communications.machines';
import { COMMUNICATIONS_POLICY, type CommunicationsPolicy } from '../communications.policy';
import {
  audienceOf,
  type AttemptRow,
  type NotificationRow,
  type RecipientRow,
} from '../communications.shared';
import {
  CHANNEL_PROVIDERS,
  type ChannelProviderPort,
  type ChannelSendResult,
  type ExternalChannel,
} from '../ports';
import { AudienceResolver } from './audience-resolver';
import { NotificationsService } from './notifications.service';
import { PreferencesService } from './preferences.service';
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
  /** The lease this worker's claim set: the attempt is ours only while `locked_until` still equals it. */
  lease_until: Date;
}

/** Exception category of an essential delivery whose hand-off outcome is unknown (§4.11, §5.11). */
export const DELIVERY_UNKNOWN_EXCEPTION = 'communications.delivery_unknown';

/** Who an outcome comes from: the worker's provider call, a provider receipt, or staff (§5.11). */
interface OperatorRecord {
  actor: Principal;
  action: string;
  reason: string | null;
  evidence: string;
  correlationId: string | null;
}

type RecordedResult =
  ChannelSendResult | { outcome: 'failed'; error: string; failureCode: DeliveryFailureCodeValue };

/** What the hand-off claim transaction decided: a recorded outcome, or a committed claim to send. */
type HandOff =
  | { kind: Exclude<DeliveryOutcome, 'accepted'> }
  | {
      kind: 'send';
      recipient: RecipientRow;
      addresses: string[];
      provider: ChannelProviderPort;
    };

/**
 * Hands queued external attempts to channel providers (SPK-COMMS-004, §4.11): claims a batch with a
 * lock lease (FOR UPDATE SKIP LOCKED), resolves the address, then in ONE transaction locks the
 * recipient and the attempt, re-checks a protected recipient's authority (invariant 10,
 * SPK-AT-017) and records that the call is about to happen (`attempted_at`, fenced on this worker's
 * lease); only after that claim commits does it call the provider, OUTSIDE any transaction, and
 * record exactly the outcome the provider gave. A revocation that commits first fails the attempt
 * and nothing is sent; one handled later sees the committed hand-off and leaves it alone, so the
 * record always matches what the provider received. An attempt another poller re-claimed after this
 * worker's lease expired is skipped, and an interrupted hand-off is recorded as `unknown`, never
 * retried blindly, so one logical message is never sent twice (§4.12).
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
  /** The drain in flight, so `stop` can wait for it (R3-OPERATIONS-10). */
  private inFlight: Promise<void> | null = null;

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
    private readonly recovery: RecoveryMode,
    private readonly preferences: PreferencesService,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.tick(), this.config.OUTBOX_POLL_INTERVAL_MS);
    void this.tick();
  }

  /**
   * R3-OPERATIONS-10 (§4.12, §5.8): stops claiming and resolves once the drain in flight has
   * recorded the outcome of every attempt it claimed, so a hand-off is not cut off by the process
   * exit and settled `unknown` later. The kernel awaits it, bounded by WORKER_SHUTDOWN_TIMEOUT_MS.
   */
  stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.inFlight ?? Promise.resolve();
  }

  /** Best-effort nudge after a dispatch commits; the poll loop is the durable path. */
  kick(): void {
    if (!this.started) return;
    setTimeout(() => void this.tick(), 25);
  }

  private tick(): Promise<void> {
    if (this.running || !this.started) return this.inFlight ?? Promise.resolve();
    this.running = true;
    this.inFlight = (async () => {
      try {
        // A stopping worker claims nothing more; the batch in hand is finished.
        let summary = await this.runOnce();
        while (this.started && summary.claimed > 0) summary = await this.runOnce();
      } catch (error) {
        this.logger.error(`delivery loop failed: ${String(error)}`);
      } finally {
        this.running = false;
        this.inFlight = null;
      }
    })();
    return this.inFlight;
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
    // R3-OPERATIONS-05 (§5.8, SPK-AT-028): nothing is handed to a messaging provider for an
    // organization recovering from a restore; its queued attempts wait, unclaimed, until
    // POST /v1/recovery/resume, so section 7 step 9 reviews notices before they are re-sent.
    const paused = await this.recovery.activeOrganizations();
    const notPaused =
      paused.length === 0
        ? sql``
        : sql`and organization_id not in (${sql.join(paused.map((id) => sql`${id}::uuid`))})`;
    return this.db.transaction().execute(async (trx) => {
      const result = await sql<ClaimedAttempt>`
        with claimed as (
          select id from delivery_attempts
          where status = 'queued'
            and channel <> 'in_app'
            and ready_at is not null and ready_at <= ${now}
            and (locked_until is null or locked_until < ${now})
            ${notPaused}
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
      return result.rows.map((row) => ({ ...row, lease_until: leaseUntil }));
    });
  }

  private async deliver(claimed: ClaimedAttempt): Promise<DeliveryOutcome> {
    const organizationId = claimed.organization_id;
    const notification = await this.notifications.load(
      this.db,
      organizationId,
      claimed.notification_id,
    );
    const loaded = await this.db
      .selectFrom('notification_recipients')
      .select('person_id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', claimed.recipient_id)
      .executeTakeFirst();
    if (!notification || !loaded || claimed.channel === 'in_app') return 'skipped';
    const channel: ExternalChannel = claimed.channel;

    // 1. Plain reads before any lock: the addresses (contact points stay in identity; push goes to
    // the person's active devices, COM-01) and the adapter.
    const addresses = await this.addresses.resolve(organizationId, loaded.person_id, channel);
    const provider = this.providers.find(
      (p) => p.name === claimed.provider && p.channel === channel,
    );

    // 2. The hand-off claim, atomically: re-check and "about to call" mark in one transaction.
    const handOff = await this.uow.run(({ trx }) =>
      this.claimHandOff(trx, claimed, notification, channel, addresses, provider),
    );
    if (handOff.kind !== 'send') return handOff.kind;

    // 3. The provider call, only after the claim committed and outside any transaction (§4.11).
    let result: ChannelSendResult;
    try {
      result = await handOff.provider.send({
        attemptId: claimed.id,
        organizationId,
        notificationId: notification.id,
        channel,
        personId: handOff.recipient.person_id,
        address: handOff.addresses[0] as string,
        addresses: handOff.addresses,
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

    // 4. Record exactly what the provider said.
    await this.record(claimed, notification, handOff.recipient, result);
    return result.outcome === 'accepted'
      ? 'accepted'
      : result.outcome === 'failed'
        ? 'failed'
        : 'unknown';
  }

  /**
   * Inside one transaction: lock the recipient and then the attempt (the order `revokeRecipient`
   * writes them, so the two never deadlock), re-check everything against the locked rows, and either
   * record an outcome that needs no provider call or commit the hand-off mark. Outcomes are applied
   * with `applyTransition` on this transaction; `record()` would open a second one and wait on the
   * locks held here.
   */
  private async claimHandOff(
    trx: Trx,
    claimed: ClaimedAttempt,
    notification: NotificationRow,
    channel: ExternalChannel,
    addresses: string[],
    provider: ChannelProviderPort | undefined,
  ): Promise<HandOff> {
    const organizationId = claimed.organization_id;
    const recipient = await trx
      .selectFrom('notification_recipients')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', claimed.recipient_id)
      .forUpdate()
      .executeTakeFirst();
    const current = await trx
      .selectFrom('delivery_attempts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', claimed.id)
      .forUpdate()
      .executeTakeFirst();
    if (!recipient || !current) return { kind: 'skipped' };
    // A receipt or a revocation that landed first is an independent fact; never overwrite it (§4.6).
    if (current.status !== 'queued') {
      return { kind: current.failure_code === 'RECIPIENT_REVOKED' ? 'revoked' : 'skipped' };
    }
    // §4.12: our lease expired and another poller re-claimed the attempt; it owns the hand-off now.
    const lockedUntil = current.locked_until === null ? null : new Date(current.locked_until);
    if (lockedUntil?.getTime() !== claimed.lease_until.getTime()) return { kind: 'skipped' };
    // Another worker's hand-off is in flight (or finished) since our claim: never a second call.
    if (current.attempted_at !== null && claimed.attempted_at === null) return { kind: 'skipped' };

    const fail = (failureCode: DeliveryFailureCodeValue, error: string): Promise<void> =>
      this.applyTransition(trx, current, 'fail', {
        notification,
        recipient,
        providerMessageId: null,
        failureCode,
        error,
        response: null,
        at: this.clock.now(),
        source: 'worker',
      });

    // Authority re-check immediately before the hand-off, on the locked rows (SPK-COMMS-003,
    // invariant 10), in the audience's facility scope (the one resolution used).
    if (recipient.status !== 'authorized') {
      await fail('RECIPIENT_REVOKED', 'recipient is no longer authorized');
      return { kind: 'revoked' };
    }
    if (notification.protected) {
      const audience = audienceOf(notification);
      const ok = await this.resolver.isStillAuthorized(
        organizationId,
        {
          personId: recipient.person_id,
          basis: recipient.resolved_basis,
          basisDetail: recipient.basis_detail,
          subjectPersonIds: recipient.subject_person_ids,
          audience,
        },
        audience.facilityId,
        trx,
      );
      if (!ok) {
        await this.notifications.revokeRecipient(
          trx,
          notification,
          recipient,
          'authority_revoked_before_handoff',
          notification.correlation_id,
        );
        return { kind: 'revoked' };
      }
    }

    // A hand-off that started but never recorded its outcome is not repeated blindly (§4.12).
    if (current.attempted_at !== null) {
      await this.applyTransition(trx, current, 'lose_track', {
        notification,
        recipient,
        providerMessageId: null,
        failureCode: null,
        error: 'a previous hand-off was interrupted before its outcome was recorded',
        response: null,
        at: this.clock.now(),
        source: 'worker',
      });
      return { kind: 'unknown' };
    }
    // SPK-COMMS-005: a notice superseded by a newer change or cancellation is never handed over;
    // the pointer is read inside this transaction, after the attempt lock (a supersede that
    // committed first has usually failed the attempt already; this covers one that did not).
    const superseded = await trx
      .selectFrom('notifications')
      .select('superseded_by_notification_id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', notification.id)
      .executeTakeFirst();
    if (superseded?.superseded_by_notification_id) {
      await fail(
        'SUPERSEDED',
        `superseded by notification ${superseded.superseded_by_notification_id} before hand-off`,
      );
      return { kind: 'skipped' };
    }
    // SPK-COMMS-007 (R4-COMMS-AUTOMATION-05): the person's channel choice is read again right
    // before the hand-off, so a channel switched off after dispatch (or a staff retry, or while
    // the organization was paused in recovery) is never used; the attempt fails CHANNEL_DISABLED.
    const enabled = await this.preferences.enabledChannels(
      trx,
      organizationId,
      recipient.person_id,
      notification.category,
    );
    if (!enabled.includes(channel)) {
      await fail(
        'CHANNEL_DISABLED',
        `the recipient switched ${channel} off for ${notification.category} notices before hand-off`,
      );
      return { kind: 'skipped' };
    }
    if (addresses.length === 0) {
      await fail(
        'NO_ADDRESS',
        channel === 'push'
          ? 'no active push device is registered for the recipient'
          : `no ${channel} contact point for the recipient`,
      );
      return { kind: 'failed' };
    }
    if (!provider) {
      await fail(
        'PROVIDER_ERROR',
        `no ${channel} provider named ${claimed.provider} is registered`,
      );
      return { kind: 'failed' };
    }

    // Durable "about to call" mark, fenced on the locked row, renewing the lease so another poller
    // does not take the attempt over while this single provider call is in flight.
    const now = this.clock.now();
    const marked = await trx
      .updateTable('delivery_attempts')
      .set({
        attempted_at: now,
        locked_until: new Date(now.getTime() + this.policy.deliveryLeaseSeconds * 1000),
        revision: current.revision + 1,
      })
      .where('id', '=', current.id)
      .where('revision', '=', current.revision)
      .where('status', '=', 'queued')
      .where('attempted_at', 'is', null)
      .executeTakeFirst();
    if (Number(marked.numUpdatedRows) !== 1) return { kind: 'skipped' };
    return { kind: 'send', recipient, addresses, provider };
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
   * rewriting a later fact (§4.11 "tolerate duplicates and reordering"). A receipt that resolves
   * an `unknown` attempt also resolves its `communications.delivery_unknown` exception.
   */
  async applyReceipt(
    trx: Trx,
    receipt: DeliveryReceipt,
    inboxEventId: string,
    provider: string,
  ): Promise<'applied' | 'ignored' | 'unmatched'> {
    const current = await trx
      .selectFrom('delivery_attempts')
      .selectAll()
      .where('organization_id', '=', receipt.organizationId)
      .where('id', '=', receipt.attemptId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) return 'unmatched';
    // §4.11: a receipt speaks only for attempts handed to the provider that sent it (an in-app
    // attempt, or another provider's, is never resolved by it).
    if (current.provider !== provider) return 'unmatched';
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

  /**
   * §4.11, §5.11 (R4-COMMS-AUTOMATION-07): the outcome staff established for an `unknown` hand-off
   * (the caller has locked the attempt, authorized the principal and checked the state). Recorded
   * like a receipt: the machine's `unknown → provider_accepted | delivered | failed`, the same
   * events, the failed-delivery exception of an essential notice, and the unknown exception
   * resolved; audited as the principal's command with the evidence. A failure is `PROVIDER_ERROR`
   * (the hand-off never reached the person), which a retry may then repeat (COM-02).
   */
  async recordReconciliation(
    trx: Trx,
    current: AttemptRow,
    notification: NotificationRow,
    recipient: RecipientRow,
    input: Pick<ReconcileDeliveryInput, 'outcome' | 'evidence'> & OperatorRecord,
  ): Promise<void> {
    const event: DeliveryEvent =
      input.outcome === 'provider_accepted'
        ? 'accept'
        : input.outcome === 'delivered'
          ? 'deliver'
          : 'fail';
    await this.applyTransition(trx, current, event, {
      notification,
      recipient,
      providerMessageId: null,
      failureCode: input.outcome === 'failed' ? 'PROVIDER_ERROR' : null,
      error:
        input.outcome === 'failed'
          ? `reconciled by staff as not delivered: ${input.evidence}`
          : null,
      response: { reconciledBy: 'staff', outcome: input.outcome },
      at: this.clock.now(),
      source: 'operator',
      operator: input,
    });
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
      source: 'worker' | 'receipt' | 'operator';
      /** Set for `operator`: who recorded the outcome, and on what evidence. */
      operator?: OperatorRecord;
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
    const operator = input.operator;
    const actor =
      operator?.actor ?? systemPrincipal(organizationId, `communications.delivery_${input.source}`);
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: operator?.action ?? `communications.delivery_${to}`,
      targetType: 'delivery_attempt',
      targetId: current.id,
      beforeRevision: current.revision,
      afterRevision: current.revision + 1,
      reason: operator?.reason ?? null,
      correlationId: operator ? operator.correlationId : input.notification.correlation_id,
      details: {
        notificationId: current.notification_id,
        channel: current.channel,
        provider: current.provider,
        from: current.status,
        to,
        failureCode: input.failureCode,
        source: input.source,
        ...(operator ? { evidence: operator.evidence } : {}),
      },
    });
    // §4.11, §5.11: an unknown outcome that is now known (a receipt, or staff) no longer needs the
    // front desk; its exception is resolved with the fact that settled it.
    if (current.status === 'unknown') {
      await this.settleUnknownException(trx, current, to, input.source);
    }
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
        // §4.11 "unknown kept explicit until reconciled", §5.11 owners and resolution actions
        // (R4-COMMS-AUTOMATION-07): an essential notice whose hand-off gave no trustworthy outcome
        // is the front desk's to reconcile (the integration register's reconciliation owner of
        // the messaging adapters). A receipt resolves it; otherwise staff record what they
        // established (POST /delivery-attempts/{id}/reconcile). Never retried blindly (§4.12).
        if (input.notification.category === 'operational') {
          await this.exceptions.raise(trx, {
            organizationId,
            facilityId: input.notification.facility_id,
            category: DELIVERY_UNKNOWN_EXCEPTION,
            severity: 'warning',
            title: `${current.channel} delivery of "${input.notification.title}" has an unknown outcome`,
            affectedType: 'delivery_attempt',
            affectedId: current.id,
            ownerQueue: 'front_desk',
            dedupeKey: `communications:delivery_attempt_unknown:${current.id}`,
            details: {
              notificationId: current.notification_id,
              recipientId: current.recipient_id,
              channel: current.channel,
              error: input.error,
            },
          });
        }
        break;
      case 'failed': {
        const failureCode = input.failureCode ?? 'PROVIDER_REJECTED';
        await this.outbox.enqueue(trx, DeliveryFailed, {
          ...envelope,
          payload: { ...payload, failureCode, error: input.error ?? failureCode },
        });
        // SPK-UX-006 "failed urgent communications": an essential notice that did not reach a
        // person is an operational exception for the front desk; revocations, superseded
        // (obsolete) notices and a channel the person switched off are not failures, and neither
        // is a push to a person who registered no device (COM-01: they have not installed or
        // allowed the app; the in-app notice of an essential kind is delivered regardless,
        // SPK-COMMS-007).
        if (
          input.notification.category === 'operational' &&
          failureCode !== 'RECIPIENT_REVOKED' &&
          failureCode !== 'SUPERSEDED' &&
          failureCode !== 'CHANNEL_DISABLED' &&
          !(current.channel === 'push' && failureCode === 'NO_ADDRESS')
        ) {
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

  /** Resolves the open `communications.delivery_unknown` exception of the attempt, if any. */
  private async settleUnknownException(
    trx: Trx,
    current: AttemptRow,
    to: string,
    source: 'worker' | 'receipt' | 'operator',
  ): Promise<void> {
    const open = await this.exceptions.list(
      current.organization_id,
      {
        category: DELIVERY_UNKNOWN_EXCEPTION,
        affectedType: 'delivery_attempt',
        affectedId: current.id,
        statuses: ['open', 'acknowledged'],
      },
      trx,
    );
    const system = systemPrincipal(
      current.organization_id,
      'communications.delivery_reconciliation',
    );
    for (const exception of open.items) {
      await this.exceptions.transition(trx, system, exception.id, 'resolved', {
        reason: `The delivery outcome is now known: ${to} (${source === 'operator' ? 'recorded by staff' : `from the ${source}`}).`,
        resolution: { attemptId: current.id, outcome: to, source },
      });
    }
  }
}

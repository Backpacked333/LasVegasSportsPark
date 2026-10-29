import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type DeliveryAttempt,
  type Principal,
  type RetryDeliveryInput,
} from '@sportspark/contracts';
import { isUniqueViolation } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
} from '../../../kernel';
import { CommunicationsActions } from '../communications.actions';
import { DeliveryRetryQueued } from '../communications.events';
import { audienceOf, organizationOf, toAttempt } from '../communications.shared';
import { CHANNEL_PROVIDERS, type ChannelProviderPort } from '../ports';
import { AudienceResolver } from './audience-resolver';
import { DeliveryWorker } from './delivery-worker';
import { NotificationsService } from './notifications.service';

/**
 * Retry of one failed delivery (COM-02; SPK-COMMS-004 "failed", SPK-UX-006 "failed urgent
 * communications", SPK-COMMS-003 and §4.7 invariant 10 for the recipient re-check).
 *
 * A retry is a NEW queued attempt on the same recipient and external channel naming the failed
 * attempt it retries; the failed fact stays as recorded (§4.6). Refused:
 * - an attempt that is not `failed` (INVALID_TRANSITION) — in particular an `unknown` outcome is
 *   never retried: the message may have reached the person and must not be sent twice (§4.12);
 * - an in-app attempt (the platform delivers those itself);
 * - a recipient who lost authority: failed with RECIPIENT_REVOKED, revoked since, or (protected
 *   notice) no longer authorized when re-checked now exactly as at dispatch (RESOURCE_CONFLICT
 *   `RECIPIENT_REVOKED`, nothing queued);
 * - an obsolete notice (SUPERSEDED, or superseded since: RESOURCE_CONFLICT `NOTICE_SUPERSEDED`);
 * - a second retry of the same attempt (`ALREADY_RETRIED`) or a recipient and channel that already
 *   have a live attempt (`LIVE_ATTEMPT_EXISTS`).
 * The database refuses the same violations (migration 1005). The delivery worker is nudged after
 * commit; its poll loop is the durable path, and its hand-off re-checks authority again.
 */
@Injectable()
export class DeliveryRetryService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CHANNEL_PROVIDERS) private readonly providers: ChannelProviderPort[],
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly resolver: AudienceResolver,
    private readonly notifications: NotificationsService,
    private readonly worker: DeliveryWorker,
  ) {}

  async retry(
    principal: Principal,
    attemptId: string,
    input: RetryDeliveryInput,
    correlationId: string | null,
  ): Promise<DeliveryAttempt> {
    const organizationId = organizationOf(principal);
    try {
      return await this.uow.run(async ({ trx, afterCommit }) => {
        const source = await trx
          .selectFrom('delivery_attempts')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', attemptId)
          .forUpdate()
          .executeTakeFirst();
        if (!source) throw errors.notFound('delivery_attempt', attemptId);
        const notification = await this.notifications.load(
          trx,
          organizationId,
          source.notification_id,
        );
        if (!notification) throw errors.notFound('delivery_attempt', attemptId);
        await this.authorization.require(principal, CommunicationsActions.retryDelivery, {
          type: 'delivery_attempt',
          id: source.id,
          organizationId,
          facilityId: notification.facility_id,
        });
        assertExpectedRevision(input.expectedRevision, source.revision);
        if (source.channel === 'in_app' || source.status !== 'failed') {
          throw errors.invalidTransition('DeliveryAttempt', source.status, 'retry');
        }
        if (
          source.failure_code === 'SUPERSEDED' ||
          notification.superseded_by_notification_id !== null
        ) {
          throw errors.resourceConflict('A newer notice replaced this one; it is not resent.', {
            code: 'NOTICE_SUPERSEDED',
            supersededByNotificationId: notification.superseded_by_notification_id,
          });
        }
        const recipient = await trx
          .selectFrom('notification_recipients')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', source.recipient_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const revoked = (): Error =>
          errors.resourceConflict('The recipient no longer holds the authority to receive it.', {
            code: 'RECIPIENT_REVOKED',
            recipientId: recipient.id,
          });
        if (source.failure_code === 'RECIPIENT_REVOKED' || recipient.status !== 'authorized') {
          throw revoked();
        }
        if (notification.protected) {
          // Re-checked exactly as at dispatch, in the audience's facility scope (invariant 10).
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
          if (!ok) throw revoked();
        }
        const retried = await trx
          .selectFrom('delivery_attempts')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('retry_of_attempt_id', '=', source.id)
          .executeTakeFirst();
        if (retried) {
          throw errors.resourceConflict('This delivery was already retried.', {
            code: 'ALREADY_RETRIED',
            retryAttemptId: retried.id,
          });
        }
        const live = await trx
          .selectFrom('delivery_attempts')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('recipient_id', '=', recipient.id)
          .where('channel', '=', source.channel)
          .where('status', '<>', 'failed')
          .executeTakeFirst();
        if (live) {
          throw errors.resourceConflict('A delivery on this channel is already under way.', {
            code: 'LIVE_ATTEMPT_EXISTS',
            attemptId: live.id,
          });
        }
        const provider =
          this.providers.find((p) => p.name === source.provider && p.channel === source.channel) ??
          this.providers.find((p) => p.channel === source.channel);
        if (!provider) throw errors.integrationUnavailable(`${source.channel} channel provider`);
        const id = newId();
        const now = this.clock.now();
        await trx
          .insertInto('delivery_attempts')
          .values({
            id,
            organization_id: organizationId,
            notification_id: source.notification_id,
            recipient_id: source.recipient_id,
            channel: source.channel,
            provider: provider.name,
            provider_message_id: null,
            status: 'queued',
            queued_at: now,
            ready_at: now,
            locked_until: null,
            attempted_at: null,
            accepted_at: null,
            delivered_at: null,
            failed_at: null,
            read_at: null,
            acknowledged_at: null,
            provider_response: null,
            failure_code: null,
            error: null,
            retry_of_attempt_id: source.id,
          })
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: CommunicationsActions.retryDelivery.id,
          targetType: 'delivery_attempt',
          targetId: id,
          afterRevision: 1,
          reason: input.reason,
          correlationId,
          details: {
            retryOfAttemptId: source.id,
            notificationId: source.notification_id,
            channel: source.channel,
            previousFailureCode: source.failure_code,
          },
        });
        await this.outbox.enqueue(trx, DeliveryRetryQueued, {
          organizationId,
          aggregateType: 'delivery_attempt',
          aggregateId: id,
          payload: {
            attemptId: id,
            notificationId: source.notification_id,
            recipientId: source.recipient_id,
            channel: source.channel,
            provider: provider.name,
            retryOfAttemptId: source.id,
          },
          correlationId,
        });
        afterCommit(() => this.worker.kick());
        const row = await trx
          .selectFrom('delivery_attempts')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return toAttempt(row);
      });
    } catch (error) {
      // A concurrent retry of the same attempt (or another live attempt) committed first.
      if (isUniqueViolation(error)) {
        throw errors.resourceConflict('This delivery was already retried.', {
          code: 'ALREADY_RETRIED',
        });
      }
      throw error;
    }
  }
}

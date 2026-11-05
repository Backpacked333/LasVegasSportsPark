import { Injectable } from '@nestjs/common';
import {
  errors,
  type DeliveryAttempt,
  type Principal,
  type ReconcileDeliveryInput,
} from '@sportspark/contracts';
import { AuthorizationService, UnitOfWork, assertExpectedRevision } from '../../../kernel';
import { CommunicationsActions } from '../communications.actions';
import { organizationOf, toAttempt } from '../communications.shared';
import { DeliveryWorker } from './delivery-worker';
import { NotificationsService } from './notifications.service';

/**
 * Reconciliation of one push, email or SMS delivery whose hand-off outcome is `unknown` (§4.11
 * "unknown kept explicit until reconciled", §5.11 "operational issues must have owners and
 * supported resolution actions", SPK-COMMS-004; R4-COMMS-AUTOMATION-07, R4-PROVIDER-OUTCOMES-07).
 *
 * The channel port has no status lookup (no messaging provider is selected, DEC-020), so a
 * provider that never received the request sends no receipt and the attempt would stay `unknown`
 * with nobody asked to act. An essential notice's unknown delivery raises a front-desk exception
 * (`communications.delivery_unknown`, DeliveryWorker); this command is its resolution action: staff
 * record what they established — `provider_accepted`, `delivered`, or `failed` (the message never
 * reached the person: failure code PROVIDER_ERROR, which a retry may then repeat, COM-02) — with
 * the evidence they checked. The outcome is recorded exactly as a receipt would be (same machine
 * transition, events, failed-delivery exception), audited as `communications.reconcile_delivery`.
 *
 * Refused: an attempt that is not `unknown`, or an in-app one (INVALID_TRANSITION), so a fact a
 * receipt or another reconciliation already recorded is never rewritten (§4.6); a stale
 * `expectedRevision` (STALE_REVISION).
 */
@Injectable()
export class DeliveryReconciliationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly notifications: NotificationsService,
    private readonly worker: DeliveryWorker,
  ) {}

  async reconcile(
    principal: Principal,
    attemptId: string,
    input: ReconcileDeliveryInput,
    correlationId: string | null,
  ): Promise<DeliveryAttempt> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('delivery_attempts')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', attemptId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('delivery_attempt', attemptId);
      const notification = await this.notifications.load(
        trx,
        organizationId,
        current.notification_id,
      );
      if (!notification) throw errors.notFound('delivery_attempt', attemptId);
      await this.authorization.require(principal, CommunicationsActions.reconcileDelivery, {
        type: 'delivery_attempt',
        id: current.id,
        organizationId,
        facilityId: notification.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      if (current.channel === 'in_app' || current.status !== 'unknown') {
        throw errors.invalidTransition('DeliveryAttempt', current.status, 'reconcile');
      }
      const recipient = await trx
        .selectFrom('notification_recipients')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', current.recipient_id)
        .executeTakeFirstOrThrow();
      await this.worker.recordReconciliation(trx, current, notification, recipient, {
        outcome: input.outcome,
        evidence: input.evidence,
        actor: principal,
        action: CommunicationsActions.reconcileDelivery.id,
        reason: input.reason ?? null,
        correlationId,
      });
      const row = await trx
        .selectFrom('delivery_attempts')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', current.id)
        .executeTakeFirstOrThrow();
      return toAttempt(row);
    });
  }
}

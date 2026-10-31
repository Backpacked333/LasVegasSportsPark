import { Inject, Injectable } from '@nestjs/common';
import { newId, systemPrincipal, type DomainEvent, type EventPayload } from '@sportspark/contracts';
import {
  json,
  type JsonObject,
  type TimelineRecordType,
  type TimelineRelation,
} from '@sportspark/db';
import { runWithTransaction, type HandlerContext, type Trx } from '../../../kernel';
import { NotificationDispatched, NotificationsService } from '../../communications';
import { ROSTER_PORT, type RosterPort } from '../../competition';
import {
  OrderPaid,
  PaymentFailed,
  PaymentOutcomeUnknown,
  PaymentReceived,
  PaymentsService,
  RefundRequested,
  RefundSettled,
  RefundsService,
} from '../../finance';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { EventChanged } from '../../scheduling';

/**
 * The event types the timeline index is built from (SPK-SUPPORT-001): the live handlers in
 * SupportModule and the replay of the outbox history (SUP-03) index exactly these.
 */
export const INDEXED_EVENT_TYPES: readonly string[] = [
  PaymentReceived.type,
  PaymentFailed.type,
  PaymentOutcomeUnknown.type,
  RefundRequested.type,
  RefundSettled.type,
  OrderPaid.type,
  NotificationDispatched.type,
  EventChanged.type,
];

interface IndexRow {
  personId: string;
  recordType: TimelineRecordType;
  recordId: string;
  relation: TimelineRelation;
  facilityId?: string | null;
  summary?: JsonObject;
}

/**
 * Timeline reference index (SPK-SUPPORT-001). Outbox handlers note, from the owning modules'
 * events, which of their records concern which person: payments and refunds (the payer), orders
 * (the payer), dispatched messages (each recipient and each subject person) and schedule changes
 * of published events (committed people and the effective roster of committed teams). Lookups go
 * through the owning modules' exported services inside the handler's transaction; the index holds
 * identifiers and non-sensitive change facts only. Handlers are idempotent under replay: the
 * kernel records one consumption per handler and event, and the unique key refuses duplicates.
 * The same key makes a replay of the outbox history (SUP-03) a no-op for events already indexed.
 * A person merge rewrites nothing here (SUP-05): reads expand a person with identity's
 * `personIdsResolvingTo`, so the merged person's references belong to the survivor's timeline.
 */
@Injectable()
export class TimelineIndexer {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly notifications: NotificationsService,
    @Inject(ROSTER_PORT) private readonly rosters: RosterPort,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
  ) {}

  async onPayment(
    event: DomainEvent<
      | EventPayload<typeof PaymentReceived>
      | EventPayload<typeof PaymentFailed>
      | EventPayload<typeof PaymentOutcomeUnknown>
    >,
    ctx: HandlerContext,
  ): Promise<void> {
    const paymentAttemptId = event.payload.paymentAttemptId;
    // A cash tender carries no payment attempt: the timeline reads tenders from finance (SUP-03).
    if (!paymentAttemptId) return;
    const payment = await this.payments.load(ctx.trx, event.organizationId, paymentAttemptId);
    if (!payment) return;
    await this.insert(ctx.trx, event, [
      {
        personId: payment.payer_person_id,
        recordType: 'payment_attempt',
        recordId: payment.id,
        relation: 'payer',
        summary: {
          event: event.type,
          amountMinor: payment.amount_minor,
          currency: payment.currency,
          purpose: payment.purpose,
        },
      },
    ]);
  }

  async onRefund(
    event: DomainEvent<EventPayload<typeof RefundRequested> | EventPayload<typeof RefundSettled>>,
    ctx: HandlerContext,
  ): Promise<void> {
    const payment = await this.payments.load(
      ctx.trx,
      event.organizationId,
      event.payload.paymentAttemptId,
    );
    const refund = await this.refunds.load(
      ctx.trx,
      event.organizationId,
      event.payload.refundAttemptId,
    );
    if (!payment || !refund) return;
    await this.insert(ctx.trx, event, [
      {
        personId: payment.payer_person_id,
        recordType: 'refund_attempt',
        recordId: refund.id,
        relation: 'payer',
        summary: {
          event: event.type,
          amountMinor: refund.amount_minor,
          currency: refund.currency,
          purpose: refund.purpose,
          paymentAttemptId: payment.id,
        },
      },
    ]);
  }

  async onOrderPaid(
    event: DomainEvent<EventPayload<typeof OrderPaid>>,
    ctx: HandlerContext,
  ): Promise<void> {
    await this.insert(ctx.trx, event, [
      {
        personId: event.payload.payerPersonId,
        recordType: 'order',
        recordId: event.payload.orderId,
        relation: 'payer',
        summary: {
          event: event.type,
          amountMinor: event.payload.totalMinor,
          currency: event.payload.currency,
        },
      },
    ]);
  }

  /** Recipients and the people a message was about (who justified each recipient). */
  async onNotificationDispatched(
    event: DomainEvent<EventPayload<typeof NotificationDispatched>>,
    ctx: HandlerContext,
  ): Promise<void> {
    const deliveries = await runWithTransaction(ctx.trx, () =>
      this.notifications.deliveries(
        systemPrincipal(event.organizationId, 'support.timeline_index'),
        event.payload.notificationId,
      ),
    );
    const n = deliveries.notification;
    const rows: IndexRow[] = [];
    const summary = { event: event.type, kind: n.kind, category: n.category };
    for (const recipient of deliveries.recipients) {
      rows.push({
        personId: recipient.personId,
        recordType: 'notification',
        recordId: n.id,
        relation: 'recipient',
        facilityId: n.facilityId,
        summary,
      });
      for (const subject of recipient.subjectPersonIds) {
        if (subject === recipient.personId) continue;
        rows.push({
          personId: subject,
          recordType: 'notification',
          recordId: n.id,
          relation: 'subject',
          facilityId: n.facilityId,
          summary,
        });
      }
    }
    await this.insert(ctx.trx, event, rows);
  }

  /** Changes of published events: committed people and the roster of committed teams. */
  async onEventChanged(
    event: DomainEvent<EventPayload<typeof EventChanged>>,
    ctx: HandlerContext,
  ): Promise<void> {
    const p = event.payload;
    if (p.before?.status !== 'published' && p.after?.status !== 'published') return; // drafts are not changes customers saw (SPK-SCHED-005)
    const at = new Date(p.after?.scheduledStart ?? p.before?.scheduledStart ?? event.occurredAt);
    const summary: JsonObject = {
      event: event.type,
      change: p.change,
      title: p.after?.title ?? p.before?.title ?? null,
      before: p.before
        ? { start: p.before.scheduledStart, end: p.before.scheduledEnd, status: p.before.status }
        : null,
      after: p.after
        ? { start: p.after.scheduledStart, end: p.after.scheduledEnd, status: p.after.status }
        : null,
    };
    const rows: IndexRow[] = [];
    for (const c of p.commitments) {
      if (c.partyType === 'person') {
        rows.push({
          personId: c.partyId,
          recordType: 'scheduling_event',
          recordId: p.eventId,
          relation: 'committed_party',
          facilityId: p.facilityId,
          summary,
        });
      } else if (c.partyType === 'team') {
        const roster = await this.rosters.effectiveRoster(
          event.organizationId,
          c.partyId,
          at,
          ctx.trx,
        );
        for (const member of roster) {
          rows.push({
            personId: member.personId,
            recordType: 'scheduling_event',
            recordId: p.eventId,
            relation: 'team_member',
            facilityId: p.facilityId,
            summary: { ...summary, teamEntryId: c.partyId },
          });
        }
      }
    }
    await this.insert(ctx.trx, event, rows);
  }

  /**
   * Indexes one committed event of an indexed type (SUP-03 replay), as its live handler would;
   * other types are ignored. Returns whether the type is indexed.
   */
  async index(event: DomainEvent<unknown>, ctx: HandlerContext): Promise<boolean> {
    switch (event.type) {
      case PaymentReceived.type:
      case PaymentFailed.type:
      case PaymentOutcomeUnknown.type:
        await this.onPayment(event as Parameters<TimelineIndexer['onPayment']>[0], ctx);
        return true;
      case RefundRequested.type:
      case RefundSettled.type:
        await this.onRefund(event as Parameters<TimelineIndexer['onRefund']>[0], ctx);
        return true;
      case OrderPaid.type:
        await this.onOrderPaid(event as Parameters<TimelineIndexer['onOrderPaid']>[0], ctx);
        return true;
      case NotificationDispatched.type:
        await this.onNotificationDispatched(
          event as Parameters<TimelineIndexer['onNotificationDispatched']>[0],
          ctx,
        );
        return true;
      case EventChanged.type:
        await this.onEventChanged(event as Parameters<TimelineIndexer['onEventChanged']>[0], ctx);
        return true;
      default:
        return false;
    }
  }

  private async insert(trx: Trx, event: DomainEvent<unknown>, rows: IndexRow[]): Promise<void> {
    if (rows.length === 0) return;
    // Only people of the organization are indexed (the composite foreign key refuses others).
    const ids = [...new Set(rows.map((r) => r.personId))];
    // §4.2: through identity's person directory, never its tables.
    const known = new Set<string>();
    for (const id of ids) {
      const person = await this.persons.findPerson(event.organizationId, id, trx);
      if (person) known.add(person.id);
    }
    const seen = new Set<string>();
    const values = rows
      .filter((r) => {
        const key = `${r.personId}:${r.recordType}:${r.recordId}`;
        if (!known.has(r.personId) || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => ({
        id: newId(),
        organization_id: event.organizationId,
        person_id: r.personId,
        record_type: r.recordType,
        record_id: r.recordId,
        relation: r.relation,
        facility_id: r.facilityId ?? null,
        occurred_at: new Date(event.occurredAt),
        source_event_id: event.id,
        source_event_type: event.type,
        summary: json(r.summary ?? {}),
      }));
    if (values.length === 0) return;
    await trx
      .insertInto('timeline_references')
      .values(values)
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'source_event_id', 'person_id', 'record_type', 'record_id'])
          .doNothing(),
      )
      .execute();
  }
}

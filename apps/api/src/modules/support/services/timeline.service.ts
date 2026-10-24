import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  z,
  type CustomerTimeline,
  type Principal,
  type TimelineEntry,
  type TimelinePerson,
  type TimelineQuery,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { AuthorizationService, CLOCK, DATABASE, type Clock } from '../../../kernel';
import { NotificationsService } from '../../communications';
import { ApplicationsService, EnrollmentsService, SessionBookingsService } from '../../enrollment';
import {
  CheckoutService,
  CreditsService,
  ObligationsService,
  PaymentsService,
  RefundsService,
} from '../../finance';
import {
  PERSON_DIRECTORY_PORT,
  PeopleService,
  RelationshipAuthority,
  type PersonDirectoryPort,
} from '../../identity';
import { EventsService } from '../../scheduling';
import { SupportActions } from '../support.actions';
import { SUPPORT_POLICY, type SupportPolicy } from '../support.policy';
import { iso, isPermissionError, organizationOf, type CaseRow } from '../support.shared';
import { CasesService } from './cases.service';

const Cursor = z.object({ at: z.iso.datetime(), id: z.string().min(1).max(500) });

type SourceStatus = 'ok' | 'not_permitted' | 'unavailable';
type EntryInput = Omit<TimelineEntry, 'details' | 'amount' | 'facilityId' | 'status'> & {
  details?: Record<string, unknown>;
  amount?: { amountMinor: number; currency: string } | null;
  facilityId?: string | null;
  status?: string | null;
};

/** Accumulates entries for the people in scope; anyone else is never named (§4.7 invariant 1). */
class Collector {
  readonly entries: TimelineEntry[] = [];
  readonly sources: Array<{ source: string; status: SourceStatus; count: number }> = [];

  /** Records still naming a person merged into someone in scope belong to the survivor. */
  readonly aliases = new Map<string, string>();

  constructor(readonly scope: ReadonlySet<string>) {}

  inScope(personId: string | null | undefined): string | null {
    if (!personId) return null;
    if (this.scope.has(personId)) return personId;
    return this.aliases.get(personId) ?? null;
  }

  /** The person in scope and every merged record id that now stands for them. */
  idsOf(personId: string): Set<string> {
    const ids = new Set([personId]);
    for (const [alias, survivor] of this.aliases) if (survivor === personId) ids.add(alias);
    return ids;
  }

  add(entry: EntryInput): void {
    this.entries.push({
      ...entry,
      status: entry.status ?? null,
      amount: entry.amount ?? null,
      facilityId: entry.facilityId ?? null,
      details: entry.details ?? {},
    });
  }
}

/**
 * Scoped customer timeline (SPK-SUPPORT-001): registration, participation, orders, payments,
 * refunds, credits, obligations, schedule changes, messages and support cases of one person and
 * the people they currently hold `view` over (their dependents). Every record is read through the
 * owning module's exported service WITH THE OPERATOR'S PRINCIPAL, so that module's authorization
 * decides what the operator sees: a source the operator may not read contributes nothing and is
 * reported as `not_permitted`. Staff never use the customer's credentials (SPK-SUPPORT-002,
 * SPK-AT-026). The timeline never carries card data or provider references; other people appear
 * only as counts; children appear by given name only, without date of birth or contacts (§4.14).
 */
@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SUPPORT_POLICY) private readonly policy: SupportPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly people: PeopleService,
    private readonly relationships: RelationshipAuthority,
    private readonly authorization: AuthorizationService,
    private readonly applications: ApplicationsService,
    private readonly enrollments: EnrollmentsService,
    private readonly bookings: SessionBookingsService,
    private readonly obligations: ObligationsService,
    private readonly credits: CreditsService,
    private readonly checkouts: CheckoutService,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsService,
    private readonly cases: CasesService,
  ) {}

  async timeline(
    principal: Principal,
    personId: string,
    query: TimelineQuery,
  ): Promise<CustomerTimeline> {
    const organizationId = organizationOf(principal);
    // Staff-only and protected: a customer of any household, or staff without the role, learns
    // nothing about the person (NOT_FOUND, §4.10).
    await this.authorization.require(principal, SupportActions.readTimeline, {
      type: 'customer_timeline',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    const found = await this.persons.findPerson(organizationId, personId);
    if (!found) throw errors.protectedNotFound('person');
    const subjectId = found.canonicalPersonId;
    const person = await this.describe(principal, subjectId);

    const dependents: TimelinePerson[] = [];
    const authorities = await this.relationships.authoritiesOf(organizationId, subjectId);
    for (const a of authorities) {
      if (a.subjectPersonId === subjectId || !a.permissions.includes('view')) continue;
      try {
        const dependent = await this.describe(principal, a.subjectPersonId);
        if (dependent.status === 'active') dependents.push(dependent);
      } catch (error) {
        if (!isPermissionError(error)) throw error;
      }
    }
    const scope = [subjectId, ...dependents.map((d) => d.id)];
    const c = new Collector(new Set(scope));
    const limit = this.policy.timelineSourceLimit;
    const orderIds = new Set<string>();

    await this.source(c, 'enrollment.applications', async () => {
      for (const p of scope) {
        const page = await this.applications.list(principal, { participantPersonId: p, limit });
        for (const a of page.items) {
          const base = {
            category: 'registration' as const,
            personId: c.inScope(a.participantPersonId),
            record: { type: 'application', id: a.id },
            details: {
              offeringId: a.offeringId,
              intent: a.intent,
              requiresApproval: a.requiresApproval,
            },
          };
          c.add({
            ...base,
            id: `application:${a.id}:submitted`,
            occurredAt: a.submittedAt ?? a.createdAt,
            kind: 'application.submitted',
            title: 'Registration application submitted',
            status: a.status,
          });
          if (a.decidedAt) {
            c.add({
              ...base,
              id: `application:${a.id}:decided`,
              occurredAt: a.decidedAt,
              kind: `application.${a.status}`,
              title: `Registration application ${a.status.replaceAll('_', ' ')}`,
              status: a.status,
            });
          }
          if (a.withdrawnAt) {
            c.add({
              ...base,
              id: `application:${a.id}:withdrawn`,
              occurredAt: a.withdrawnAt,
              kind: 'application.withdrawn',
              title: 'Registration application withdrawn',
              status: a.status,
            });
          }
        }
      }
    });

    await this.source(c, 'enrollment.enrollments', async () => {
      for (const p of scope) {
        const page = await this.enrollments.list(principal, { participantPersonId: p, limit });
        for (const e of page.items) {
          if (e.orderRef) orderIds.add(e.orderRef);
          const base = {
            personId: c.inScope(e.participantPersonId),
            record: { type: 'enrollment', id: e.id },
            details: { offeringId: e.offeringId, intent: e.intent },
          };
          c.add({
            ...base,
            id: `enrollment:${e.id}:created`,
            category: 'registration',
            occurredAt: e.createdAt,
            kind: 'enrollment.created',
            title: 'Registration recorded',
            status: e.status,
            amount: e.price
              ? { amountMinor: e.price.basePriceMinor, currency: e.price.currency }
              : null,
          });
          const milestones: Array<[string | null, string, string]> = [
            [e.confirmedAt, 'enrollment.confirmed', 'Participation confirmed'],
            [e.canceledAt, 'enrollment.canceled', 'Participation canceled'],
            [e.transferredAt, 'enrollment.transferred', 'Participation transferred'],
            [e.completedAt, 'enrollment.completed', 'Participation completed'],
          ];
          for (const [at, kind, title] of milestones) {
            if (!at) continue;
            c.add({
              ...base,
              id: `enrollment:${e.id}:${kind}`,
              category: 'participation',
              occurredAt: at,
              kind,
              title,
              status: e.status,
            });
          }
        }
      }
    });

    await this.source(c, 'enrollment.session_bookings', async () => {
      for (const p of scope) {
        const bookings = await this.bookings.list(principal, { participantPersonId: p });
        for (const b of bookings.slice(-limit)) {
          const base = {
            category: 'participation' as const,
            personId: c.inScope(b.participantPersonId),
            record: { type: 'session_booking', id: b.id },
            details: {
              offeringId: b.offeringId,
              sessionId: b.sessionId,
              kind: b.kind,
              scheduledStart: b.scheduledStart,
              scheduledEnd: b.scheduledEnd,
            },
          };
          c.add({
            ...base,
            id: `session_booking:${b.id}:created`,
            occurredAt: b.createdAt,
            kind: 'session_booking.created',
            title: 'Session booked',
            status: b.status,
          });
          if (b.canceledAt) {
            c.add({
              ...base,
              id: `session_booking:${b.id}:canceled`,
              occurredAt: b.canceledAt,
              kind: 'session_booking.canceled',
              title: 'Session booking canceled',
              status: b.status,
            });
          }
        }
      }
    });

    await this.source(c, 'finance.obligations', async () => {
      for (const p of scope) {
        const page = await this.obligations.list(principal, { debtorPersonId: p, limit });
        for (const o of page.items) {
          c.add({
            id: `obligation:${o.id}:created`,
            category: 'obligation',
            occurredAt: o.createdAt,
            kind: 'obligation.created',
            title: o.description,
            personId: c.inScope(o.debtor.personId),
            record: { type: 'obligation', id: o.id },
            status: o.status,
            amount: { amountMinor: o.totals.amountMinor, currency: o.totals.currency },
            details: {
              dueAt: o.dueAt,
              remainingMinor: o.totals.remainingMinor,
              allocatedMinor: o.totals.allocatedMinor,
              mode: o.mode,
            },
          });
        }
      }
    });

    await this.source(c, 'finance.credits', async () => {
      for (const p of scope) {
        const page = await this.credits.list(principal, { ownerPersonId: p, limit });
        for (const credit of page.items) {
          c.add({
            id: `credit:${credit.id}:issued`,
            category: 'credit',
            occurredAt: credit.createdAt,
            kind: 'credit.issued',
            title: `Credit issued (${credit.sourceKind})`,
            personId: c.inScope(credit.ownerPersonId),
            record: { type: 'credit', id: credit.id },
            status: credit.status,
            amount: { amountMinor: credit.originalMinor, currency: credit.currency },
            details: { remainingMinor: credit.remainingMinor, expiresAt: credit.expiresAt },
          });
          for (const r of credit.redemptions) {
            c.add({
              id: `credit:${credit.id}:${r.id}`,
              category: 'credit',
              occurredAt: r.redeemedAt,
              kind: r.kind === 'redeem' ? 'credit.redeemed' : 'credit.redemption_reversed',
              title: r.kind === 'redeem' ? 'Credit redeemed' : 'Credit redemption reversed',
              personId: c.inScope(credit.ownerPersonId),
              record: { type: 'credit', id: credit.id },
              status: credit.status,
              amount: { amountMinor: r.amountMinor, currency: credit.currency },
              details: { referenceType: r.referenceType },
            });
          }
        }
      }
    });

    const references = await this.db
      .selectFrom('timeline_references')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', 'in', scope)
      .orderBy('occurred_at', 'desc')
      .limit(limit * 5)
      .execute();
    for (const r of references) {
      const merged = (r.summary as { mergedPersonId?: unknown } | null)?.mergedPersonId;
      if (typeof merged === 'string' && c.scope.has(r.person_id))
        c.aliases.set(merged, r.person_id);
    }
    const referenced = (type: string) => [
      ...new Set(references.filter((r) => r.record_type === type).map((r) => r.record_id)),
    ];
    for (const id of referenced('order')) orderIds.add(id);

    await this.source(c, 'finance.orders', async () => {
      for (const id of orderIds) {
        const order = await this.checkouts.getOrder(principal, id);
        const payer = c.inScope(order.payerPersonId);
        const lines = order.lines.filter((l) => c.inScope(l.participantPersonId));
        if (!payer && lines.length === 0) continue;
        // Another household's lines are counted, never described (§4.7 invariant 1).
        const amountMinor = payer ? order.totalMinor : lines.reduce((s, l) => s + l.totalMinor, 0);
        const base = {
          category: 'order' as const,
          personId: payer ?? c.inScope(lines[0]?.participantPersonId),
          record: { type: 'order', id: order.id },
          status: order.paymentStatus,
          amount: { amountMinor, currency: order.currency },
          details: {
            paymentStatus: order.paymentStatus,
            fulfillmentStatus: order.fulfillmentStatus,
            lines: lines.map((l) => ({
              participantPersonId: l.participantPersonId,
              offeringId: l.offeringId,
              description: l.description,
              totalMinor: l.totalMinor,
            })),
            otherLines: order.lines.length - lines.length,
            payerInScope: payer !== null,
          },
        };
        const milestones: Array<[string | null, string, string]> = [
          [order.createdAt, 'order.created', 'Order placed'],
          [order.paidAt, 'order.paid', 'Order paid'],
          [order.fulfilledAt, 'order.fulfilled', 'Order fulfilled'],
          [order.canceledAt, 'order.canceled', 'Order canceled'],
        ];
        for (const [at, kind, title] of milestones) {
          if (!at) continue;
          c.add({ ...base, id: `order:${order.id}:${kind}`, occurredAt: at, kind, title });
        }
      }
    });

    await this.source(c, 'finance.payments', async () => {
      for (const id of referenced('payment_attempt')) {
        const p = await this.payments.get(principal, id);
        // Never the payment method, provider reference or provider action payload (§4.14).
        c.add({
          id: `payment_attempt:${p.id}`,
          category: 'payment',
          occurredAt: p.resolvedAt ?? p.createdAt,
          kind: `payment.${p.status}`,
          title: `Payment ${p.status.replaceAll('_', ' ')}`,
          personId: c.inScope(p.payerPersonId),
          record: { type: 'payment_attempt', id: p.id },
          status: p.status,
          amount: { amountMinor: p.amountMinor, currency: p.currency },
          details: {
            purpose: p.purpose,
            orderId: p.orderId,
            obligationId: p.obligationId,
            failureReason: p.failureReason,
            unknownSince: p.unknownSince,
          },
        });
      }
    });

    await this.source(c, 'finance.refunds', async () => {
      for (const id of referenced('refund_attempt')) {
        const r = await this.refunds.get(principal, id);
        const reference = references.find(
          (x) => x.record_type === 'refund_attempt' && x.record_id === id,
        );
        c.add({
          id: `refund_attempt:${r.id}`,
          category: 'refund',
          occurredAt: r.resolvedAt ?? r.createdAt,
          kind: `refund.${r.status}`,
          title: `Refund ${r.status.replaceAll('_', ' ')}`,
          personId: c.inScope(reference?.person_id),
          record: { type: 'refund_attempt', id: r.id },
          status: r.status,
          amount: { amountMinor: r.amountMinor, currency: r.currency },
          details: {
            purpose: r.purpose,
            paymentAttemptId: r.paymentAttemptId,
            reservationStatus: r.reservationStatus,
            operationId: r.operationId,
          },
        });
      }
    });

    await this.source(c, 'communications.messages', async () => {
      for (const id of referenced('notification')) {
        const d = await this.notifications.deliveries(principal, id);
        const n = d.notification;
        const at = n.dispatchedAt ?? n.queuedAt ?? n.createdAt;
        for (const p of scope) {
          const ids = c.idsOf(p);
          const mine = d.recipients.filter((r) => ids.has(r.personId));
          if (mine.length > 0) {
            const attempts = d.attempts.filter((a) => mine.some((r) => r.id === a.recipientId));
            c.add({
              id: `notification:${n.id}:${p}`,
              category: 'message',
              occurredAt: at,
              kind: `message.${n.kind}`,
              title: n.title,
              personId: p,
              record: { type: 'notification', id: n.id },
              status: mine[0]?.status ?? null,
              facilityId: n.facilityId,
              // Actual delivery states per channel (SPK-COMMS-004); never the message body.
              details: {
                category: n.category,
                protected: n.protected,
                channels: attempts.map((a) => ({
                  channel: a.channel,
                  status: a.status,
                  failureCode: a.failureCode,
                  deliveredAt: a.deliveredAt,
                  readAt: a.readAt,
                })),
              },
            });
            continue;
          }
          const about = d.recipients.filter((r) => r.subjectPersonIds.some((x) => ids.has(x)));
          if (about.length > 0) {
            c.add({
              id: `notification:${n.id}:${p}`,
              category: 'message',
              occurredAt: at,
              kind: `message.${n.kind}`,
              title: n.title,
              personId: p,
              record: { type: 'notification', id: n.id },
              status: n.status,
              facilityId: n.facilityId,
              details: { category: n.category, sentAbout: true, recipientCount: about.length },
            });
          }
        }
      }
    });

    await this.source(c, 'scheduling.changes', async () => {
      const rows = references.filter((r) => r.record_type === 'scheduling_event');
      const visible = new Map<string, { status: string; facilityId: string } | null>();
      for (const row of rows) {
        if (!visible.has(row.record_id)) {
          try {
            const event = await this.events.getEvent(principal, row.record_id);
            visible.set(row.record_id, { status: event.status, facilityId: event.facilityId });
          } catch (error) {
            if (!isPermissionError(error)) throw error;
            visible.set(row.record_id, null);
          }
        }
        const event = visible.get(row.record_id);
        if (!event) continue;
        const summary = (row.summary ?? {}) as {
          change?: string;
          title?: string | null;
          before?: unknown;
          after?: unknown;
        };
        c.add({
          id: `scheduling_event:${row.record_id}:${row.source_event_id}:${row.person_id}`,
          category: 'schedule',
          occurredAt: iso(row.occurred_at),
          kind: `schedule.${summary.change ?? 'changed'}`,
          title: summary.title ?? 'Schedule change',
          personId: c.inScope(row.person_id),
          record: { type: 'scheduling_event', id: row.record_id },
          status: event.status,
          facilityId: event.facilityId,
          details: {
            relation: row.relation,
            before: summary.before ?? null,
            after: summary.after ?? null,
          },
        });
      }
    });

    await this.source(c, 'support.cases', async () => {
      const own = await this.cases.casesAbout(organizationId, scope, limit);
      const merged = await this.cases.casesByIds(
        organizationId,
        referenced('support_case').filter((id) => !own.some((r) => r.id === id)),
      );
      for (const row of [...own, ...merged]) {
        try {
          await this.cases.requireOn(principal, SupportActions.readCase, row);
        } catch (error) {
          if (isPermissionError(error)) continue;
          throw error;
        }
        this.addCase(c, row, references);
      }
    });

    // Facility-scoped staff see their facilities' records and organization-wide ones (§4.3).
    let entries = c.entries;
    if (principal.kind === 'staff' && principal.facilityIds.length > 0) {
      const allowed = new Set(principal.facilityIds);
      entries = entries.filter((e) => e.facilityId === null || allowed.has(e.facilityId));
    }
    entries.sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? b.id.localeCompare(a.id)
        : new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
    const cursor = decodeCursor(query.cursor, Cursor);
    if (cursor) {
      const at = new Date(cursor.at).getTime();
      entries = entries.filter((e) => {
        const t = new Date(e.occurredAt).getTime();
        return t < at || (t === at && e.id.localeCompare(cursor.id) < 0);
      });
    }
    const page = entries.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      person,
      scope: { personIds: scope, dependents },
      entries: page,
      sources: c.sources,
      generatedAt: this.clock.now().toISOString(),
      nextCursor:
        entries.length > query.limit && last
          ? encodeCursor({ at: last.occurredAt, id: last.id })
          : null,
    };
  }

  private addCase(
    c: Collector,
    row: CaseRow,
    references: ReadonlyArray<{ record_type: string; record_id: string; person_id: string }>,
  ): void {
    const personId =
      c.inScope(row.subject_person_id) ??
      c.inScope(
        references.find((r) => r.record_type === 'support_case' && r.record_id === row.id)
          ?.person_id,
      );
    const base = {
      category: 'support' as const,
      personId,
      record: { type: 'support_case', id: row.id },
      status: row.status,
      facilityId: row.facility_id,
      details: { category: row.category, priority: row.priority },
    };
    c.add({
      ...base,
      id: `support_case:${row.id}:opened`,
      occurredAt: iso(row.created_at),
      kind: 'case.opened',
      title: row.title,
    });
    if (row.resolved_at) {
      c.add({
        ...base,
        id: `support_case:${row.id}:resolved`,
        occurredAt: iso(row.resolved_at),
        kind: 'case.resolved',
        title: row.title,
        details: { ...base.details, resolutionKind: row.resolution_kind },
      });
    }
    if (row.closed_at) {
      c.add({
        ...base,
        id: `support_case:${row.id}:closed`,
        occurredAt: iso(row.closed_at),
        kind: 'case.closed',
        title: row.title,
      });
    }
  }

  /** A person as the timeline shows them: a child by given name only (§4.14 minimization). */
  private async describe(principal: Principal, personId: string): Promise<TimelinePerson> {
    const p = await this.people.getPerson(principal, personId);
    const child = p.kind === 'child';
    return {
      id: p.id,
      kind: p.kind,
      displayName: child ? p.givenName : `${p.givenName} ${p.familyName}`,
      status: p.status,
      minimized: child,
    };
  }

  /** Runs one source; a source the operator may not read contributes nothing (§4.10). */
  private async source(c: Collector, name: string, fn: () => Promise<void>): Promise<void> {
    const before = c.entries.length;
    try {
      await fn();
      c.sources.push({ source: name, status: 'ok', count: c.entries.length - before });
    } catch (error) {
      c.entries.splice(before);
      if (isPermissionError(error)) {
        c.sources.push({ source: name, status: 'not_permitted', count: 0 });
        return;
      }
      this.logger.warn(`timeline source ${name} unavailable: ${String(error)}`);
      c.sources.push({ source: name, status: 'unavailable', count: 0 });
    }
  }
}

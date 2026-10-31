import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  decodeCursor,
  errors,
  type CustomerTimeline,
  type NotificationDeliveries,
  type Principal,
  type TimelineEntry,
  type TimelinePerson,
  type TimelineQuery,
} from '@sportspark/contracts';
import type { Db, TimelineRecordType } from '@sportspark/db';
import { sql, type SqlBool } from 'kysely';
import {
  AuthorizationService,
  CLOCK,
  DATABASE,
  type Clock,
  listFacilityScope,
} from '../../../kernel';
import { NotificationsService } from '../../communications';
import { ApplicationsService, EnrollmentsService, SessionBookingsService } from '../../enrollment';
import {
  CashTendersService,
  CheckoutService,
  CreditsService,
  FinanceActions,
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
import {
  TimelineCursorSchema,
  TimelineSource,
  atPosition,
  mergeSources,
  oneShot,
  type SourceBatch,
  type SourceFetch,
  type SourceItem,
  type SourcePosition,
} from './timeline-sources';

type EntryInput = Omit<TimelineEntry, 'details' | 'amount' | 'facilityId' | 'status'> & {
  details?: Record<string, unknown>;
  amount?: { amountMinor: number; currency: string } | null;
  facilityId?: string | null;
  status?: string | null;
};

/**
 * FIN-02 (finance stage 3): `CashTendersService.listForPersons`, finance's in-process read of the
 * tenders people paid, newest first with a keyset cursor. Declared by finance's work item; until
 * it is present the cash-tender source reports `unavailable`.
 */
interface CashTenderItem {
  id: string;
  facilityId: string;
  tenderKind: string;
  payerPersonId: string;
  amountMinor: number;
  currency: string;
  obligationId: string | null;
  recordedAt: string;
  status: string;
}
interface CashTenderReader {
  listForPersons(
    organizationId: string,
    personIds: readonly string[],
    page: { cursor?: string; limit: number },
  ): Promise<{ items: CashTenderItem[]; nextCursor: string | null }>;
}

/** Legacy copies a person merge used to append (before SUP-05); the expansion replaces them. */
const MERGE_COPY_EVENT = 'identity.persons_merged';

/** The people in scope and every record id that now stands for each of them (SPK-IAM-007). */
class Scope {
  /** Any id (canonical or merged into it) → the person in scope it stands for. */
  private readonly canonical = new Map<string, string>();
  readonly expanded: string[] = [];

  constructor(
    readonly persons: readonly string[],
    resolving: ReadonlyMap<string, readonly string[]>,
  ) {
    for (const person of persons) {
      for (const id of resolving.get(person) ?? [person]) {
        if (this.canonical.has(id)) continue;
        this.canonical.set(id, person);
        this.expanded.push(id);
      }
    }
  }

  /** The person in scope `personId` stands for, or null: anyone else is never named. */
  of(personId: string | null | undefined): string | null {
    return personId ? (this.canonical.get(personId) ?? null) : null;
  }

  /** Every id that stands for the person in scope. */
  idsOf(person: string): Set<string> {
    const ids = new Set<string>();
    for (const [id, canonical] of this.canonical) if (canonical === person) ids.add(id);
    return ids;
  }
}

function entry(input: EntryInput): TimelineEntry {
  return {
    ...input,
    status: input.status ?? null,
    amount: input.amount ?? null,
    facilityId: input.facilityId ?? null,
    details: input.details ?? {},
  };
}

/**
 * Scoped customer timeline (SPK-SUPPORT-001): registration, participation, orders, payments,
 * cash tenders, refunds, credits, obligations, schedule changes, messages and support cases of
 * one person and the people they currently hold `view` over (their dependents). Every record is
 * read through the owning module's exported service WITH THE OPERATOR'S PRINCIPAL, so that
 * module's authorization decides what the operator sees: a source the operator may not read
 * contributes nothing and is reported as `not_permitted`. Staff never use the customer's
 * credentials (SPK-SUPPORT-002, SPK-AT-026). The timeline never carries card data or provider
 * references; other people appear only as counts; children appear by given name only, without
 * date of birth or contacts (§4.14).
 *
 * Paging (SUP-03): payments, refunds, cash tenders, messages, schedule changes and cases each page
 * with their own keyset (the timeline index, finance's tender cursor, the case history); the
 * registration, participation, order, obligation and credit sources read their owning module's
 * most recent `timelineSourceLimit` records per person and page in memory. The sources are merged
 * newest first and their positions travel in one cursor.
 *
 * Merges (SUP-05, SPK-IAM-007): each person in scope is expanded with identity's
 * `personIdsResolvingTo`, so a survivor's timeline includes the records still naming the people
 * merged into it; no record is rewritten.
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
    private readonly cashTenders: CashTendersService,
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
    const personIds = [subjectId, ...dependents.map((d) => d.id)];
    const resolving = new Map<string, string[]>();
    for (const p of personIds) {
      resolving.set(p, await this.cases.resolvingIds(organizationId, p));
    }
    const scope = new Scope(personIds, resolving);

    // Facility-scoped staff see their facilities' records and organization-wide ones (§4.3).
    const facilityScope = listFacilityScope(principal, SupportActions.readTimeline);
    const allowedFacilities = facilityScope ? new Set(facilityScope) : null;
    const visible = (e: TimelineEntry): TimelineEntry | null =>
      e.facilityId === null || !allowedFacilities || allowedFacilities.has(e.facilityId) ? e : null;

    const cursor = decodeCursor(query.cursor, TimelineCursorSchema);
    const batch = Math.min(query.limit + 1, 200);
    const ctx: SourceContext = { principal, organizationId, scope, visible, batch };
    const definitions: Array<[string, SourceFetch]> = [
      ['enrollment.applications', this.applicationsSource(ctx)],
      ['enrollment.enrollments', this.enrollmentsSource(ctx)],
      ['enrollment.session_bookings', this.bookingsSource(ctx)],
      ['finance.obligations', this.obligationsSource(ctx)],
      ['finance.credits', this.creditsSource(ctx)],
      ['finance.orders', this.ordersSource(ctx)],
      ['finance.payments', this.paymentsSource(ctx)],
      ['finance.cash_tenders', this.cashTendersSource(ctx)],
      ['finance.refunds', this.refundsSource(ctx)],
      ['communications.messages', this.messagesSource(ctx)],
      ['scheduling.changes', this.scheduleSource(ctx)],
      ['support.cases', this.casesSource(ctx)],
    ];
    const sources = definitions.map(
      ([name, fetch]) =>
        new TimelineSource(name, cursor?.s[name], fetch, batch, (source, error) =>
          this.logger.warn(`timeline source ${source} unavailable: ${String(error)}`),
        ),
    );
    const page = await mergeSources(sources, query.limit);
    return {
      person,
      scope: { personIds, dependents },
      entries: page.entries,
      sources: sources.map((s) => s.report()),
      generatedAt: this.clock.now().toISOString(),
      nextCursor: page.nextCursor,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Sources read in one call per person (bounded by timelineSourceLimit), paged in memory
  // -------------------------------------------------------------------------------------------

  /** The enrollments of everyone in scope, read once per page for two sources. */
  private enrollmentsOf = new WeakMap<SourceContext, Promise<EnrollmentLike[]>>();

  private loadEnrollments(ctx: SourceContext): Promise<EnrollmentLike[]> {
    let loaded = this.enrollmentsOf.get(ctx);
    if (!loaded) {
      loaded = (async () => {
        const out: EnrollmentLike[] = [];
        for (const id of ctx.scope.expanded) {
          const page = await this.enrollments.list(ctx.principal, {
            participantPersonId: id,
            limit: this.policy.timelineSourceLimit,
          });
          out.push(...page.items);
        }
        return out;
      })();
      this.enrollmentsOf.set(ctx, loaded);
    }
    return loaded;
  }

  private applicationsSource(ctx: SourceContext): SourceFetch {
    return oneShot(async () => {
      const items: SourceItem[] = [];
      for (const id of ctx.scope.expanded) {
        const page = await this.applications.list(ctx.principal, {
          participantPersonId: id,
          limit: this.policy.timelineSourceLimit,
        });
        for (const a of page.items) {
          const base = {
            category: 'registration' as const,
            personId: ctx.scope.of(a.participantPersonId),
            record: { type: 'application', id: a.id },
            details: {
              offeringId: a.offeringId,
              intent: a.intent,
              requiresApproval: a.requiresApproval,
            },
          };
          items.push(
            item(ctx, {
              ...base,
              id: `application:${a.id}:submitted`,
              occurredAt: a.submittedAt ?? a.createdAt,
              kind: 'application.submitted',
              title: 'Registration application submitted',
              status: a.status,
            }),
          );
          if (a.decidedAt) {
            items.push(
              item(ctx, {
                ...base,
                id: `application:${a.id}:decided`,
                occurredAt: a.decidedAt,
                kind: `application.${a.status}`,
                title: `Registration application ${a.status.replaceAll('_', ' ')}`,
                status: a.status,
              }),
            );
          }
          if (a.withdrawnAt) {
            items.push(
              item(ctx, {
                ...base,
                id: `application:${a.id}:withdrawn`,
                occurredAt: a.withdrawnAt,
                kind: 'application.withdrawn',
                title: 'Registration application withdrawn',
                status: a.status,
              }),
            );
          }
        }
      }
      return items;
    });
  }

  private enrollmentsSource(ctx: SourceContext): SourceFetch {
    return oneShot(async () => {
      const items: SourceItem[] = [];
      for (const e of await this.loadEnrollments(ctx)) {
        const base = {
          personId: ctx.scope.of(e.participantPersonId),
          record: { type: 'enrollment', id: e.id },
          details: { offeringId: e.offeringId, intent: e.intent },
        };
        items.push(
          item(ctx, {
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
          }),
        );
        const milestones: Array<[string | null, string, string]> = [
          [e.confirmedAt, 'enrollment.confirmed', 'Participation confirmed'],
          [e.canceledAt, 'enrollment.canceled', 'Participation canceled'],
          [e.transferredAt, 'enrollment.transferred', 'Participation transferred'],
          [e.completedAt, 'enrollment.completed', 'Participation completed'],
        ];
        for (const [at, kind, title] of milestones) {
          if (!at) continue;
          items.push(
            item(ctx, {
              ...base,
              id: `enrollment:${e.id}:${kind}`,
              category: 'participation',
              occurredAt: at,
              kind,
              title,
              status: e.status,
            }),
          );
        }
      }
      return items;
    });
  }

  private bookingsSource(ctx: SourceContext): SourceFetch {
    return oneShot(async () => {
      const items: SourceItem[] = [];
      for (const id of ctx.scope.expanded) {
        const bookings = await this.bookings.list(ctx.principal, { participantPersonId: id });
        for (const b of bookings.slice(-this.policy.timelineSourceLimit)) {
          const base = {
            category: 'participation' as const,
            personId: ctx.scope.of(b.participantPersonId),
            record: { type: 'session_booking', id: b.id },
            details: {
              offeringId: b.offeringId,
              sessionId: b.sessionId,
              kind: b.kind,
              scheduledStart: b.scheduledStart,
              scheduledEnd: b.scheduledEnd,
            },
          };
          items.push(
            item(ctx, {
              ...base,
              id: `session_booking:${b.id}:created`,
              occurredAt: b.createdAt,
              kind: 'session_booking.created',
              title: 'Session booked',
              status: b.status,
            }),
          );
          if (b.canceledAt) {
            items.push(
              item(ctx, {
                ...base,
                id: `session_booking:${b.id}:canceled`,
                occurredAt: b.canceledAt,
                kind: 'session_booking.canceled',
                title: 'Session booking canceled',
                status: b.status,
              }),
            );
          }
        }
      }
      return items;
    });
  }

  private obligationsSource(ctx: SourceContext): SourceFetch {
    return oneShot(async () => {
      const items: SourceItem[] = [];
      for (const id of ctx.scope.expanded) {
        const page = await this.obligations.list(ctx.principal, {
          debtorPersonId: id,
          limit: this.policy.timelineSourceLimit,
        });
        for (const o of page.items) {
          items.push(
            item(ctx, {
              id: `obligation:${o.id}:created`,
              category: 'obligation',
              occurredAt: o.createdAt,
              kind: 'obligation.created',
              title: o.description,
              personId: ctx.scope.of(o.debtor.personId),
              record: { type: 'obligation', id: o.id },
              status: o.status,
              amount: { amountMinor: o.totals.amountMinor, currency: o.totals.currency },
              details: {
                dueAt: o.dueAt,
                remainingMinor: o.totals.remainingMinor,
                allocatedMinor: o.totals.allocatedMinor,
                mode: o.mode,
              },
            }),
          );
        }
      }
      return items;
    });
  }

  private creditsSource(ctx: SourceContext): SourceFetch {
    return oneShot(async () => {
      const items: SourceItem[] = [];
      for (const id of ctx.scope.expanded) {
        const page = await this.credits.list(ctx.principal, {
          ownerPersonId: id,
          limit: this.policy.timelineSourceLimit,
        });
        for (const credit of page.items) {
          items.push(
            item(ctx, {
              id: `credit:${credit.id}:issued`,
              category: 'credit',
              occurredAt: credit.createdAt,
              kind: 'credit.issued',
              title: `Credit issued (${credit.sourceKind})`,
              personId: ctx.scope.of(credit.ownerPersonId),
              record: { type: 'credit', id: credit.id },
              status: credit.status,
              amount: { amountMinor: credit.originalMinor, currency: credit.currency },
              details: { remainingMinor: credit.remainingMinor, expiresAt: credit.expiresAt },
            }),
          );
          for (const r of credit.redemptions) {
            items.push(
              item(ctx, {
                id: `credit:${credit.id}:${r.id}`,
                category: 'credit',
                occurredAt: r.redeemedAt,
                kind: r.kind === 'redeem' ? 'credit.redeemed' : 'credit.redemption_reversed',
                title: r.kind === 'redeem' ? 'Credit redeemed' : 'Credit redemption reversed',
                personId: ctx.scope.of(credit.ownerPersonId),
                record: { type: 'credit', id: credit.id },
                status: credit.status,
                amount: { amountMinor: r.amountMinor, currency: credit.currency },
                details: { referenceType: r.referenceType },
              }),
            );
          }
        }
      }
      return items;
    });
  }

  /** Orders of the enrollments in scope and the orders the index names (payer). */
  private ordersSource(ctx: SourceContext): SourceFetch {
    return oneShot(async () => {
      const orderIds = new Set<string>();
      for (const e of await this.loadEnrollments(ctx)) if (e.orderRef) orderIds.add(e.orderRef);
      for (const group of await this.referenceGroups(
        ctx,
        'order',
        null,
        this.policy.timelineSourceLimit,
      )) {
        orderIds.add(group.record_id);
      }
      const items: SourceItem[] = [];
      for (const id of orderIds) {
        const order = await this.checkouts.getOrder(ctx.principal, id);
        const payer = ctx.scope.of(order.payerPersonId);
        const lines = order.lines.filter((l) => ctx.scope.of(l.participantPersonId));
        if (!payer && lines.length === 0) continue;
        // Another household's lines are counted, never described (§4.7 invariant 1).
        const amountMinor = payer ? order.totalMinor : lines.reduce((s, l) => s + l.totalMinor, 0);
        const base = {
          category: 'order' as const,
          personId: payer ?? ctx.scope.of(lines[0]?.participantPersonId),
          record: { type: 'order', id: order.id },
          status: order.paymentStatus,
          amount: { amountMinor, currency: order.currency },
          details: {
            paymentStatus: order.paymentStatus,
            fulfillmentStatus: order.fulfillmentStatus,
            lines: lines.map((l) => ({
              participantPersonId: ctx.scope.of(l.participantPersonId),
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
          items.push(
            item(ctx, { ...base, id: `order:${order.id}:${kind}`, occurredAt: at, kind, title }),
          );
        }
      }
      return items;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Sources with their own keyset (SUP-03)
  // -------------------------------------------------------------------------------------------

  /**
   * The timeline index grouped by record and person, newest reference first:
   * keyset (latest occurred_at, record id, person id). Legacy merge copies are skipped (SUP-05).
   */
  private async referenceGroups(
    ctx: SourceContext,
    recordType: TimelineRecordType,
    from: SourcePosition | null,
    limit: number,
  ): Promise<Array<{ record_id: string; person_id: string; at: Date }>> {
    if (ctx.scope.expanded.length === 0) return [];
    let q = this.db
      .selectFrom('timeline_references')
      .select(['record_id', 'person_id'])
      .select((eb) => eb.fn.max('occurred_at').as('at'))
      .where('organization_id', '=', ctx.organizationId)
      .where('record_type', '=', recordType)
      .where('person_id', 'in', ctx.scope.expanded)
      .where('source_event_type', '<>', MERGE_COPY_EVENT)
      .groupBy(['record_id', 'person_id'])
      .orderBy('at', 'desc')
      .orderBy('record_id', 'desc')
      .orderBy('person_id', 'desc')
      .limit(limit);
    if (from && 'a' in from) {
      const [recordId, personId] = from.i.split('|');
      q = q.having(
        sql<SqlBool>`(max(occurred_at), record_id, person_id) < (${new Date(from.a)}::timestamptz, ${recordId}::uuid, ${personId}::uuid)`,
      );
    }
    const rows = await q.execute();
    return rows.map((r) => ({
      record_id: r.record_id,
      person_id: r.person_id,
      at: new Date(r.at as unknown as string | Date),
    }));
  }

  /** A keyset source over reference groups; `toItem` reads the record through its module. */
  private groupedSource(
    ctx: SourceContext,
    recordType: TimelineRecordType,
    toItem: (
      group: { record_id: string; person_id: string; at: string },
      position: SourcePosition,
    ) => Promise<SourceItem>,
  ): SourceFetch {
    return async (from, limit): Promise<SourceBatch> => {
      const groups = await this.referenceGroups(ctx, recordType, from, limit);
      const items: SourceItem[] = [];
      for (const g of groups) {
        const at = g.at.toISOString();
        items.push(
          await toItem(
            { record_id: g.record_id, person_id: g.person_id, at },
            atPosition(at, `${g.record_id}|${g.person_id}`),
          ),
        );
      }
      const last = items[items.length - 1];
      return groups.length < limit || !last
        ? { items, next: null, exhausted: true }
        : { items, next: last.position, exhausted: false };
    };
  }

  private paymentsSource(ctx: SourceContext): SourceFetch {
    return this.groupedSource(ctx, 'payment_attempt', async (g, position) => {
      const id = `payment_attempt:${g.record_id}`;
      try {
        const p = await this.payments.get(ctx.principal, g.record_id);
        // Never the payment method, provider reference or provider action payload (§4.14).
        return {
          at: g.at,
          id,
          position,
          entry: ctx.visible(
            entry({
              id,
              category: 'payment',
              occurredAt: g.at,
              kind: `payment.${p.status}`,
              title: `Payment ${p.status.replaceAll('_', ' ')}`,
              personId: ctx.scope.of(p.payerPersonId),
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
            }),
          ),
        };
      } catch (error) {
        return refusedItem(error, g.at, id, position);
      }
    });
  }

  private refundsSource(ctx: SourceContext): SourceFetch {
    return this.groupedSource(ctx, 'refund_attempt', async (g, position) => {
      const id = `refund_attempt:${g.record_id}`;
      try {
        const r = await this.refunds.get(ctx.principal, g.record_id);
        return {
          at: g.at,
          id,
          position,
          entry: ctx.visible(
            entry({
              id,
              category: 'refund',
              occurredAt: g.at,
              kind: `refund.${r.status}`,
              title: `Refund ${r.status.replaceAll('_', ' ')}`,
              personId: ctx.scope.of(g.person_id),
              record: { type: 'refund_attempt', id: r.id },
              status: r.status,
              amount: { amountMinor: r.amountMinor, currency: r.currency },
              details: {
                purpose: r.purpose,
                paymentAttemptId: r.paymentAttemptId,
                reservationStatus: r.reservationStatus,
                operationId: r.operationId,
              },
            }),
          ),
        };
      } catch (error) {
        return refusedItem(error, g.at, id, position);
      }
    });
  }

  /** Messages each person in scope received or that were about them, with delivery states. */
  private messagesSource(ctx: SourceContext): SourceFetch {
    const deliveries = new Map<string, Promise<NotificationDeliveries>>();
    const read = (id: string) => {
      let d = deliveries.get(id);
      if (!d) {
        d = this.notifications.deliveries(ctx.principal, id);
        deliveries.set(id, d);
      }
      return d;
    };
    return this.groupedSource(ctx, 'notification', async (g, position) => {
      const id = `notification:${g.record_id}:${g.person_id}`;
      const p = ctx.scope.of(g.person_id);
      let d: NotificationDeliveries;
      try {
        d = await read(g.record_id);
      } catch (error) {
        return refusedItem(error, g.at, id, position);
      }
      const n = d.notification;
      if (!p) return { at: g.at, id, position, entry: null };
      const ids = ctx.scope.idsOf(p);
      const mine = d.recipients.filter((r) => ids.has(r.personId));
      if (mine.length > 0) {
        const attempts = d.attempts.filter((a) => mine.some((r) => r.id === a.recipientId));
        return {
          at: g.at,
          id,
          position,
          entry: ctx.visible(
            entry({
              id,
              category: 'message',
              occurredAt: g.at,
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
            }),
          ),
        };
      }
      const about = d.recipients.filter((r) => r.subjectPersonIds.some((x) => ids.has(x)));
      if (about.length === 0) return { at: g.at, id, position, entry: null };
      return {
        at: g.at,
        id,
        position,
        entry: ctx.visible(
          entry({
            id,
            category: 'message',
            occurredAt: g.at,
            kind: `message.${n.kind}`,
            title: n.title,
            personId: p,
            record: { type: 'notification', id: n.id },
            status: n.status,
            facilityId: n.facilityId,
            details: { category: n.category, sentAbout: true, recipientCount: about.length },
          }),
        ),
      };
    });
  }

  /** Every change of a published event a person in scope was committed to (one per reference). */
  private scheduleSource(ctx: SourceContext): SourceFetch {
    const eventsRead = new Map<string, Promise<{ status: string; facilityId: string } | null>>();
    const read = (id: string) => {
      let e = eventsRead.get(id);
      if (!e) {
        e = this.events.getEvent(ctx.principal, id).then(
          (event) => ({ status: event.status, facilityId: event.facilityId }),
          (error: unknown) => {
            if (isPermissionError(error)) return null;
            throw error;
          },
        );
        eventsRead.set(id, e);
      }
      return e;
    };
    return async (from, limit): Promise<SourceBatch> => {
      if (ctx.scope.expanded.length === 0) return { items: [], next: null, exhausted: true };
      let q = this.db
        .selectFrom('timeline_references')
        .selectAll()
        .where('organization_id', '=', ctx.organizationId)
        .where('record_type', '=', 'scheduling_event')
        .where('person_id', 'in', ctx.scope.expanded)
        .where('source_event_type', '<>', MERGE_COPY_EVENT)
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit);
      if (from && 'a' in from) {
        q = q.where(
          sql<SqlBool>`(occurred_at, id) < (${new Date(from.a)}::timestamptz, ${from.i}::uuid)`,
        );
      }
      const rows = await q.execute();
      const items: SourceItem[] = [];
      for (const row of rows) {
        const at = iso(row.occurred_at);
        const id = `scheduling_event:${row.record_id}:${row.source_event_id}:${row.person_id}`;
        const position = atPosition(at, row.id);
        const event = await read(row.record_id);
        if (!event) {
          items.push({ at, id, position, entry: null, refused: true });
          continue;
        }
        const summary = (row.summary ?? {}) as {
          change?: string;
          title?: string | null;
          before?: unknown;
          after?: unknown;
        };
        items.push({
          at,
          id,
          position,
          entry: ctx.visible(
            entry({
              id,
              category: 'schedule',
              occurredAt: at,
              kind: `schedule.${summary.change ?? 'changed'}`,
              title: summary.title ?? 'Schedule change',
              personId: ctx.scope.of(row.person_id),
              record: { type: 'scheduling_event', id: row.record_id },
              status: event.status,
              facilityId: event.facilityId,
              details: {
                relation: row.relation,
                before: summary.before ?? null,
                after: summary.after ?? null,
              },
            }),
          ),
        });
      }
      const last = items[items.length - 1];
      return rows.length < limit || !last
        ? { items, next: null, exhausted: true }
        : { items, next: last.position, exhausted: false };
    };
  }

  /**
   * Cash and externally recorded tenders the people in scope paid (FIN-02 listForPersons, keyset
   * recorded_at desc), each authorized like a payment read (`finance.read_checkout` over the payer,
   * in the tender's facility). Never the evidence or who recorded it.
   */
  private cashTendersSource(ctx: SourceContext): SourceFetch {
    const reader = this.cashTenders as unknown as Partial<CashTenderReader>;
    return async (from, limit): Promise<SourceBatch> => {
      if (typeof reader.listForPersons !== 'function') {
        throw new Error('CashTendersService.listForPersons is not available yet (FIN-02)');
      }
      const start = from && 'c' in from ? from : { c: null, k: 0 };
      const page = await reader.listForPersons(ctx.organizationId, ctx.scope.expanded, {
        cursor: start.c ?? undefined,
        limit: start.k + limit,
      });
      const items: SourceItem[] = [];
      const fresh = page.items.slice(start.k);
      for (const [offset, tender] of fresh.entries()) {
        const id = `cash_tender:${tender.id}`;
        const position: SourcePosition = { c: start.c, k: start.k + offset + 1 };
        const decision = await this.authorization.decide(
          ctx.principal,
          FinanceActions.readCheckout,
          {
            type: 'cash_tender',
            id: tender.id,
            organizationId: ctx.organizationId,
            facilityId: tender.facilityId,
            subjectPersonIds: [tender.payerPersonId],
            protected: true,
          },
        );
        if (!decision.allowed) {
          items.push({ at: tender.recordedAt, id, position, entry: null, refused: true });
          continue;
        }
        items.push({
          at: tender.recordedAt,
          id,
          position,
          entry: ctx.visible(
            entry({
              id,
              category: 'payment',
              occurredAt: tender.recordedAt,
              kind: `cash_tender.${tender.status}`,
              title: `Tender recorded (${tender.tenderKind.replaceAll('_', ' ')})`,
              personId: ctx.scope.of(tender.payerPersonId),
              record: { type: 'cash_tender', id: tender.id },
              status: tender.status,
              amount: { amountMinor: tender.amountMinor, currency: tender.currency },
              facilityId: tender.facilityId,
              details: { tenderKind: tender.tenderKind, obligationId: tender.obligationId },
            }),
          ),
        });
      }
      return page.nextCursor
        ? { items, next: { c: page.nextCursor, k: 0 }, exhausted: false }
        : { items, next: null, exhausted: true };
    };
  }

  /** The opening, reopening, resolution and closure of the cases about the people in scope. */
  private casesSource(ctx: SourceContext): SourceFetch {
    return async (from, limit): Promise<SourceBatch> => {
      const rows = await this.cases.statusHistoryAbout(
        ctx.organizationId,
        ctx.scope.expanded,
        from && 'a' in from ? { at: from.a, id: from.i } : null,
        limit,
      );
      const items: SourceItem[] = [];
      for (const row of rows) {
        const at = iso(row.event_at);
        const position = atPosition(at, row.event_id);
        const kind =
          row.event_to === 'open'
            ? row.event_from === null
              ? 'case.opened'
              : 'case.reopened'
            : row.event_to === 'resolved'
              ? 'case.resolved'
              : 'case.closed';
        const id =
          kind === 'case.opened'
            ? `support_case:${row.id}:opened`
            : `support_case:${row.id}:${row.event_id}`;
        try {
          await this.cases.requireOn(ctx.principal, SupportActions.readCase, row as CaseRow);
        } catch (error) {
          items.push(refusedItem(error, at, id, position));
          continue;
        }
        const details = (row.event_details ?? {}) as { resolutionKind?: unknown };
        items.push({
          at,
          id,
          position,
          entry: ctx.visible(
            entry({
              id,
              category: 'support',
              occurredAt: at,
              kind,
              title: row.title,
              personId: ctx.scope.of(row.subject_person_id),
              record: { type: 'support_case', id: row.id },
              status: row.status,
              facilityId: row.facility_id,
              details: {
                category: row.category,
                priority: row.priority,
                ...(kind === 'case.resolved'
                  ? { resolutionKind: details.resolutionKind ?? row.resolution_kind }
                  : {}),
              },
            }),
          ),
        });
      }
      const last = items[items.length - 1];
      return rows.length < limit || !last
        ? { items, next: null, exhausted: true }
        : { items, next: last.position, exhausted: false };
    };
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
}

interface SourceContext {
  principal: Principal;
  organizationId: string;
  scope: Scope;
  visible: (e: TimelineEntry) => TimelineEntry | null;
  batch: number;
}

type EnrollmentLike = Awaited<ReturnType<EnrollmentsService['list']>>['items'][number];

/** An entry of a one-shot source, positioned by its own instant and id. */
function item(ctx: SourceContext, input: EntryInput): SourceItem {
  const e = entry(input);
  return {
    at: e.occurredAt,
    id: e.id,
    position: atPosition(e.occurredAt, e.id),
    entry: ctx.visible(e),
  };
}

/** A record the owning module refused to the viewer: consumed, not shown. */
function refusedItem(error: unknown, at: string, id: string, position: SourcePosition): SourceItem {
  if (!isPermissionError(error)) throw error;
  return { at, id, position, entry: null, refused: true };
}

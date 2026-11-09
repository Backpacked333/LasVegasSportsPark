import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  DomainError,
  encodeCursor,
  errors,
  newId,
  systemPrincipal,
  z,
  type CancelOfferingSessionInput,
  type DomainEvent,
  type CreateOfferingSessionInput,
  type Event,
  type CapacityUnit,
  type FacilitySession,
  type FacilitySessionLocation,
  type ListFacilitySessionsQuery,
  type OfferingLocation,
  type OfferingSession,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  FacilityDirectory,
  Outbox,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  BOOKING_SOURCE_TYPE,
  EVENT_SCHEDULING_PORT,
  ResourcesService,
  type EventSchedulingPort,
} from '../../scheduling';
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import { relaxedStaffingRatios, requiredStaffFor } from '../catalog.policy';
import {
  capacityUnitsOf,
  organizationOf,
  toOfferingSession,
  toPublicOfferingSession,
  type OfferingRow,
} from '../catalog.shared';
import { EDITABLE_PUBLICATION_STATES, OfferingSessionMachine } from '../catalog.state-machines';
import { OfferingsService } from './offerings.service';

const FacilitySessionCursor = z.object({ scheduledStart: z.string(), id: z.string() });

/**
 * Sources of scheduling events whose own module decides their lifecycle: a league fixture
 * (competition postpones the fixture when its event is canceled) and a rental or party booking
 * (enrollment ends the booking with a money exception). A catalog session linked to such an event
 * never cancels it (§4.2: scheduling is the authority for the event, the owner for its record).
 */
const EVENT_SOURCES_WITH_OWN_LIFECYCLE: ReadonlySet<string> = new Set([
  'fixture',
  BOOKING_SOURCE_TYPE,
]);

/**
 * R2-JOURNEYS-02, §4.14: the reason the scheduling event of a session canceled in the catalog
 * carries. Scheduling shows an event's cancel reason to its participants and communications puts
 * it in the families' "Canceled" notice, while the catalog's own cancel reason is staff-only (the
 * child-safe session view hides it), so the event gets this fixed, customer-safe text and the
 * staff reason stays in the catalog session and its audit record.
 */
export const SESSION_CANCELED_EVENT_REASON = 'The program canceled this session.';

/** What a catalog cancel did with the scheduling event that reserved the session's space. */
export type LinkedEventOutcome =
  'canceled' | 'already_canceled' | 'not_found' | 'kept_shared' | 'kept_owned_elsewhere';

interface FollowedSchedulingEvent {
  eventId: string;
  change: string;
  reason: string | null;
  closureId: string | null;
}

/**
 * Individual sessions of an offering (§4.4 Session, SPK-CAT-002). A session may point at the
 * scheduling event that reserves its space; scheduling remains the authority for that event.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly offerings: OfferingsService,
    private readonly facilities: FacilityDirectory,
    @Inject(EVENT_SCHEDULING_PORT) private readonly events: EventSchedulingPort,
    private readonly resources: ResourcesService,
  ) {}

  /**
   * CAT-01 (SPK-SCHED-008, §4.14): the sessions at one facility that overlap [from, to) (at most
   * 31 days, checked by the query schema), for staff holding catalog.read_catalog at that
   * facility, so a desk can build an attendance ActivityRef (offeringId + sessionId). Ordered and
   * paged by (scheduled_start, id); offerings in every publication state are included. Each row
   * carries the facility's IANA time zone.
   */
  async listAtFacility(
    principal: Principal,
    query: ListFacilitySessionsQuery,
  ): Promise<Page<FacilitySession>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'offering_session',
      organizationId,
      facilityId: query.facilityId,
    });
    const facility = (
      await this.facilities.describe(organizationId, [query.facilityId], this.db)
    ).get(query.facilityId);
    if (!facility) throw errors.notFound('facility', query.facilityId);
    const cursor = decodeCursor(query.cursor, FacilitySessionCursor);
    let q = this.db
      .selectFrom('offering_sessions as s')
      .innerJoin('offerings as o', (join) =>
        join
          .onRef('o.organization_id', '=', 's.organization_id')
          .onRef('o.id', '=', 's.offering_id'),
      )
      .select([
        's.id',
        's.offering_id',
        's.sequence',
        's.title',
        's.scheduled_start',
        's.scheduled_end',
        's.status',
        's.scheduling_event_id',
        's.location',
        's.capacity_override',
        'o.name as offering_name',
        'o.facility_id',
        'o.location as offering_location',
        'o.capacity_units',
      ])
      .where('s.organization_id', '=', organizationId)
      .where('o.facility_id', '=', query.facilityId)
      .where('s.scheduled_start', '<', new Date(query.to))
      .where('s.scheduled_end', '>', new Date(query.from))
      .orderBy('s.scheduled_start')
      .orderBy('s.id')
      .limit(query.limit + 1);
    if (query.status) q = q.where('s.status', '=', query.status);
    if (cursor) {
      q = q.where(
        sql<boolean>`(s.scheduled_start, s.id) > (${cursor.scheduledStart}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const page = rows.slice(0, query.limit);
    const places = await this.sessionPlaces(organizationId, query.facilityId, page);
    const items = page.map((r): FacilitySession => {
      const override = (r.capacity_override as CapacityUnit[] | null) ?? null;
      return {
        sessionId: r.id,
        offeringId: r.offering_id,
        offeringName: r.offering_name,
        sequence: r.sequence,
        title: r.title,
        scheduledStart: new Date(r.scheduled_start).toISOString(),
        scheduledEnd: new Date(r.scheduled_end).toISOString(),
        status: r.status,
        schedulingEventId: r.scheduling_event_id,
        facilityId: r.facility_id,
        timezone: facility.timezone,
        location: places.get(r.id)!,
        capacity: override
          ? { source: 'session', units: override }
          : { source: 'offering', units: capacityUnitsOf(r) },
      };
    });
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last
        ? encodeCursor({
            scheduledStart: new Date(last.scheduled_start).toISOString(),
            id: last.id,
          })
        : null,
    };
  }

  /**
   * Where each listed session takes place (arrival "Sessions now", SPK-CAT-001 location): the
   * resources its scheduling event reserves (scheduling is the authority for reserved space), else
   * the session's own location (0210), else the offering's; resource names from the scheduling
   * module's inventory of the facility. Read as the catalog itself after the caller was authorized
   * for the facility's sessions; an event or resource scheduling no longer knows degrades to the
   * next source or a null name, never an error.
   */
  private async sessionPlaces(
    organizationId: string,
    facilityId: string,
    rows: ReadonlyArray<{
      id: string;
      scheduling_event_id: string | null;
      location: unknown;
      offering_location: unknown;
    }>,
  ): Promise<Map<string, FacilitySessionLocation>> {
    const out = new Map<string, FacilitySessionLocation>();
    if (rows.length === 0) return out;
    const reader = systemPrincipal(organizationId, 'catalog.session_location');
    const names = new Map(
      (await this.resources.listResources(reader, facilityId)).map((r) => [r.id, r.name]),
    );
    const eventResources = new Map<string, string[]>();
    for (const eventId of new Set(rows.map((r) => r.scheduling_event_id).filter((e) => !!e))) {
      const event = await this.currentEvent(organizationId, eventId!);
      if (event && event.resourceIds.length > 0) eventResources.set(eventId!, event.resourceIds);
    }
    const named = (ids: readonly string[]) =>
      ids.map((id) => ({ id, name: names.get(id) ?? null }));
    for (const row of rows) {
      const own = row.location as OfferingLocation | null;
      const offering = row.offering_location as OfferingLocation;
      const reserved = row.scheduling_event_id
        ? eventResources.get(row.scheduling_event_id)
        : undefined;
      const label = own?.label ?? offering.label ?? null;
      if (reserved) {
        out.set(row.id, { source: 'scheduling_event', label, resources: named(reserved) });
      } else if (own) {
        out.set(row.id, {
          source: 'session',
          label: own.label ?? null,
          resources: named(own.resourceIds ?? []),
        });
      } else if (offering.label || (offering.resourceIds?.length ?? 0) > 0) {
        out.set(row.id, {
          source: 'offering',
          label: offering.label ?? null,
          resources: named(offering.resourceIds ?? []),
        });
      } else {
        out.set(row.id, { source: 'none', label: null, resources: [] });
      }
    }
    return out;
  }

  /**
   * A session's own location names resources of the offering's facility (SPK-CAT-001 location,
   * §4.3 facility boundaries); scheduling's inventory decides, read as the catalog itself.
   */
  private async assertLocationResources(
    organizationId: string,
    offering: OfferingRow,
    location: OfferingLocation,
  ): Promise<void> {
    const ids = location.resourceIds ?? [];
    if (ids.length === 0) return;
    const known = new Set(
      (
        await this.resources.listResources(
          systemPrincipal(organizationId, 'catalog.session_location'),
          offering.facility_id,
        )
      ).map((r) => r.id),
    );
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw errors.validation(
        "A session location names resources of the offering's facility (SPK-CAT-001).",
        { path: 'location.resourceIds', unknownResourceIds: unknown },
      );
    }
  }

  async create(
    principal: Principal,
    offeringId: string,
    body: CreateOfferingSessionInput,
    correlationId: string | null,
  ): Promise<OfferingSession> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const offering = await this.offerings.loadOffering(trx, organizationId, offeringId, true);
      if (!offering) throw errors.notFound('offering', offeringId);
      await this.authorization.require(principal, CatalogActions.manageSessions, {
        type: 'offering_session',
        organizationId,
        facilityId: offering.facility_id,
      });
      if (!EDITABLE_PUBLICATION_STATES.includes(offering.publication_state)) {
        throw errors.invalidTransition(
          'OfferingPublication',
          offering.publication_state,
          'add_session',
        );
      }
      const overrideStaffing = body.capacityOverride
        ? await this.checkCapacityOverride(principal, offering, body)
        : null;
      if (body.schedulingEventId) {
        await this.assertSessionMatchesEvent(trx, organizationId, body.schedulingEventId, body);
      }
      if (body.location)
        await this.assertLocationResources(organizationId, offering, body.location);
      const latest = await trx
        .selectFrom('offering_sessions')
        .select((eb) => eb.fn.max('sequence').as('sequence'))
        .where('organization_id', '=', organizationId)
        .where('offering_id', '=', offeringId)
        .executeTakeFirst();
      const sequence = body.sequence ?? (latest?.sequence ?? 0) + 1;
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('offering_sessions')
          .values({
            id,
            organization_id: organizationId,
            offering_id: offeringId,
            sequence,
            title: body.title ?? null,
            scheduled_start: new Date(body.scheduledStart),
            scheduled_end: new Date(body.scheduledEnd),
            scheduling_event_id: body.schedulingEventId ?? null,
            capacity_override:
              body.capacityOverride === undefined ? null : json(body.capacityOverride),
            location: body.location ? json(normalizedLocation(body.location)) : null,
            canceled_at: null,
            cancel_reason: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A session with this sequence already exists.', {
            sequence,
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.session_created',
        targetType: 'offering_session',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: {
          offeringId,
          sequence,
          ...(overrideStaffing
            ? { capacityOverride: body.capacityOverride, ...overrideStaffing }
            : {}),
          ...(body.location ? { location: normalizedLocation(body.location) } : {}),
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.sessionCreated, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: offeringId,
        payload: {
          sessionId: id,
          offeringId,
          sequence,
          scheduledStart: new Date(row.scheduled_start).toISOString(),
          scheduledEnd: new Date(row.scheduled_end).toISOString(),
          schedulingEventId: row.scheduling_event_id,
          capacityOverride: body.capacityOverride ?? null,
        },
        correlationId,
      });
      return toOfferingSession(row);
    });
  }

  /**
   * SPK-YOUTH-002: a session capacity override is commercial capacity (enrollment holds session
   * places against it instead of the offering's units), so it is offering configuration: it needs
   * the offering manager's authority, follows the camp-group publication rule, and an override that
   * raises the staffing requirement, removes or relaxes a staffing ratio, or adds unstaffed places
   * to a staffed offering needs an explicit reason. Overrides are not re-validated at publication,
   * so the rule applies in every editable state.
   */
  private async checkCapacityOverride(
    principal: Principal,
    offering: {
      id: string;
      organization_id: string;
      facility_id: string;
      capacity_units: unknown[];
    },
    body: CreateOfferingSessionInput,
  ) {
    const override = body.capacityOverride ?? [];
    await this.authorization.require(principal, CatalogActions.manageOfferings, {
      type: 'offering',
      id: offering.id,
      organizationId: offering.organization_id,
      facilityId: offering.facility_id,
    });
    if (
      override.some((u) => u.unit === 'camp_group_places' && (!u.groupSize || !u.staffingRatio))
    ) {
      throw errors.validation(
        'Camp group places require a group size and a staffing ratio (SPK-YOUTH-002).',
        { path: 'capacityOverride' },
      );
    }
    const base = capacityUnitsOf(offering);
    const requiredStaffOffering = requiredStaffFor(base);
    const requiredStaffOverride = requiredStaffFor(override);
    const ratiosRelaxed = relaxedStaffingRatios(base, override);
    const unstaffedUnits =
      requiredStaffOffering > 0 ? override.filter((u) => !u.staffingRatio).map((u) => u.unit) : [];
    if (
      (requiredStaffOverride > requiredStaffOffering ||
        ratiosRelaxed.length > 0 ||
        unstaffedUnits.length > 0) &&
      !body.reason
    ) {
      throw errors.validation(
        "This session capacity override bypasses the offering's staffing requirement; provide a reason confirming staffing is arranged (SPK-YOUTH-002).",
        {
          path: 'reason',
          requiredStaffOffering,
          requiredStaffOverride,
          ratiosRelaxed,
          unstaffedUnits,
        },
      );
    }
    return { requiredStaffOffering, requiredStaffOverride, ratiosRelaxed, unstaffedUnits };
  }

  /**
   * R2-JOURNEYS-03 (SPK-AT-009 consistent publication): a session linked to a scheduling event
   * takes that event's times, because it follows the event from then on (every later change of
   * the event's times is copied onto the session, `retimeWithEvent`). The event must exist and be
   * live (draft or published), and the session's start and end must equal the event's current
   * ones; a session covering only part of a booking, or two sessions at different times on one
   * event, would otherwise be overwritten with the event's whole span on its next change. Holds
   * the per-event lock until commit, so a change of the event committed meanwhile is either seen
   * here (and refused) or followed by `followSchedulingEvent` once this session is visible.
   */
  private async assertSessionMatchesEvent(
    trx: Trx,
    organizationId: string,
    eventId: string,
    body: CreateOfferingSessionInput,
  ): Promise<void> {
    await this.lockSessionEvent(trx, organizationId, eventId);
    const event = await this.currentEvent(organizationId, eventId);
    if (!event) {
      throw errors.validation('Unknown scheduling event.', { path: 'schedulingEventId' });
    }
    if (event.status === 'canceled') {
      throw errors.validation(
        'The scheduling event is canceled; link the session to a live event (SPK-AT-009).',
        { path: 'schedulingEventId', eventStatus: event.status },
      );
    }
    const sameTimes =
      new Date(body.scheduledStart).getTime() === new Date(event.scheduledStart).getTime() &&
      new Date(body.scheduledEnd).getTime() === new Date(event.scheduledEnd).getTime();
    if (!sameTimes) {
      throw errors.validation(
        "A session linked to a scheduling event takes the event's start and end; it then follows the event's changes (SPK-AT-009).",
        {
          path: 'scheduledStart',
          eventScheduledStart: event.scheduledStart,
          eventScheduledEnd: event.scheduledEnd,
        },
      );
    }
  }

  /**
   * The per-event lock every writer of sessions linked to one scheduling event takes before it
   * reads or locks those sessions: a catalog cancel (sibling check), a session creation (event
   * times check) and `followSchedulingEvent` (cancel or retime). One order everywhere (this lock,
   * then session rows, then scheduling's event row) keeps them deadlock-free; the lock is held
   * until the transaction ends.
   */
  private async lockSessionEvent(trx: Trx, organizationId: string, eventId: string): Promise<void> {
    const lockKey = `catalog.session_event:${organizationId}:${eventId}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
  }

  async cancel(
    principal: Principal,
    id: string,
    body: CancelOfferingSessionInput,
    correlationId: string | null,
  ): Promise<OfferingSession> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      // The per-event lock comes before the session row lock (lockSessionEvent); a session's
      // scheduling event never changes, so reading it unlocked first is safe.
      const link = await trx
        .selectFrom('offering_sessions')
        .select('scheduling_event_id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!link) throw errors.notFound('session', id);
      if (link.scheduling_event_id) {
        await this.lockSessionEvent(trx, organizationId, link.scheduling_event_id);
      }
      const current = await trx
        .selectFrom('offering_sessions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('session', id);
      const offering = await this.offerings.loadOffering(trx, organizationId, current.offering_id);
      if (!offering) throw errors.notFound('offering', current.offering_id);
      await this.authorization.require(principal, CatalogActions.manageSessions, {
        type: 'offering_session',
        id,
        organizationId,
        facilityId: offering.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = OfferingSessionMachine.next(current.status, 'cancel');
      const updated = await trx
        .updateTable('offering_sessions')
        .set({
          status: next,
          canceled_at: this.clock.now(),
          cancel_reason: body.reason,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      const schedulingEvent = current.scheduling_event_id
        ? {
            id: current.scheduling_event_id,
            outcome: await this.releaseLinkedEvent(
              principal,
              trx,
              organizationId,
              current.id,
              current.scheduling_event_id,
              correlationId,
            ),
          }
        : null;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.session_canceled',
        targetType: 'offering_session',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason,
        correlationId,
        details: schedulingEvent ? { schedulingEvent } : undefined,
      });
      await this.outbox.enqueue(trx, CatalogEvents.sessionCanceled, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: current.offering_id,
        payload: {
          sessionId: id,
          offeringId: current.offering_id,
          sequence: current.sequence,
          schedulingEventId: current.scheduling_event_id,
          reason: body.reason,
        },
        correlationId,
      });
      return toOfferingSession(updated);
    });
  }

  /**
   * Sessions linked to scheduling events (any status), read through the caller's executor so an
   * outbox handler or a closure preview inside a transaction can call it (§4.2: other modules read
   * catalog sessions only through this service).
   */
  async sessionsOfSchedulingEvents(
    db: Db | Trx,
    organizationId: string,
    eventIds: readonly string[],
  ): Promise<
    Array<{
      id: string;
      offeringId: string;
      schedulingEventId: string;
      status: string;
      scheduledStart: string;
      scheduledEnd: string;
    }>
  > {
    if (eventIds.length === 0) return [];
    const rows = await db
      .selectFrom('offering_sessions')
      .select([
        'id',
        'offering_id',
        'scheduling_event_id',
        'status',
        'scheduled_start',
        'scheduled_end',
      ])
      .where('organization_id', '=', organizationId)
      .where('scheduling_event_id', 'in', [...new Set(eventIds)])
      .orderBy('scheduled_start')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      offeringId: r.offering_id,
      schedulingEventId: r.scheduling_event_id as string,
      status: r.status,
      scheduledStart: new Date(r.scheduled_start).toISOString(),
      scheduledEnd: new Date(r.scheduled_end).toISOString(),
    }));
  }

  /**
   * R2-JOURNEYS-02 (SPK-AT-009 consistent publication, SPK-COMMS-002 cancellation, §4.2): a
   * session canceled in the catalog releases the scheduling event that reserves its space, through
   * scheduling's port in the caller's unit of work and with the caller's own authority
   * (`scheduling.manage_events` at the event's facility, the facility's schedule authority). The
   * resulting `scheduling.event_changed` 'canceled' frees the space, updates the calendar
   * projection and ICS feeds, tells the session's families once and leaves no reminder;
   * `catalog.follow_scheduling_event` then finds no scheduled session to cancel. The event is
   * canceled with `SESSION_CANCELED_EVENT_REASON`, never the catalog's staff-only reason (§4.14).
   * Any refusal from scheduling refuses the whole cancel, so a session is never canceled while the
   * event it should release silently stays live. The event is kept, and the audit says so, when
   * another scheduled session still uses it (the last one to go releases it; the per-event lock
   * the caller holds serializes concurrent cancels of sessions sharing one event) or when a
   * fixture or a booking owns it (their modules decide). A missing or already canceled event
   * needs nothing.
   */
  private async releaseLinkedEvent(
    principal: Principal,
    trx: Trx,
    organizationId: string,
    sessionId: string,
    eventId: string,
    correlationId: string | null,
  ): Promise<LinkedEventOutcome> {
    const event = await this.currentEvent(organizationId, eventId);
    if (!event) return 'not_found';
    if (event.status === 'canceled') return 'already_canceled';
    if (event.sourceType && EVENT_SOURCES_WITH_OWN_LIFECYCLE.has(event.sourceType)) {
      return 'kept_owned_elsewhere';
    }
    const sibling = await trx
      .selectFrom('offering_sessions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('scheduling_event_id', '=', eventId)
      .where('status', '=', 'scheduled')
      .where('id', '!=', sessionId)
      .limit(1)
      .executeTakeFirst();
    if (sibling) return 'kept_shared';
    await this.events.cancelEvent(principal, eventId, {
      reason: SESSION_CANCELED_EVENT_REASON,
      correlationId,
    });
    return 'canceled';
  }

  /**
   * The scheduling event's latest committed state, read through the active transaction (§4.2:
   * through scheduling's port, never its tables), or null when it does not exist.
   */
  private async currentEvent(organizationId: string, eventId: string): Promise<Event | null> {
    try {
      return await this.events.getEvent(
        systemPrincipal(organizationId, 'catalog.follow_scheduling'),
        eventId,
      );
    } catch (error) {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /**
   * SPK-AT-009, SPK-SCHED-009, §4.12: scheduling is the authority for the event that reserves a
   * session's space. When that event is canceled (a closure's `cancel_affected`, a series edit, a
   * direct cancel) the linked catalog sessions are canceled too; on any other change (moved or
   * resized by a series edit, a schedule-draft publication or a closure resolved by rescheduling,
   * or a draft published at times that changed while it was a draft) the linked scheduled
   * sessions take the event's current published times (R2-JOURNEYS-03), so the catalog, the
   * family calendar, entry's check-in window and the families' notices agree. Runs in the outbox
   * handler's transaction under the per-event lock and is idempotent under replay (an already
   * canceled session, or one already at the event's times, is left alone). Makeup or credit for a
   * canceled session stays a staff decision under DEC-003.
   */
  async followSchedulingEvent(
    trx: Trx,
    event: DomainEvent<FollowedSchedulingEvent>,
  ): Promise<number> {
    const organizationId = event.organizationId;
    await this.lockSessionEvent(trx, organizationId, event.payload.eventId);
    if (event.payload.change !== 'canceled') return this.retimeWithEvent(trx, event);
    const rows = await trx
      .selectFrom('offering_sessions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('scheduling_event_id', '=', event.payload.eventId)
      .where('status', '=', 'scheduled')
      .orderBy('id')
      .forUpdate()
      .execute();
    const actor = systemPrincipal(organizationId, 'catalog.follow_scheduling');
    const reason = event.payload.reason ?? 'The scheduled activity was canceled.';
    for (const current of rows) {
      const next = OfferingSessionMachine.next(current.status, 'cancel');
      const updated = await trx
        .updateTable('offering_sessions')
        .set({
          status: next,
          canceled_at: this.clock.now(),
          cancel_reason: reason,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', current.id)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor,
        action: 'catalog.session_canceled',
        targetType: 'offering_session',
        targetId: current.id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason,
        correlationId: event.correlationId,
        details: {
          schedulingEventId: event.payload.eventId,
          closureId: event.payload.closureId,
          sourceEventId: event.id,
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.sessionCanceled, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: current.offering_id,
        payload: {
          sessionId: current.id,
          offeringId: current.offering_id,
          sequence: current.sequence,
          schedulingEventId: current.scheduling_event_id,
          reason,
        },
        correlationId: event.correlationId,
      });
    }
    return rows.length;
  }

  /**
   * R2-JOURNEYS-03: the linked scheduled sessions take the event's CURRENT times, read through
   * the handler's transaction rather than the payload's `after`, because deliveries can arrive
   * late and out of order (a retried move after a newer one): every delivery, in any order,
   * converges on the latest committed times (§4.12, §4.6). Every change kind is followed, not
   * only 'moved' and 'resized': a draft event moved while still a draft emits nothing, and its
   * publication arrives as 'published' at the new times. Copying the event's span is correct
   * because a linked session is created at its event's times (`assertSessionMatchesEvent`). A
   * canceled event is left to its own 'canceled' delivery, and a draft event holds no published
   * time yet. Each changed session gets a revision bump, an audit record and
   * `catalog.session_retimed` for the modules that copy its times (enrollment's session bookings,
   * workforce's session assignments).
   */
  private async retimeWithEvent(
    trx: Trx,
    event: DomainEvent<FollowedSchedulingEvent>,
  ): Promise<number> {
    const organizationId = event.organizationId;
    const rows = await trx
      .selectFrom('offering_sessions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('scheduling_event_id', '=', event.payload.eventId)
      .where('status', '=', 'scheduled')
      .orderBy('id')
      .forUpdate()
      .execute();
    if (rows.length === 0) return 0;
    const current = await this.currentEvent(organizationId, event.payload.eventId);
    if (!current || current.status !== 'published') return 0;
    const start = new Date(current.scheduledStart);
    const end = new Date(current.scheduledEnd);
    const actor = systemPrincipal(organizationId, 'catalog.follow_scheduling');
    let retimed = 0;
    for (const row of rows) {
      const previousStart = new Date(row.scheduled_start);
      const previousEnd = new Date(row.scheduled_end);
      if (previousStart.getTime() === start.getTime() && previousEnd.getTime() === end.getTime()) {
        continue;
      }
      const updated = await trx
        .updateTable('offering_sessions')
        .set({ scheduled_start: start, scheduled_end: end, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      const times = {
        previousStart: previousStart.toISOString(),
        previousEnd: previousEnd.toISOString(),
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
      };
      await this.audit.record(trx, {
        organizationId,
        actor,
        action: 'catalog.session_retimed',
        targetType: 'offering_session',
        targetId: row.id,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        reason: event.payload.reason,
        correlationId: event.correlationId,
        details: {
          ...times,
          schedulingEventId: event.payload.eventId,
          eventRevision: current.revision,
          change: event.payload.change,
          sourceEventId: event.id,
        },
      });
      await this.outbox.enqueue(trx, CatalogEvents.sessionRetimed, {
        organizationId,
        aggregateType: 'offering',
        aggregateId: row.offering_id,
        payload: {
          sessionId: row.id,
          offeringId: row.offering_id,
          sequence: row.sequence,
          schedulingEventId: event.payload.eventId,
          ...times,
          revision: updated.revision,
          reason: event.payload.reason,
        },
        correlationId: event.correlationId,
      });
      retimed += 1;
    }
    return retimed;
  }

  /** Same visibility rule as the offering itself (public when published, every state for staff). */
  /**
   * Sessions of an offering the reader may see. Catalog staff (and system principals, which other
   * modules use) get the full session; any other reader gets the child-safe view (§4.14).
   */
  async list(principal: Principal, offeringId: string): Promise<OfferingSession[]> {
    const { row, staff } = await this.offerings.loadVisible(principal, offeringId);
    const rows = await this.db
      .selectFrom('offering_sessions')
      .selectAll()
      .where('organization_id', '=', row.organization_id)
      .where('offering_id', '=', row.id)
      .orderBy('sequence')
      .execute();
    return rows.map(staff ? toOfferingSession : toPublicOfferingSession);
  }
}

/** A session location as stored: a trimmed label when given, distinct resource ids when given. */
function normalizedLocation(location: OfferingLocation): OfferingLocation {
  const out: OfferingLocation = {};
  if (location.label && location.label.trim().length > 0) out.label = location.label.trim();
  if (location.resourceIds && location.resourceIds.length > 0) {
    out.resourceIds = [...new Set(location.resourceIds)];
  }
  return out;
}

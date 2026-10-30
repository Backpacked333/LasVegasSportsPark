import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ApproveBookingInput,
  type Booking,
  type BookingAvailability,
  type BookingAvailabilityQuery,
  type CancelBookingInput,
  type CapabilityId,
  type CreateBookingInput,
  type DeclineBookingInput,
  type EligibilityResult,
  type ListBookingsQuery,
  type ListMyBookingsQuery,
  type Page,
  type PartyCommitment,
  type PolicyVersion,
  type Principal,
  type StaffRole,
} from '@sportspark/contracts';
import { json, type BookingsTable, type Db } from '@sportspark/db';
import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  FacilityDirectory,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  POLICY_PORT,
  type OfferingLookupPort,
  type OfferingSnapshot,
  type PolicyPort,
} from '../../catalog';
import { ASSET_DIRECTORY_PORT, type AssetDirectoryPort } from '../../facilities';
import type { PersonSummary } from '../../identity';
import {
  AVAILABILITY_PORT,
  EVENT_SCHEDULING_PORT,
  ResourcesService,
  localDateOf,
  localTimeOf,
  materializeOccurrences,
  type AvailabilityPort,
  type EventSchedulingPort,
} from '../../scheduling';
import {
  ASSIGNMENT_COVERAGE_PORT,
  WORKFORCE_STAFFING_PORT,
  type AssignmentCoveragePort,
  type WorkforceStaffingPort,
} from '../../workforce';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentPackageGEvents } from '../enrollment.events';
import type { BookingOfPeriod, BookingQueryPort } from '../enrollment.ports';
import {
  actorSnapshot,
  beforeCursor,
  cursorAt,
  decodeCreatedCursor,
  enrollmentSystem,
  iso,
  isStaffLike,
  keysetPage,
  minutesFrom,
  organizationOf,
  type Reader,
} from '../enrollment.shared';
import { BookingMachine, type BookingEvent } from '../enrollment.state-machines';
import { missingAcknowledgments } from '../eligibility/registration-eligibility';
import {
  bookingTermsContent,
  typedScope,
  type BookingTermsContent,
  type PartyPackageScope,
  type RentalResourceScope,
  type StaffingRequirement,
} from '../package-g/scopes';
import { BasketsService } from './baskets.service';
import { CapacityService } from './capacity.service';
import { CustomerScope } from './customer-scope';
import { EnrollmentsService } from './enrollments.service';
import { EnrollmentFacilityScope } from './facility-scope';
import { RegistrationEvaluator, type Evaluation } from './registration-evaluator';

export type BookingRow = Selectable<BookingsTable>;
type BookingKind = BookingRow['kind'];

/** Everything a booking reserves, derived from the offering's definition, terms and the request. */
interface BookingPlan {
  kind: BookingKind;
  snapshot: OfferingSnapshot;
  terms: PolicyVersion;
  content: BookingTermsContent;
  timezone: string;
  occurrences: Array<{ start: Date; end: Date }>;
  recurrence: { interval: number; byWeekday?: number[]; count: number } | null;
  durationMinutes: number;
  resourceIds: string[];
  equipmentAssetIds: string[];
  guestCount: number | null;
  staffing: StaffingRequirement[];
}

const SOURCE_TYPE = 'enrollment.booking';

function capabilityOf(kind: BookingKind): CapabilityId {
  return kind === 'rental' ? 'rentals' : 'parties';
}

function isParty(scope: PartyPackageScope | RentalResourceScope): scope is PartyPackageScope {
  return 'guestLimit' in scope;
}

function bookingScope(
  snapshot: OfferingSnapshot,
  kind: BookingKind,
): PartyPackageScope | RentalResourceScope | null {
  return kind === 'rental'
    ? typedScope(snapshot, 'rental_resource')
    : typedScope(snapshot, 'party_package');
}

function bookingKindOf(offeringKind: string): BookingKind | null {
  if (offeringKind === 'rental') return 'rental';
  if (offeringKind === 'party') return 'party';
  return null;
}

/**
 * Rentals and parties (ENR-13; §3.16 Rentals and Parties rows, SPK-COND-003, SPK-REG-001,
 * SPK-REG-007). A booking reserves its space through scheduling events (the physical guarantee is
 * scheduling's exclusion constraint), declares its mandatory staff on every event through
 * workforce, and is paid through an ordinary basket line, server-owned hold and enrollment. In
 * instant mode all of that happens in one unit of work, so a slot that is taken writes nothing; in
 * request mode (DEC-029, POL-005) nothing is reserved until a scheduler approves. A paid booking
 * is confirmed only when every mandatory staff slot is covered, otherwise it waits in
 * `awaiting_staff` with an exception for the scheduler queue. Creating and approving need the
 * `rentals` or `parties` switch (DEC-016, DEC-076, DEC-077); decline, cancellation, expiry,
 * staffing, completion and payment outcomes never check it. Implements BOOKING_QUERY_PORT (IF-36).
 */
@Injectable()
export class BookingsService implements BookingQueryPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
    @Inject(EVENT_SCHEDULING_PORT) private readonly events: EventSchedulingPort,
    @Inject(AVAILABILITY_PORT) private readonly availability: AvailabilityPort,
    @Inject(WORKFORCE_STAFFING_PORT) private readonly staffing: WorkforceStaffingPort,
    @Inject(ASSIGNMENT_COVERAGE_PORT) private readonly coverage: AssignmentCoveragePort,
    @Inject(ASSET_DIRECTORY_PORT) private readonly assets: AssetDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly facilities: FacilityDirectory,
    private readonly exceptions: OperationalExceptions,
    private readonly resources: ResourcesService,
    private readonly evaluator: RegistrationEvaluator,
    private readonly baskets: BasketsService,
    private readonly capacity: CapacityService,
    private readonly enrollments: EnrollmentsService,
    private readonly scope: EnrollmentFacilityScope,
    private readonly customers: CustomerScope,
  ) {}

  private system(organizationId: string): Principal {
    return enrollmentSystem(organizationId, SOURCE_TYPE);
  }

  /** A resource's name for display (null when scheduling no longer knows it). */
  private async resourceName(system: Principal, resourceId: string): Promise<string | null> {
    try {
      return (await this.resources.getResource(system, resourceId)).name;
    } catch {
      return null;
    }
  }

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<BookingRow | undefined> {
    let q = db
      .selectFrom('bookings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  // -------------------------------------------------------------------------------------------
  // Planning (validation shared by create and approve)
  // -------------------------------------------------------------------------------------------

  private async zone(organizationId: string, facilityId: string, trx?: Trx): Promise<string> {
    const zone = (await this.facilities.describe(organizationId, [facilityId], trx)).get(
      facilityId,
    )?.timezone;
    if (!zone) throw errors.notFound('facility', facilityId);
    return zone;
  }

  private async plan(
    trx: Trx,
    organizationId: string,
    snapshot: OfferingSnapshot,
    terms: PolicyVersion | null,
    request: {
      start: Date;
      end: Date | null;
      recurrence: BookingPlan['recurrence'];
      resourceIds: string[];
      guestCount: number | null;
    },
  ): Promise<BookingPlan> {
    const kind = bookingKindOf(snapshot.offering.kind);
    if (!kind) {
      throw errors.validation('Bookings are for rental and party offerings.', {
        path: 'offeringId',
      });
    }
    const content = bookingTermsContent(terms);
    if (!terms || !content) {
      // IF-23, POL-040: no approved booking terms, no booking (nothing is assumed).
      throw errors.resourceConflict('This offering has no approved booking terms.', {
        code: 'BOOKING_TERMS_REQUIRED',
      });
    }
    const scope = bookingScope(snapshot, kind);
    if (!scope) {
      throw errors.resourceConflict('What this offering reserves cannot be read.', {
        code: 'BOOKING_DEFINITION_INVALID',
      });
    }
    const resourceIds = [...new Set(request.resourceIds)];
    if (
      resourceIds.length !== request.resourceIds.length ||
      resourceIds.length !== scope.resources.count ||
      resourceIds.some((id) => !scope.resources.resourceIds.includes(id))
    ) {
      throw errors.validation(
        `Choose exactly ${scope.resources.count} of the offering's resources.`,
        {
          code: 'RESOURCES_NOT_ALLOWED',
          path: 'resourceIds',
          allowedResourceIds: scope.resources.resourceIds,
          count: scope.resources.count,
        },
      );
    }
    let durationMinutes: number;
    let guestCount: number | null = null;
    let equipmentAssetIds: string[] = [];
    if (isParty(scope)) {
      durationMinutes = scope.durationMinutes;
      if (request.recurrence) {
        throw errors.validation('A party is one occurrence.', { path: 'recurrence' });
      }
      if (
        request.end &&
        request.end.getTime() !== request.start.getTime() + durationMinutes * 60_000
      ) {
        throw errors.validation(`A party of this package lasts ${durationMinutes} minutes.`, {
          path: 'end',
        });
      }
      if (request.guestCount === null) {
        throw errors.validation('A party states its number of guests.', { path: 'guestCount' });
      }
      if (request.guestCount > scope.guestLimit) {
        throw errors.validation(`This package takes at most ${scope.guestLimit} guests.`, {
          code: 'GUEST_LIMIT_EXCEEDED',
          path: 'guestCount',
        });
      }
      guestCount = request.guestCount;
      equipmentAssetIds = scope.equipmentAssetIds;
    } else {
      if (!request.end) throw errors.validation('A rental states its end.', { path: 'end' });
      if (request.guestCount !== null) {
        throw errors.validation('Guests are counted for parties only.', { path: 'guestCount' });
      }
      durationMinutes = Math.round((request.end.getTime() - request.start.getTime()) / 60_000);
      if (durationMinutes <= 0) {
        throw errors.validation('A booking ends after it starts.', { path: 'end' });
      }
    }
    const now = this.clock.now();
    if (request.start.getTime() <= now.getTime()) {
      throw errors.validation('A booking starts in the future.', { path: 'start' });
    }
    const timezone = await this.zone(organizationId, snapshot.offering.facilityId, trx);
    const occurrences = request.recurrence
      ? materializeOccurrences(
          {
            frequency: 'weekly',
            interval: request.recurrence.interval,
            byWeekday: request.recurrence.byWeekday,
            startDate: localDateOf(timezone, request.start),
            count: request.recurrence.count,
          },
          {
            localStartTime: localTimeOf(timezone, request.start),
            durationMinutes,
            timezone,
            maxOccurrences: 52,
          },
        ).map((o) => ({ start: o.start, end: o.end }))
      : [
          {
            start: request.start,
            end: new Date(request.start.getTime() + durationMinutes * 60_000),
          },
        ];
    if (occurrences.length === 0) {
      throw errors.validation('The recurrence has no occurrence.', { path: 'recurrence' });
    }
    if (equipmentAssetIds.length > 0) {
      const described = await this.assets.describe(organizationId, equipmentAssetIds, trx);
      const unusable = equipmentAssetIds.filter((id) => {
        const asset = described.get(id);
        return !asset || !asset.usable || asset.facilityId !== snapshot.offering.facilityId;
      });
      if (unusable.length > 0) {
        throw errors.resourceConflict('Equipment this booking needs is not available.', {
          code: 'EQUIPMENT_UNAVAILABLE',
          assetIds: unusable,
        });
      }
    }
    return {
      kind,
      snapshot,
      terms,
      content,
      timezone,
      occurrences,
      recurrence: request.recurrence,
      durationMinutes,
      resourceIds,
      equipmentAssetIds,
      guestCount,
      staffing: scope.staffing,
    };
  }

  private assertBookable(result: EligibilityResult, personId: string): void {
    if (!result.eligible) {
      throw errors.eligibility('The booker is not eligible for this offering.', {
        participantPersonId: personId,
        reasons: result.reasons,
        alternatives: result.alternatives,
      });
    }
    const missing = missingAcknowledgments(result);
    if (missing.length > 0) {
      throw errors.missingAcknowledgment('Required forms must be acknowledged before booking.', {
        participantPersonId: personId,
        policyVersionIds: missing,
      });
    }
  }

  private intentOf(kind: BookingKind) {
    return kind === 'rental' ? ('rental_request' as const) : ('party_request' as const);
  }

  /** Read-only conflict detection for request mode: every resource free at every occurrence. */
  private async conflictsOf(
    organizationId: string,
    plan: BookingPlan,
  ): Promise<Array<{ occurrenceStart: string; resourceId: string }>> {
    const system = this.system(organizationId);
    const conflicts: Array<{ occurrenceStart: string; resourceId: string }> = [];
    const setup = plan.content.setupMinutes ?? 0;
    const cleanup = plan.content.cleanupMinutes ?? 0;
    for (const occurrence of plan.occurrences) {
      for (const resourceId of plan.resourceIds) {
        const free = await this.availability.findAvailableSlots(system, {
          resourceId,
          interval: {
            start: new Date(occurrence.start.getTime() - setup * 60_000).toISOString(),
            end: new Date(occurrence.end.getTime() + cleanup * 60_000).toISOString(),
          },
          durationMinutes: plan.durationMinutes,
          setupMinutes: plan.content.setupMinutes,
          cleanupMinutes: plan.content.cleanupMinutes,
        });
        if (!free.some((slot) => new Date(slot.start).getTime() === occurrence.start.getTime())) {
          conflicts.push({ occurrenceStart: occurrence.start.toISOString(), resourceId });
        }
      }
    }
    return conflicts;
  }

  /**
   * The instant steps (create, or approval of a request): the events (one, or the weekly series;
   * all conflicts first, nothing written), staffing on every event, the basket line and its hold.
   */
  private async reserve(
    trx: Trx,
    organizationId: string,
    bookingId: string,
    plan: BookingPlan,
    booker: PersonSummary,
    evaluation: Evaluation,
    actor: Principal,
    existingBasketId: string | null,
    correlationId: string | null,
  ) {
    const system = this.system(organizationId);
    const title = plan.snapshot.offering.name;
    const commitments: PartyCommitment[] = plan.equipmentAssetIds.map((assetId) => ({
      partyType: 'equipment',
      partyId: assetId,
      role: 'equipment',
    }));
    let eventIds: string[];
    let seriesId: string | null = null;
    if (plan.recurrence) {
      const first = plan.occurrences[0]!;
      const series = await this.events.createEventSeries(system, {
        kind: plan.kind,
        title,
        facilityId: plan.snapshot.offering.facilityId,
        resourceIds: plan.resourceIds,
        recurrence: {
          frequency: 'weekly',
          interval: plan.recurrence.interval,
          byWeekday: plan.recurrence.byWeekday,
          startDate: localDateOf(plan.timezone, first.start),
          count: plan.recurrence.count,
        },
        localStartTime: localTimeOf(plan.timezone, first.start),
        durationMinutes: plan.durationMinutes,
        setupMinutes: plan.content.setupMinutes,
        cleanupMinutes: plan.content.cleanupMinutes,
        commitments,
        sourceType: SOURCE_TYPE,
        sourceId: bookingId,
        correlationId,
      });
      eventIds = series.eventIds;
      seriesId = series.seriesId;
    } else {
      const occurrence = plan.occurrences[0]!;
      const event = await this.events.createEvent(system, {
        facilityId: plan.snapshot.offering.facilityId,
        kind: plan.kind,
        title,
        scheduledStart: occurrence.start.toISOString(),
        scheduledEnd: occurrence.end.toISOString(),
        setupMinutes: plan.content.setupMinutes,
        cleanupMinutes: plan.content.cleanupMinutes,
        resourceIds: plan.resourceIds,
        commitments,
        sourceType: SOURCE_TYPE,
        sourceId: bookingId,
        correlationId,
      });
      eventIds = [event.id];
    }
    if (plan.staffing.length > 0) {
      for (const eventId of eventIds) {
        await this.staffing.declareRequirements(system, {
          targetType: 'event',
          targetId: eventId,
          facilityId: plan.snapshot.offering.facilityId,
          targetTitle: title,
          requirements: plan.staffing.map((s) => ({
            kind: s.kind,
            role: s.role as StaffRole,
            requiredCount: s.count,
            requiredQualifications: s.qualifications,
          })),
        });
      }
    }
    const { basket, lineId } = await this.baskets.openForLine(trx, organizationId, {
      owner: booker,
      payerPersonId: booker.id,
      actor,
      participant: booker,
      snapshot: plan.snapshot,
      intent: this.intentOf(plan.kind),
      sessionId: null,
      evaluation,
      applicationId: null,
      existingBasketId,
      noEquivalence: true,
      correlationId,
    });
    const pool = await this.capacity.ensureBookingPool(trx, organizationId, {
      offeringId: plan.snapshot.offering.id,
      bookingId,
      actor: system,
    });
    const expiresAt = minutesFrom(this.clock.now(), this.evaluator.configuration.holdMinutes);
    const holds = await this.capacity.acquireHolds(trx, organizationId, {
      pools: [{ poolId: pool.id, quantity: 1 }],
      ownerKind: 'basket',
      ownerId: lineId,
      basketId: basket.id,
      actor,
      expiresAt,
      correlationId,
    });
    const held = await this.baskets.holdOpenedBasket(
      trx,
      organizationId,
      basket,
      lineId,
      actor,
      holds.map((h) => h.id),
      expiresAt,
      correlationId,
    );
    return {
      eventIds,
      seriesId,
      basketId: basket.id,
      lineId,
      enrollmentId: held.enrollmentId,
      poolId: pool.id,
    };
  }

  // -------------------------------------------------------------------------------------------
  // POST /bookings
  // -------------------------------------------------------------------------------------------

  async create(
    principal: Principal,
    input: CreateBookingInput,
    correlationId: string | null,
  ): Promise<Booking> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const snapshot = await this.evaluator.snapshot(trx, organizationId, input.offeringId);
      const kind = bookingKindOf(snapshot.offering.kind);
      if (!kind) {
        throw errors.validation('Bookings are for rental and party offerings.', {
          path: 'offeringId',
        });
      }
      const bookerId = input.bookerPersonId ?? principal.personId;
      if (!bookerId) throw errors.validation('bookerPersonId is required.');
      const booker = await this.evaluator.participant(trx, organizationId, bookerId);
      await this.authorization.require(principal, EnrollmentActions.requestBooking, {
        type: 'booking',
        organizationId,
        facilityId: snapshot.offering.facilityId,
        subjectPersonIds: [booker.id],
      });
      // DEC-016, DEC-076, DEC-077: a new rental or party needs its switch.
      await this.capabilities.require(organizationId, capabilityOf(kind), trx);
      const plan = await this.plan(trx, organizationId, snapshot, snapshot.bookingTerms, {
        start: new Date(input.start),
        end: input.end ? new Date(input.end) : null,
        recurrence: input.recurrence
          ? {
              interval: input.recurrence.interval,
              byWeekday: input.recurrence.byWeekday,
              count: input.recurrence.count,
            }
          : null,
        resourceIds: input.resourceIds,
        guestCount: input.guestCount ?? null,
      });
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person: booker,
        intent: this.intentOf(kind),
      });
      this.assertBookable(evaluation.result, booker.id);
      let existingBasketId: string | null = null;
      if (input.basketId) {
        const basket = await this.baskets.load(trx, organizationId, input.basketId, true);
        if (!basket || basket.owner_person_id !== booker.id) {
          throw errors.protectedNotFound('basket');
        }
        if (basket.status !== 'open') {
          throw errors.invalidTransition('Basket', basket.status, 'add_line');
        }
        if ((await this.baskets.lineRows(trx, organizationId, basket.id)).length > 0) {
          throw errors.resourceConflict('A booking is paid in a basket of its own.', {
            code: 'BASKET_NOT_EMPTY',
          });
        }
        existingBasketId = basket.id;
      }
      const id = newId();
      const base = {
        id,
        organization_id: organizationId,
        facility_id: snapshot.offering.facilityId,
        offering_id: snapshot.offering.id,
        kind,
        booker_person_id: booker.id,
        first_start: plan.occurrences[0]!.start,
        last_end: plan.occurrences[plan.occurrences.length - 1]!.end,
        occurrences: json(
          plan.occurrences.map((o) => ({ start: o.start.toISOString(), end: o.end.toISOString() })),
        ),
        recurrence: plan.recurrence ? json(plan.recurrence) : null,
        resource_ids: plan.resourceIds,
        equipment_asset_ids: plan.equipmentAssetIds,
        guest_count: plan.guestCount,
        booking_terms_policy_version_id: plan.terms.id,
        confirmation_mode: plan.content.confirmationMode,
        access_conditions: plan.content.accessConditions,
        host_responsibilities: plan.content.hostResponsibilities,
        staffing: json(plan.staffing as unknown as Array<Record<string, unknown>>),
        requested_by: json(actorSnapshot(principal)),
        requested_by_person_id: principal.personId,
      };
      if (plan.content.confirmationMode === 'request') {
        // DEC-029, POL-005: nothing is held before approval; the conflict check only informs.
        const conflicts = await this.conflictsOf(organizationId, plan);
        if (conflicts.length > 0) {
          throw errors.resourceConflict('The requested time is not free.', { conflicts });
        }
        await trx
          .insertInto('bookings')
          .values({ ...base, status: 'requested' })
          .execute();
        await this.exceptions.raise(trx, {
          organizationId,
          facilityId: snapshot.offering.facilityId,
          category: 'enrollment.booking_request_pending',
          severity: 'warning',
          title: `A ${kind} request awaits a decision`,
          affectedType: 'booking',
          affectedId: id,
          ownerQueue: 'scheduler',
          deadlineAt: plan.occurrences[0]!.start,
          dedupeKey: `booking_request:${id}`,
          details: { bookingId: id, offeringId: snapshot.offering.id, kind },
        });
      } else {
        const reserved = await this.reserve(
          trx,
          organizationId,
          id,
          plan,
          booker,
          evaluation,
          principal,
          existingBasketId,
          correlationId,
        );
        await trx
          .insertInto('bookings')
          .values({
            ...base,
            status: 'held',
            basket_id: reserved.basketId,
            basket_line_id: reserved.lineId,
            enrollment_id: reserved.enrollmentId,
            pool_id: reserved.poolId,
            scheduling_series_id: reserved.seriesId,
            scheduling_event_ids: reserved.eventIds,
          })
          .execute();
      }
      const row = (await this.load(trx, organizationId, id))!;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.requestBooking.id,
        targetType: 'booking',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: {
          kind,
          status: row.status,
          offeringId: snapshot.offering.id,
          occurrences: plan.occurrences.length,
          bookingTermsPolicyVersionId: plan.terms.id,
          eventIds: row.scheduling_event_ids,
        },
      });
      await this.changed(trx, row, correlationId);
      return this.view(trx, organizationId, row);
    });
  }

  // -------------------------------------------------------------------------------------------
  // POST /bookings/{id}/approve | decline | cancel
  // -------------------------------------------------------------------------------------------

  async approve(
    principal: Principal,
    id: string,
    input: ApproveBookingInput,
    correlationId: string | null,
  ): Promise<Booking> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('booking');
      await this.authorization.require(principal, EnrollmentActions.decideBooking, {
        type: 'booking',
        id,
        organizationId,
        facilityId: row.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = BookingMachine.next(row.status, 'approve');
      await this.capabilities.require(organizationId, capabilityOf(row.kind), trx);
      const snapshot = await this.evaluator.snapshot(trx, organizationId, row.offering_id);
      const terms = await this.policies.getPolicyVersion(
        organizationId,
        row.booking_terms_policy_version_id,
        trx,
      );
      const occurrences = row.occurrences as unknown as Array<{ start: string; end: string }>;
      const plan = await this.plan(trx, organizationId, snapshot, terms, {
        start: new Date(occurrences[0]!.start),
        end: row.kind === 'rental' ? new Date(occurrences[0]!.end) : null,
        recurrence: (row.recurrence as unknown as BookingPlan['recurrence']) ?? null,
        resourceIds: row.resource_ids,
        guestCount: row.guest_count,
      });
      const booker = await this.evaluator.participant(trx, organizationId, row.booker_person_id);
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person: booker,
        intent: this.intentOf(row.kind),
      });
      // A slot taken since the request answers RESOURCE_CONFLICT and the booking stays requested.
      const reserved = await this.reserve(
        trx,
        organizationId,
        id,
        plan,
        booker,
        evaluation,
        principal,
        null,
        correlationId,
      );
      await trx
        .updateTable('bookings')
        .set({
          status,
          basket_id: reserved.basketId,
          basket_line_id: reserved.lineId,
          enrollment_id: reserved.enrollmentId,
          pool_id: reserved.poolId,
          scheduling_series_id: reserved.seriesId,
          scheduling_event_ids: reserved.eventIds,
          decided_by: json(actorSnapshot(principal)),
          decided_by_person_id: principal.personId,
          decided_at: this.clock.now(),
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.settle(trx, organizationId, 'enrollment.booking_request_pending', id, 'approved');
      return this.finish(trx, principal, organizationId, row, 'approve', null, correlationId);
    });
  }

  async decline(
    principal: Principal,
    id: string,
    input: DeclineBookingInput,
    correlationId: string | null,
  ): Promise<Booking> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('booking');
      await this.authorization.require(principal, EnrollmentActions.decideBooking, {
        type: 'booking',
        id,
        organizationId,
        facilityId: row.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = BookingMachine.next(row.status, 'decline');
      const now = this.clock.now();
      await trx
        .updateTable('bookings')
        .set({
          status,
          decided_by: json(actorSnapshot(principal)),
          decided_by_person_id: principal.personId,
          decided_at: now,
          decision_reason: input.reason,
          ended_at: now,
          end_reason: input.reason,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.settle(trx, organizationId, 'enrollment.booking_request_pending', id, 'declined');
      return this.finish(
        trx,
        principal,
        organizationId,
        row,
        'decline',
        input.reason,
        correlationId,
      );
    });
  }

  async cancel(
    principal: Principal,
    id: string,
    input: CancelBookingInput,
    correlationId: string | null,
  ): Promise<Booking> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('booking');
      await this.authorization.require(principal, EnrollmentActions.requestBooking, {
        type: 'booking',
        id,
        organizationId,
        facilityId: row.facility_id,
        subjectPersonIds: [row.booker_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = BookingMachine.next(row.status, 'cancel');
      if (row.status === 'held' && row.basket_id) {
        // §4.11, SPK-PAY-007: a held booking ends as a hold only while its basket is still held.
        // While finance's checkout runs, money may be moving and finance owns the basket (as for
        // an enrollment cancel, EnrollmentsService.cancel); once the basket is fulfilled the
        // payment is taken and the enrollment confirmation moves the booking on, after which it
        // is cancelled with its previewed consequence. Refused before anything is written.
        const basket = await this.baskets.load(trx, organizationId, row.basket_id, true);
        if (basket?.status === 'checking_out') {
          throw errors.resourceConflict(
            'A checkout is in progress for this booking; cancel the checkout instead.',
            { code: 'CHECKOUT_IN_PROGRESS', orderRef: basket.order_ref },
          );
        }
        if (basket?.status === 'fulfilled') {
          throw errors.resourceConflict(
            'This booking is paid and being confirmed; cancel it once it is confirmed, with its consequence.',
            { code: 'BOOKING_CONFIRMATION_PENDING', orderRef: basket.order_ref },
          );
        }
      }
      const now = this.clock.now();
      // The booking's own state first, so the enrollment follow-up below finds it settled.
      await trx
        .updateTable('bookings')
        .set({ status, ended_at: now, end_reason: input.reason, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.releaseReservations(organizationId, row, input.reason, correlationId);
      if (row.status === 'held' && row.basket_id) {
        const basket = await this.baskets.load(trx, organizationId, row.basket_id, true);
        if (basket && basket.status === 'held') {
          await this.baskets.releaseInTrx(
            trx,
            organizationId,
            basket,
            input.reason,
            principal,
            correlationId,
            'released',
          );
        }
      } else if (
        (row.status === 'awaiting_staff' || row.status === 'confirmed') &&
        row.enrollment_id
      ) {
        // The paid booking ends through the enrollment cancellation, with the consequence the
        // caller previewed and accepted (ENR-03, DEC-009).
        const enrollment = await this.enrollments.load(trx, organizationId, row.enrollment_id);
        if (enrollment && enrollment.status === 'confirmed') {
          await this.enrollments.cancel(
            principal,
            row.enrollment_id,
            {
              reason: input.reason,
              expectedRevision: enrollment.revision,
              acceptedConsequence: input.acceptedConsequence,
            } as Parameters<EnrollmentsService['cancel']>[2],
            correlationId,
          );
        }
      }
      for (const category of [
        'enrollment.booking_request_pending',
        'enrollment.booking_awaiting_staff',
      ]) {
        await this.settle(trx, organizationId, category, id, 'canceled');
      }
      return this.finish(
        trx,
        principal,
        organizationId,
        row,
        'cancel',
        input.reason,
        correlationId,
      );
    });
  }

  /** Cancels the booking's future events and withdraws their staffing requirements. */
  private async releaseReservations(
    organizationId: string,
    row: BookingRow,
    reason: string,
    correlationId: string | null,
  ): Promise<void> {
    if (row.scheduling_event_ids.length === 0) return;
    const system = this.system(organizationId);
    const now = this.clock.now();
    if (row.scheduling_series_id) {
      await this.events.cancelEventSeries(system, row.scheduling_series_id, {
        reason,
        fromInstant: now.toISOString(),
        correlationId,
      });
    } else {
      for (const eventId of row.scheduling_event_ids) {
        const event = await this.events.getEvent(system, eventId);
        if (event.status === 'canceled' || new Date(event.scheduledStart) <= now) continue;
        await this.events.cancelEvent(system, eventId, { reason, correlationId });
      }
    }
    const staffing = row.staffing as unknown as StaffingRequirement[];
    if (staffing.length > 0) {
      for (const eventId of row.scheduling_event_ids) {
        await this.staffing.withdrawRequirements(system, {
          targetType: 'event',
          targetId: eventId,
          reason,
        });
      }
    }
  }

  /** Resolves the booking's open exception of `category`, if any. */
  private async settle(
    trx: Trx,
    organizationId: string,
    category: string,
    bookingId: string,
    outcome: string,
  ): Promise<void> {
    const open = await this.exceptions.list(
      organizationId,
      {
        category,
        affectedType: 'booking',
        affectedId: bookingId,
        statuses: ['open', 'acknowledged'],
      },
      trx,
    );
    for (const exception of open.items) {
      await this.exceptions.transition(trx, this.system(organizationId), exception.id, 'resolved', {
        reason: `booking ${outcome}`,
      });
    }
  }

  private async finish(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    before: BookingRow,
    event: BookingEvent,
    reason: string | null,
    correlationId: string | null,
  ): Promise<Booking> {
    const row = (await this.load(trx, organizationId, before.id))!;
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: `enrollment.${event}_booking`,
      targetType: 'booking',
      targetId: row.id,
      beforeRevision: before.revision,
      afterRevision: row.revision,
      reason,
      correlationId,
      details: { previousStatus: before.status, status: row.status },
    });
    await this.changed(trx, row, correlationId);
    return this.view(trx, organizationId, row);
  }

  private outstanding(row: BookingRow, covered: boolean | null): Booking['outstanding'] {
    switch (row.status) {
      case 'requested':
        return ['approval'];
      case 'held':
        return covered === false ? ['payment', 'staffing'] : ['payment'];
      case 'awaiting_staff':
        return ['staffing'];
      default:
        return [];
    }
  }

  private async changed(trx: Trx, row: BookingRow, correlationId: string | null): Promise<void> {
    const covered = row.status === 'held' ? await this.covered(trx, row) : null;
    await this.outbox.enqueue(trx, EnrollmentPackageGEvents.bookingChanged, {
      organizationId: row.organization_id,
      aggregateType: 'booking',
      aggregateId: row.id,
      correlationId,
      payload: {
        bookingId: row.id,
        kind: row.kind,
        status: row.status,
        outstanding: this.outstanding(row, covered),
        revision: row.revision,
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Staffing coverage and follow-ups (handlers)
  // -------------------------------------------------------------------------------------------

  /** Whether every mandatory staff slot of every event is held by an accepted assignee. */
  async covered(trx: Trx | undefined, row: BookingRow): Promise<boolean> {
    const staffing = row.staffing as unknown as StaffingRequirement[];
    if (staffing.length === 0) return true;
    for (const eventId of row.scheduling_event_ids) {
      const roles = await this.coverage.coverage(row.organization_id, 'event', eventId, trx);
      for (const requirement of staffing) {
        const role = roles.find((r) => r.role === requirement.role);
        if (!role || role.uncoveredSlots.length > 0) return false;
      }
    }
    return true;
  }

  private async transition(
    trx: Trx,
    row: BookingRow,
    event: BookingEvent,
    correlationId: string | null,
    extra: Partial<{ ended_at: Date; end_reason: string }> = {},
  ): Promise<BookingRow> {
    const status = BookingMachine.next(row.status, event);
    await trx
      .updateTable('bookings')
      .set({ status, ...extra, revision: row.revision + 1 })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    const after = (await this.load(trx, row.organization_id, row.id))!;
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: this.system(row.organization_id),
      action: `enrollment.booking_${event}`,
      targetType: 'booking',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: after.revision,
      reason: extra.end_reason ?? null,
      correlationId,
      details: { previousStatus: row.status, status },
    });
    await this.changed(trx, after, correlationId);
    return after;
  }

  private async raiseAwaitingStaff(trx: Trx, row: BookingRow): Promise<void> {
    await this.exceptions.raise(trx, {
      organizationId: row.organization_id,
      facilityId: row.facility_id,
      category: 'enrollment.booking_awaiting_staff',
      severity: 'high',
      title: `A paid ${row.kind} still needs its staff`,
      affectedType: 'booking',
      affectedId: row.id,
      ownerQueue: 'scheduler',
      deadlineAt: new Date(row.first_start),
      dedupeKey: `booking_awaiting_staff:${row.id}`,
      details: { bookingId: row.id, eventIds: row.scheduling_event_ids },
    });
  }

  /** enrollment.enrollment_confirmed of a booking's line: confirmed only when fully staffed. */
  async onEnrollmentConfirmed(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await trx
      .selectFrom('bookings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', enrollmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.status !== 'held') return;
    const covered = await this.covered(trx, row);
    const after = await this.transition(
      trx,
      row,
      covered ? 'pay_covered' : 'pay_uncovered',
      correlationId,
    );
    if (!covered) await this.raiseAwaitingStaff(trx, after);
  }

  /** enrollment.enrollment_canceled of a booking's enrollment (hold expiry or cancellation). */
  async onEnrollmentCanceled(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    reason: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await trx
      .selectFrom('bookings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', enrollmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || !['held', 'awaiting_staff', 'confirmed'].includes(row.status)) return;
    const event: BookingEvent =
      row.status === 'held' && reason === 'hold_expired' ? 'expire' : 'cancel';
    await this.transition(trx, row, event, correlationId, {
      ended_at: this.clock.now(),
      end_reason: reason,
    });
    await this.releaseReservations(organizationId, row, reason, correlationId);
    await this.settle(trx, organizationId, 'enrollment.booking_awaiting_staff', row.id, event);
  }

  /** workforce.assignment_changed on a booking event: re-evaluates staffing both ways. */
  async onAssignmentChanged(
    trx: Trx,
    organizationId: string,
    targetType: string,
    targetId: string,
    correlationId: string | null,
  ): Promise<void> {
    if (targetType !== 'event') return;
    const rows = await trx
      .selectFrom('bookings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where(sql<boolean>`scheduling_event_ids @> array[${targetId}]::uuid[]`)
      .where('status', 'in', ['awaiting_staff', 'confirmed'])
      .forUpdate()
      .execute();
    for (const row of rows) {
      const covered = await this.covered(trx, row);
      if (row.status === 'awaiting_staff' && covered) {
        await this.transition(trx, row, 'cover', correlationId);
        await this.settle(
          trx,
          organizationId,
          'enrollment.booking_awaiting_staff',
          row.id,
          'staffed',
        );
      } else if (row.status === 'confirmed' && !covered) {
        const after = await this.transition(trx, row, 'uncover', correlationId);
        await this.raiseAwaitingStaff(trx, after);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle job (enrollment.booking_lifecycle)
  // -------------------------------------------------------------------------------------------

  async lifecycleDue(now: Date, limit: number) {
    return this.db
      .selectFrom('bookings')
      .select(['id', 'organization_id'])
      .where((eb) =>
        eb.or([
          eb.and([eb('status', '=', 'requested'), eb('first_start', '<=', now)]),
          eb.and([eb('status', '=', 'awaiting_staff'), eb('first_start', '<=', now)]),
          eb.and([eb('status', 'in', ['confirmed', 'awaiting_staff']), eb('last_end', '<=', now)]),
        ]),
      )
      .orderBy('first_start')
      .orderBy('id')
      .limit(limit)
      .execute();
  }

  /** One row of the lifecycle job; returns whether anything changed. */
  async advance(trx: Trx, organizationId: string, id: string): Promise<boolean> {
    const row = await this.load(trx, organizationId, id, true);
    if (!row) return false;
    const now = this.clock.now();
    if (row.status === 'requested' && new Date(row.first_start) <= now) {
      await this.transition(trx, row, 'expire', null, { ended_at: now, end_reason: 'not_decided' });
      await this.settle(trx, organizationId, 'enrollment.booking_request_pending', id, 'expired');
      return true;
    }
    if (
      (row.status === 'confirmed' || row.status === 'awaiting_staff') &&
      new Date(row.last_end) <= now
    ) {
      await this.transition(trx, row, 'complete', null);
      await this.settle(trx, organizationId, 'enrollment.booking_awaiting_staff', id, 'completed');
      if (row.enrollment_id) {
        const enrollment = await this.enrollments.load(
          trx,
          organizationId,
          row.enrollment_id,
          true,
        );
        if (enrollment && enrollment.status === 'confirmed') {
          await this.enrollments.completeInTrx(
            trx,
            organizationId,
            enrollment,
            this.system(organizationId),
            'booking_completed',
            null,
          );
        }
      }
      return true;
    }
    if (row.status === 'awaiting_staff' && new Date(row.first_start) <= now) {
      const raised = await this.exceptions.raise(trx, {
        organizationId,
        facilityId: row.facility_id,
        category: 'enrollment.booking_started_unstaffed',
        severity: 'critical',
        title: `A ${row.kind} started without its staff`,
        affectedType: 'booking',
        affectedId: row.id,
        ownerQueue: 'scheduler',
        dedupeKey: `booking_started_unstaffed:${row.id}`,
        details: { bookingId: row.id, eventIds: row.scheduling_event_ids },
      });
      return !raised.deduplicated;
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async view(db: Reader, organizationId: string, row: BookingRow): Promise<Booking> {
    const trx = db === this.db ? undefined : (db as Trx);
    const snapshot = await this.offerings.getOffering(
      organizationId,
      row.offering_id,
      this.clock.now(),
      trx,
    );
    const zone = (await this.facilities.describe(organizationId, [row.facility_id], trx)).get(
      row.facility_id,
    )?.timezone;
    const names = new Map<string, string | null>();
    const system = this.system(organizationId);
    for (const resourceId of row.resource_ids) {
      names.set(resourceId, await this.resourceName(system, resourceId));
    }
    const occurrences = row.occurrences as unknown as Array<{ start: string; end: string }>;
    const eventsByStart = new Map<number, string>();
    for (const eventId of row.scheduling_event_ids) {
      try {
        const event = await this.events.getEvent(system, eventId);
        eventsByStart.set(new Date(event.scheduledStart).getTime(), event.id);
      } catch {
        // an event this booking no longer reaches reads as unreserved
      }
    }
    const covered = row.status === 'held' ? await this.covered(trx, row) : null;
    return {
      id: row.id,
      kind: row.kind,
      offeringId: row.offering_id,
      offeringName: snapshot?.offering.name ?? null,
      facilityId: row.facility_id,
      timezone: zone ?? null,
      bookerPersonId: row.booker_person_id,
      status: row.status,
      outstanding: this.outstanding(row, covered),
      firstStart: iso(row.first_start),
      lastEnd: iso(row.last_end),
      occurrences: occurrences.map((o) => ({
        start: iso(o.start),
        end: iso(o.end),
        eventId: eventsByStart.get(new Date(o.start).getTime()) ?? null,
        resources: row.resource_ids.map((id) => ({ id, name: names.get(id) ?? null })),
      })),
      guestCount: row.guest_count,
      equipmentAssetIds: row.equipment_asset_ids,
      terms: {
        policyVersionId: row.booking_terms_policy_version_id,
        confirmationMode: row.confirmation_mode,
        accessConditions: row.access_conditions,
        hostResponsibilities: row.host_responsibilities,
      },
      basketId: row.basket_id,
      enrollmentId: row.enrollment_id,
      decisionReason: row.decision_reason,
      endReason: row.end_reason,
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  /** The booker, or staff holding readBooking at its facility; anyone else learns nothing. */
  async get(principal: Principal, id: string): Promise<Booking> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('booking');
    const own = (await this.customers.selfIds(principal).catch(() => [] as string[])).includes(
      row.booker_person_id,
    );
    if (!own) {
      await this.authorization.require(principal, EnrollmentActions.readBooking, {
        type: 'booking',
        id,
        organizationId,
        facilityId: row.facility_id,
        protected: true,
      });
      if (!isStaffLike(principal)) throw errors.protectedNotFound('booking');
    }
    return this.view(this.db, organizationId, row);
  }

  async listMine(principal: Principal, query: ListMyBookingsQuery): Promise<Page<Booking>> {
    const organizationId = organizationOf(principal);
    const ids = await this.customers.selfIds(principal);
    return this.page(organizationId, query, { bookerIds: ids });
  }

  async list(principal: Principal, query: ListBookingsQuery): Promise<Page<Booking>> {
    const organizationId = organizationOf(principal);
    if (!isStaffLike(principal)) throw errors.accessDenied('Booking lists are a staff view.');
    await this.authorization.require(principal, EnrollmentActions.readBooking, {
      type: 'booking',
      organizationId,
      facilityId: query.facilityId,
    });
    const offerings = query.facilityId
      ? null
      : await this.scope.listOfferings(principal, EnrollmentActions.readBooking, organizationId);
    if (offerings?.length === 0) return { items: [], nextCursor: null };
    return this.page(organizationId, query, {
      facilityId: query.facilityId,
      offeringIds: offerings ?? undefined,
      status: query.status,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  private async page(
    organizationId: string,
    query: { limit: number; cursor?: string; status?: BookingRow['status'] },
    filter: {
      bookerIds?: readonly string[];
      facilityId?: string;
      offeringIds?: readonly string[];
      status?: BookingRow['status'];
      from?: Date;
      to?: Date;
    },
  ): Promise<Page<Booking>> {
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('bookings')
      .selectAll()
      .select(cursorAt('bookings').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (filter.bookerIds) q = q.where('booker_person_id', 'in', [...filter.bookerIds]);
    if (filter.facilityId) q = q.where('facility_id', '=', filter.facilityId);
    if (filter.offeringIds) q = q.where('offering_id', 'in', [...filter.offeringIds]);
    const status = filter.status ?? query.status;
    if (status) q = q.where('status', '=', status);
    if (filter.from) q = q.where('last_end', '>', filter.from);
    if (filter.to) q = q.where('first_start', '<', filter.to);
    if (cursor) q = q.where(beforeCursor('bookings', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: Booking[] = [];
    for (const row of page.rows) items.push(await this.view(this.db, organizationId, row));
    return { items, nextCursor: page.nextCursor };
  }

  /** BOOKING_QUERY_PORT (IF-36): bookings whose first occurrence lies in [from, to). */
  async bookingsOfPeriod(
    organizationId: string,
    query: { facilityId?: string; from: string; to: string; kinds?: readonly BookingKind[] },
    trx?: Trx,
  ): Promise<BookingOfPeriod[]> {
    let q = (trx ?? this.uow.reader())
      .selectFrom('bookings')
      .select(['id', 'kind', 'booker_person_id', 'status', 'first_start', 'offering_id'])
      .where('organization_id', '=', organizationId)
      .where('first_start', '>=', new Date(query.from))
      .where('first_start', '<', new Date(query.to))
      .orderBy('first_start')
      .orderBy('id');
    if (query.facilityId) q = q.where('facility_id', '=', query.facilityId);
    if (query.kinds && query.kinds.length > 0) q = q.where('kind', 'in', [...query.kinds]);
    return (await q.execute()).map((r) => ({
      bookingId: r.id,
      kind: r.kind,
      bookerPersonId: r.booker_person_id,
      status: r.status,
      firstStart: iso(r.first_start),
      offeringId: r.offering_id,
    }));
  }

  // -------------------------------------------------------------------------------------------
  // GET /offerings/{id}/booking-availability (never gated; no staff data)
  // -------------------------------------------------------------------------------------------

  async bookingAvailability(
    principal: Principal,
    offeringId: string,
    query: BookingAvailabilityQuery,
  ): Promise<BookingAvailability> {
    const organizationId = organizationOf(principal);
    const snapshot = await this.offerings.getOffering(organizationId, offeringId, this.clock.now());
    const kind = snapshot ? bookingKindOf(snapshot.offering.kind) : null;
    if (
      !snapshot ||
      !kind ||
      !['published', 'registration_open', 'registration_paused'].includes(
        snapshot.offering.publicationState,
      )
    ) {
      throw errors.protectedNotFound('offering');
    }
    const scope = bookingScope(snapshot, kind);
    if (!scope) throw errors.protectedNotFound('offering');
    const durationMinutes = isParty(scope) ? scope.durationMinutes : query.durationMinutes;
    if (!durationMinutes) {
      throw errors.validation('durationMinutes is required for a rental.', {
        path: 'durationMinutes',
      });
    }
    const content = bookingTermsContent(snapshot.bookingTerms);
    const system = this.system(organizationId);
    const resources: BookingAvailability['resources'] = [];
    for (const resourceId of scope.resources.resourceIds) {
      const name = await this.resourceName(system, resourceId);
      const free = await this.availability.findAvailableSlots(system, {
        resourceId,
        interval: { start: query.from, end: query.to },
        durationMinutes,
        setupMinutes: content?.setupMinutes,
        cleanupMinutes: content?.cleanupMinutes,
      });
      resources.push({
        resourceId,
        name,
        freeIntervals: free.map((f) => ({ start: iso(f.start), end: iso(f.end) })),
      });
    }
    return {
      offeringId,
      timezone: await this.zone(organizationId, snapshot.offering.facilityId),
      durationMinutes,
      resourceCount: scope.resources.count,
      resources,
    };
  }
}

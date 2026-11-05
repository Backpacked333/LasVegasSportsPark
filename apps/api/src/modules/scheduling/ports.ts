import type {
  AmbiguousTimePolicy,
  Closure,
  ClosureImpact,
  ClosureResolutionMode,
  ClosureSource,
  DraftChange,
  Event,
  EventKind,
  ImportProvenance,
  Interval,
  NonexistentTimePolicy,
  PartyCommitment,
  Principal,
  RecurrenceRule,
  Reservation,
} from '@sportspark/contracts';

/**
 * Ports other modules call (README "Ports"). Every method takes the acting principal and
 * authorizes against the real target; organization scope always comes from the principal.
 */

export interface CreateEventInput {
  facilityId: string;
  kind: EventKind;
  title: string;
  format?: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  /**
   * At least the largest default buffer among the requested resources (their turnover
   * requirement, SPK-SCHED-003); a larger value extends it, a smaller one is raised to it.
   */
  setupMinutes?: number;
  cleanupMinutes?: number;
  resourceIds: string[];
  commitments?: PartyCommitment[];
  /** The owning record (fixture, session, rental …) this event belongs to. */
  sourceType: string;
  sourceId: string;
  /** 'published' (default) reserves the space now; 'draft' holds nothing until a schedule draft publishes it (SPK-FIX-005). */
  status?: 'draft' | 'published';
  reason?: string;
  correlationId?: string | null;
}

export interface MoveEventInput {
  scheduledStart: string;
  scheduledEnd: string;
  resourceIds?: string[];
  /** Kept from the event while its resources stay the same; never below the reserved resources' requirement (SPK-SCHED-003). */
  setupMinutes?: number;
  cleanupMinutes?: number;
  expectedRevision?: number;
  reason?: string;
  correlationId?: string | null;
}

export interface CancelEventInput {
  expectedRevision?: number;
  reason: string;
  correlationId?: string | null;
}

/**
 * SCH-02, IF-31: a weekly series created through the port (bookings, recurring rentals). At most
 * 52 occurrences (`count <= 52`, or an `until` producing no more); `sourceType 'enrollment.booking'`
 * is for kinds `rental` and `party`.
 */
export interface CreateEventSeriesInput {
  kind: EventKind;
  title: string;
  facilityId: string;
  resourceIds: string[];
  /** Weekly recurrence (interval, byWeekday, startDate, count or until) in the facility zone. */
  recurrence: Omit<RecurrenceRule, 'frequency'> & { frequency: 'weekly' };
  /** `HH:MM` facility-local start time (SPK-SCHED-008). */
  localStartTime: string;
  durationMinutes: number;
  setupMinutes?: number;
  cleanupMinutes?: number;
  nonexistentPolicy?: NonexistentTimePolicy;
  ambiguousPolicy?: AmbiguousTimePolicy;
  commitments?: PartyCommitment[];
  sourceType: string;
  sourceId: string;
  correlationId?: string | null;
}

export interface EventSeriesCreated {
  seriesId: string;
  eventIds: string[];
}

export interface CancelEventSeriesInput {
  reason: string;
  /** Occurrences starting at or after this instant are canceled (default now). */
  fromInstant?: string;
  correlationId?: string | null;
}

/** SCH-04, IF-31/IF-40: an imported event, written as a draft with the batch's record id. */
export type ImportEventInput = CreateEventInput & { importProvenance: ImportProvenance };

/**
 * Conflicts are reported as RESOURCE_CONFLICT with `details.conflicts[]` naming the conflicting
 * event ids. Every method joins the caller's unit of work. Write methods except `importEvent`
 * assert RECORD_AUTHORITY_PORT 'future_schedule' for the facility (K-11, IF-42).
 */
export interface EventSchedulingPort {
  createEvent(principal: Principal, input: CreateEventInput): Promise<Event>;
  moveEvent(principal: Principal, eventId: string, input: MoveEventInput): Promise<Event>;
  cancelEvent(principal: Principal, eventId: string, input: CancelEventInput): Promise<Event>;
  getEvent(principal: Principal, eventId: string): Promise<Event>;
  /**
   * SCH-02, IF-31: every conflict first — RESOURCE_CONFLICT `{ conflicts: [{ occurrenceStart,
   * conflictingEventIds }] }` and nothing written — else every occurrence is reserved.
   */
  createEventSeries(
    principal: Principal,
    input: CreateEventSeriesInput,
  ): Promise<EventSeriesCreated>;
  /** SCH-02, IF-31: cancels the occurrences from `fromInstant`, one event_changed per occurrence. */
  cancelEventSeries(
    principal: Principal,
    seriesId: string,
    input: CancelEventSeriesInput,
  ): Promise<{ canceledEventIds: string[] }>;
  /**
   * SCH-04, IF-31/IF-40: create-if-absent draft (`id = recordId`, `source_type 'import'`,
   * `source_id = batchId`) for the migration import principal only (`assertImportPrincipal`); the
   * same record with different content is RESOURCE_CONFLICT `IMPORT_CONTENT_MISMATCH`, and an
   * event that conflicts with the current schedule is RESOURCE_CONFLICT `IMPORT_SCHEDULE_CONFLICT`
   * with nothing written. Never calls RECORD_AUTHORITY_PORT.
   */
  importEvent(principal: Principal, input: ImportEventInput): Promise<Event>;
}
export const EVENT_SCHEDULING_PORT = Symbol('EVENT_SCHEDULING_PORT');

export interface FindAvailableSlotsInput {
  resourceId: string;
  interval: Interval;
  durationMinutes: number;
  setupMinutes?: number;
  cleanupMinutes?: number;
  stepMinutes?: number;
}

export interface AvailabilityPort {
  /** Start/end pairs (scheduled interval, buffers excluded) at which the resource is free of reservations and closures. */
  findAvailableSlots(principal: Principal, input: FindAvailableSlotsInput): Promise<Interval[]>;
}
export const AVAILABILITY_PORT = Symbol('AVAILABILITY_PORT');

export interface PreviewClosureInput {
  facilityId: string;
  resourceId?: string | null;
  interval: Interval;
}

export interface CreateClosureInput extends PreviewClosureInput {
  reason: string;
  source?: ClosureSource;
  correlationId?: string | null;
}

export interface ApplyClosureInput {
  mode: ClosureResolutionMode;
  expectedRevision?: number;
  reason?: string;
  correlationId?: string | null;
}

export interface LiftClosureInput {
  expectedRevision?: number;
  reason?: string;
  correlationId?: string | null;
}

export interface WithdrawClosureInput {
  reason: string;
  expectedRevision?: number;
  correlationId?: string | null;
}

/** Used by the facilities module for restrictions (SPK-FAC-003/004/005). */
export interface ClosurePort {
  previewImpact(principal: Principal, input: PreviewClosureInput): Promise<ClosureImpact>;
  createClosure(principal: Principal, input: CreateClosureInput): Promise<Closure>;
  applyClosure(principal: Principal, closureId: string, input: ApplyClosureInput): Promise<Closure>;
  liftClosure(principal: Principal, closureId: string, input: LiftClosureInput): Promise<Closure>;
  /**
   * SCH-01, IF-11 (SPK-FAC-003): pending -> withdrawn (an active closure is INVALID_TRANSITION);
   * joins the caller's unit of work; allowed for source 'maintenance' (facilities withdraws the
   * closure of a withdrawn restriction).
   */
  withdrawClosure(
    principal: Principal,
    closureId: string,
    input: WithdrawClosureInput,
  ): Promise<Closure>;
}
export const CLOSURE_PORT = Symbol('CLOSURE_PORT');

export interface ReservationQuery {
  facilityId?: string;
  resourceId?: string;
  interval: Interval;
  includeReleased?: boolean;
}

/** Used by reporting and facilities. */
export interface ReservationQueryPort {
  listReservations(principal: Principal, query: ReservationQuery): Promise<Reservation[]>;
}
export const RESERVATION_QUERY_PORT = Symbol('RESERVATION_QUERY_PORT');

export interface FixtureObligation {
  code: string;
  message: string;
  owner: string;
  deadline: string | null;
  /** Blocking obligations fail the publication; others are recorded as remaining (SPK-FIX-002). */
  blocking: boolean;
}

export interface FixtureObligationCheck {
  organizationId: string;
  facilityId: string;
  draftId: string;
  changes: DraftChange[];
}

/**
 * Step 4 of publication (SPK-SCHED-006 "verify fixture obligations"). The competition module
 * registers its implementation under FIXTURE_OBLIGATION_IMPL; without one, no obligations exist.
 */
export interface FixtureObligationPort {
  verify(check: FixtureObligationCheck): Promise<FixtureObligation[]>;
}
export const FIXTURE_OBLIGATION_PORT = Symbol('FIXTURE_OBLIGATION_PORT');
export const FIXTURE_OBLIGATION_IMPL = Symbol('FIXTURE_OBLIGATION_IMPL');

export const noFixtureObligations: FixtureObligationPort = {
  verify: async () => [],
};

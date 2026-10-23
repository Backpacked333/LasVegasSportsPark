import type {
  Closure,
  ClosureImpact,
  ClosureResolutionMode,
  ClosureSource,
  DraftChange,
  Event,
  EventKind,
  Interval,
  PartyCommitment,
  Principal,
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
  /** Defaults to the largest default buffer among the requested resources. */
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

/** Conflicts are reported as RESOURCE_CONFLICT with `details.conflicts[]` naming the conflicting event ids. */
export interface EventSchedulingPort {
  createEvent(principal: Principal, input: CreateEventInput): Promise<Event>;
  moveEvent(principal: Principal, eventId: string, input: MoveEventInput): Promise<Event>;
  cancelEvent(principal: Principal, eventId: string, input: CancelEventInput): Promise<Event>;
  getEvent(principal: Principal, eventId: string): Promise<Event>;
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

/** Used by the facilities module for restrictions (SPK-FAC-003/004/005). */
export interface ClosurePort {
  previewImpact(principal: Principal, input: PreviewClosureInput): Promise<ClosureImpact>;
  createClosure(principal: Principal, input: CreateClosureInput): Promise<Closure>;
  applyClosure(principal: Principal, closureId: string, input: ApplyClosureInput): Promise<Closure>;
  liftClosure(principal: Principal, closureId: string, input: LiftClosureInput): Promise<Closure>;
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

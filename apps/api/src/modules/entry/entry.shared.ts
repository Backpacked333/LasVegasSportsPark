import { createHash, randomBytes } from 'node:crypto';
import {
  errors,
  type ActivityDetail,
  type ActorSnapshot,
  type ArrivalIssue,
  type AttendanceObservation,
  type Departure,
  type MyPass,
  type ObservedState,
  type OccupancySnapshot,
  type OfflineItemResult,
  type OfflineSyncBatch,
  type Pass,
  type Principal,
  type ReleaseRecord,
  type SessionCheckin,
  type Visit,
} from '@sportspark/contracts';
import type {
  AttendanceObservationsTable,
  DeparturesTable,
  OccupancySnapshotsTable,
  OfflineSyncBatchesTable,
  PassesTable,
  ReleaseRecordsTable,
  SessionCheckinsTable,
  VisitsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import { addDays, localDateOf, resolveLocal } from '../scheduling';

export type PassRow = Selectable<PassesTable>;
export type VisitRow = Selectable<VisitsTable>;
export type CheckinRow = Selectable<SessionCheckinsTable>;
export type ObservationRow = Selectable<AttendanceObservationsTable>;
export type DepartureRow = Selectable<DeparturesTable>;
export type ReleaseRow = Selectable<ReleaseRecordsTable>;
export type BatchRow = Selectable<OfflineSyncBatchesTable>;
export type SnapshotRow = Selectable<OccupancySnapshotsTable>;

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

export function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

export function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

// ---------------------------------------------------------------------------------------------
// Pass references (SPK-ENTRY-002): random, opaque, and stored only as a SHA-256 hash.
// ---------------------------------------------------------------------------------------------

export const PASS_REFERENCE_PREFIX = 'spp_';

/** 256 random bits; the reference carries no person, household or organization detail. */
export function newPassReference(): string {
  return `${PASS_REFERENCE_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashPassReference(reference: string): string {
  return createHash('sha256').update(reference.trim(), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Facility-local day (SPK-SCHED-008: facility-local behaviour derives from facilities.timezone)
// ---------------------------------------------------------------------------------------------

export interface DayWindow {
  date: string;
  start: Date;
  end: Date;
}

export function localDayWindow(timezone: string, at: Date, date?: string): DayWindow {
  const day = date ?? localDateOf(timezone, at);
  const start = resolveLocal(day, '00:00', timezone)?.instant;
  const end = resolveLocal(addDays(day, 1), '00:00', timezone)?.instant;
  if (!start || !end) throw errors.validation(`The date ${day} cannot be resolved in ${timezone}.`);
  return { date: day, start, end };
}

// ---------------------------------------------------------------------------------------------
// Attendance (SPK-ENTRY-005, §4.5): observations are never edited. A correction is a new row that
// names the observation it corrects; the current state of a person in an activity is the set of
// chain heads (observations nobody corrected). Heads that disagree on whether the person attended
// are a conflict kept for review (§4.15 "Reconnection must preserve conflicting observations").
// ---------------------------------------------------------------------------------------------

export interface ObservationLike {
  id: string;
  correctsObservationId: string | null;
  observedState: ObservedState;
  observedAt: Date;
  receivedAt: Date;
}

/** Present, late and left early all mean the person attended; absent means they did not. */
export function attended(state: ObservedState): boolean {
  return state !== 'absent';
}

export function statesConflict(a: ObservedState, b: ObservedState): boolean {
  return attended(a) !== attended(b);
}

export function currentHeads<T extends ObservationLike>(rows: readonly T[]): T[] {
  const corrected = new Set(
    rows.flatMap((r) => (r.correctsObservationId ? [r.correctsObservationId] : [])),
  );
  return rows.filter((r) => !corrected.has(r.id));
}

export function headsConflict(heads: readonly ObservationLike[]): boolean {
  return heads.some((a) => heads.some((b) => statesConflict(a.observedState, b.observedState)));
}

/** The single current state, or null when nothing is recorded or the heads conflict. */
export function effectiveState(heads: readonly ObservationLike[]): ObservedState | null {
  if (heads.length === 0 || headsConflict(heads)) return null;
  const latest = [...heads].sort(
    (a, b) =>
      b.observedAt.getTime() - a.observedAt.getTime() ||
      b.receivedAt.getTime() - a.receivedAt.getTime() ||
      (b.id < a.id ? -1 : 1),
  )[0];
  return latest ? latest.observedState : null;
}

/** Heads that a new observation of `state` would contradict (replacing `replaces` when correcting). */
export function contradictedHeads<T extends ObservationLike>(
  rows: readonly T[],
  state: ObservedState,
  replaces: string | null = null,
): T[] {
  return currentHeads(rows).filter(
    (head) => head.id !== replaces && statesConflict(head.observedState, state),
  );
}

export function observationLike(row: ObservationRow): ObservationLike {
  return {
    id: row.id,
    correctsObservationId: row.corrects_observation_id,
    observedState: row.observed_state,
    observedAt: new Date(row.observed_at),
    receivedAt: new Date(row.received_at),
  };
}

// ---------------------------------------------------------------------------------------------
// Row → contract mappers
// ---------------------------------------------------------------------------------------------

export function actorOf(value: unknown): ActorSnapshot {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    kind: typeof v['kind'] === 'string' ? v['kind'] : 'unknown',
    accountId: typeof v['accountId'] === 'string' ? v['accountId'] : null,
    personId: typeof v['personId'] === 'string' ? v['personId'] : null,
    staffRoles: Array.isArray(v['staffRoles']) ? (v['staffRoles'] as string[]) : [],
    sessionId: typeof v['sessionId'] === 'string' ? v['sessionId'] : null,
    actorLabel: typeof v['actorLabel'] === 'string' ? v['actorLabel'] : 'unknown',
  };
}

/**
 * Who a read is for (§4.14 field-level authorization). `staff` is a principal whose authority is
 * a staff role in scope (or the system); `customer` is anyone reading through a relationship or
 * as themselves, who receives a minimized projection: no staff account, person, role or session
 * identifiers, no device or batch identifiers, and (for a release) no staff notes, denial
 * details, other adults' permissions or exception id.
 */
export type ReadAudience = 'staff' | 'customer';

/** The audience of an allowed authorization decision: only a staff role (or the system) is staff. */
export function audienceOf(basis: string | undefined): ReadAudience {
  return basis === 'staff role' || basis === 'system' ? 'staff' : 'customer';
}

/** A recorded actor as a customer may see it: the kind and a generic label, no identifiers. */
export function customerActor(value: unknown): ActorSnapshot {
  const actor = actorOf(value);
  return {
    kind: actor.kind,
    accountId: null,
    personId: null,
    staffRoles: [],
    sessionId: null,
    actorLabel: actor.kind === 'staff' || actor.kind === 'system' ? actor.kind : actor.actorLabel,
  };
}

interface ActivityColumns {
  activity_type: 'session' | 'event';
  activity_id: string;
  offering_id: string | null;
  offering_session_id: string | null;
  scheduling_event_id: string | null;
}

export function activityDetailOf(row: ActivityColumns): ActivityDetail {
  return {
    type: row.activity_type,
    id: row.activity_id,
    offeringId: row.offering_id,
    sessionId: row.offering_session_id,
    eventId: row.scheduling_event_id,
  };
}

export function toPass(row: PassRow): Pass {
  return {
    id: row.id,
    holderKind: row.holder_kind,
    holderPersonId: row.holder_person_id,
    holderHouseholdId: row.holder_household_id,
    status: row.status,
    issuedAt: iso(row.issued_at),
    revokedAt: isoOrNull(row.revoked_at),
    revokedReason: row.revoked_reason,
    revision: row.revision,
  };
}

/**
 * A pass as its holder reads it (ENT-01, §4.14): never the reference (only its hash is stored, so
 * it cannot be shown again); the staff revocation reason only to a staff audience.
 */
export function toMyPass(row: PassRow, audience: ReadAudience): MyPass {
  return {
    id: row.id,
    holderKind: row.holder_kind,
    holderPersonId: row.holder_person_id,
    status: row.status,
    issuedAt: iso(row.issued_at),
    revokedAt: isoOrNull(row.revoked_at),
    revokedReason: audience === 'staff' ? row.revoked_reason : null,
    referenceAvailable: false,
    revision: row.revision,
  };
}

export function toVisit(row: VisitRow): Visit {
  return {
    id: row.id,
    facilityId: row.facility_id,
    personId: row.person_id,
    visitorDescription: row.visitor_description,
    partySize: row.party_size,
    visitorCategory: row.visitor_category,
    arrivedAt: iso(row.arrived_at),
    passId: row.pass_id,
    source: row.source,
    accessDeviceId: row.access_device_id,
    status: row.status,
    departedAt: isoOrNull(row.departed_at),
    voidedAt: isoOrNull(row.voided_at),
    voidReason: row.void_reason,
    recordedBy: actorOf(row.recorded_by),
    revision: row.revision,
  };
}

/**
 * Who reads a check-in (AUTHZ-PRIVACY-01): `staff` (desk and support roles, or the system, through
 * `entry.check_in` / `entry.read_checkin`), `assigned` (a coach or official through their accepted
 * assignment, `entry.check_in_assigned` / `entry.read_assigned_checkin`), or `customer` (a holder
 * of `view` over the person).
 */
export type CheckinAudience = ReadAudience | 'assigned';

/** What a reader without finance authority sees instead of a blocking balance issue. */
const DESK_REVIEW_REQUIRED: ArrivalIssue = {
  code: 'desk_review_required',
  severity: 'blocking',
  message: 'This participant is held until the front desk reviews the arrival.',
  nextAction: 'see_the_desk',
  reference: null,
};

/**
 * The recorded arrival issues as the audience may see them (SPK-UX-007 "relevant participant
 * information", §4.14 least privilege and field-level authorization). The balance issues come from
 * finance's standing, which covers every obligation the person owes, is the responsible payer of,
 * or is a participant on, so they can name another adult's unpaid order. Only staff see them, with
 * the obligation; the assigned coach or official and a customer never learn of a balance: an
 * informational or warning balance issue (and an unknown standing) is left out, and a blocking one
 * becomes the neutral `desk_review_required` with no reference. A customer's own balances are
 * finance's reads (which check debtor and payer authority), not entry's.
 */
export function issuesFor(
  issues: readonly ArrivalIssue[],
  audience: CheckinAudience,
): ArrivalIssue[] {
  if (audience === 'staff') return [...issues];
  const visible: ArrivalIssue[] = [];
  for (const issue of issues) {
    if (issue.code === 'outstanding_balance' || issue.code === 'balance_unknown') {
      if (issue.severity === 'blocking') visible.push({ ...DESK_REVIEW_REQUIRED });
      continue;
    }
    visible.push(issue);
  }
  return visible;
}

export function toCheckin(row: CheckinRow, audience: CheckinAudience): SessionCheckin {
  const basisId =
    row.basis_kind === 'enrollment'
      ? row.enrollment_id
      : row.basis_kind === 'session_booking'
        ? row.session_booking_id
        : row.basis_reference;
  return {
    id: row.id,
    facilityId: row.facility_id,
    visitId: row.visit_id,
    personId: row.person_id,
    activity: activityDetailOf(row),
    activityStart: iso(row.activity_start),
    activityEnd: iso(row.activity_end),
    basis: row.basis_kind ? { kind: row.basis_kind, id: basisId } : null,
    status: row.status,
    issues: issuesFor(row.issues as ArrivalIssue[], audience),
    checkedInAt: iso(row.checked_in_at),
    evaluatedAt: iso(row.evaluated_at),
    admittedAt: isoOrNull(row.admitted_at),
    withdrawnAt: isoOrNull(row.withdrawn_at),
    withdrawnReason: row.withdrawn_reason,
    recordedBy: audience === 'customer' ? customerActor(row.recorded_by) : actorOf(row.recorded_by),
    revision: row.revision,
  };
}

export function toObservation(
  row: ObservationRow,
  audience: ReadAudience = 'staff',
): AttendanceObservation {
  const staff = audience === 'staff';
  return {
    id: row.id,
    facilityId: row.facility_id,
    personId: row.person_id,
    activity: activityDetailOf(row),
    observedState: row.observed_state,
    observedAt: iso(row.observed_at),
    receivedAt: iso(row.received_at),
    source: row.source,
    deviceId: staff ? row.device_id : null,
    clientObservationId: staff ? row.client_observation_id : null,
    syncBatchId: staff ? row.sync_batch_id : null,
    snapshotReference: staff ? row.snapshot_reference : null,
    snapshotTakenAt: staff ? isoOrNull(row.snapshot_taken_at) : null,
    flags: [...row.flags],
    correctsObservationId: row.corrects_observation_id,
    correctionReason: row.correction_reason,
    recordedBy: staff ? actorOf(row.recorded_by) : customerActor(row.recorded_by),
  };
}

export function toDeparture(row: DepartureRow): Departure {
  return {
    id: row.id,
    facilityId: row.facility_id,
    visitId: row.visit_id,
    personId: row.person_id,
    departedAt: iso(row.departed_at),
    releaseRecordId: row.release_record_id,
    source: row.source,
    recordedBy: actorOf(row.recorded_by),
    receivedAt: iso(row.received_at),
  };
}

export function toRelease(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    facilityId: row.facility_id,
    childPersonId: row.child_person_id,
    collectorPersonId: row.collector_person_id,
    collectorDescription: row.collector_description,
    activity:
      row.activity_type && row.activity_id
        ? activityDetailOf({
            activity_type: row.activity_type,
            activity_id: row.activity_id,
            offering_id: row.offering_id,
            offering_session_id: row.offering_session_id,
            scheduling_event_id: row.scheduling_event_id,
          })
        : null,
    visitId: row.visit_id,
    verificationMethod: row.verification_method,
    verificationOutcome: row.verification_outcome,
    authorityBasis: row.authority_basis,
    authorityGrantId: row.authority_grant_id,
    authorityCheckedAt: iso(row.authority_checked_at),
    collectorPermissions: [...row.collector_permissions],
    denialReason: row.denial_reason,
    restrictionNotes: row.restriction_notes,
    escalationNotes: row.escalation_notes,
    escalationExceptionId: row.escalation_exception_id,
    manualProcedureReference: row.manual_procedure_reference,
    postSyncAuthority: row.post_sync_authority,
    outcome: row.outcome,
    decidedAt: iso(row.decided_at),
    releasedAt: isoOrNull(row.released_at),
    staffActor: actorOf(row.staff_actor),
    source: row.source,
    receivedAt: iso(row.received_at),
  };
}

/**
 * A release record as a customer (a holder of `view` over the child) may read it (§4.14
 * field-level authorization, SPK-IAM-005 restricted review workflow): who collected the child,
 * when, from which activity, and the outcome. Staff restriction and escalation notes, the denial
 * details, the permissions any adult holds, the exception, the outage procedure and the staff
 * actor's identifiers are withheld; pickup staff read the full record.
 */
export function toCustomerRelease(row: ReleaseRow): ReleaseRecord {
  return {
    ...toRelease(row),
    authorityGrantId: null,
    collectorPermissions: [],
    denialReason: null,
    restrictionNotes: null,
    escalationNotes: null,
    escalationExceptionId: null,
    manualProcedureReference: null,
    postSyncAuthority: null,
    staffActor: customerActor(row.staff_actor),
  };
}

export function toOccupancySnapshot(row: SnapshotRow): OccupancySnapshot {
  return {
    id: row.id,
    facilityId: row.facility_id,
    takenAt: iso(row.taken_at),
    window: { start: iso(row.window_start), end: iso(row.window_end) },
    arrivals: row.arrivals,
    departures: row.departures,
    recordedOnSite: row.recorded_on_site,
    openFromEarlierDays: row.open_from_earlier_days,
    reconciled: row.reconciled,
    countedOnSite: row.counted_on_site,
    verifiedOccupancy: row.verified_occupancy,
    discrepancy: row.discrepancy,
    reconciliationNote: row.reconciliation_note,
    takenBy: actorOf(row.taken_by),
  };
}

export function toBatch(row: BatchRow, replayed: boolean): OfflineSyncBatch {
  return {
    id: row.id,
    facilityId: row.facility_id,
    deviceId: row.device_id,
    clientBatchId: row.client_batch_id,
    snapshot: { reference: row.snapshot_reference, takenAt: iso(row.snapshot_taken_at) },
    receivedAt: iso(row.received_at),
    snapshotAgeSeconds: row.snapshot_age_seconds,
    maxRosterAgeMinutes: row.max_roster_age_minutes,
    stale: row.stale,
    counts: {
      items: row.item_count,
      accepted: row.accepted_count,
      acceptedWithConflict: row.conflict_count,
      duplicate: row.duplicate_count,
      rejected: row.rejected_count,
      stale: row.stale_count,
    },
    items: row.results as OfflineItemResult[],
    exceptionIds: [...row.exception_ids],
    operationId: row.operation_id,
    replayed,
  };
}

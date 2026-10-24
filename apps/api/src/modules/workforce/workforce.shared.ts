import {
  errors,
  RateBasisSchema,
  type ActorSnapshot,
  type Assignment,
  type AssignmentStatus,
  type AvailabilityWindow,
  type FeeAdjustment,
  type FeeExportBatch,
  type FeeExportLine,
  type FeeSubmission,
  type Principal,
  type Qualification,
  type RateBasis,
} from '@sportspark/contracts';
import type {
  AssignmentRequirementsTable,
  AssignmentsTable,
  AvailabilityTable,
  FeeAdjustmentsTable,
  FeeExportBatchesTable,
  FeeSubmissionsTable,
  QualificationsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';

export type AssignmentRow = Selectable<AssignmentsTable>;
export type RequirementRow = Selectable<AssignmentRequirementsTable>;
export type AvailabilityRow = Selectable<AvailabilityTable>;
export type QualificationRow = Selectable<QualificationsTable>;
export type FeeSubmissionRow = Selectable<FeeSubmissionsTable>;
export type FeeAdjustmentRow = Selectable<FeeAdjustmentsTable>;
export type FeeExportBatchRow = Selectable<FeeExportBatchesTable>;

/** Assignments still holding or seeking the slot. */
export const LIVE_STATUSES: readonly AssignmentStatus[] = ['proposed', 'offered', 'accepted'];
/** Assignments that satisfy a required-acceptance check (SPK-STAFF-002: proposed never does). */
export const COVERING_STATUSES: readonly AssignmentStatus[] = ['accepted', 'completed'];

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

export function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 3_600_000);
}

/** Half-open interval overlap: [aStart, aEnd) and [bStart, bEnd). */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * The amount the rate basis yields (SPK-STAFF-006). Hourly rates are per hour in minor units;
 * the result rounds half up to whole minor units so the computation is deterministic.
 */
export function computeFeeAmount(basis: RateBasis): number {
  switch (basis.kind) {
    case 'per_assignment':
      return basis.rateMinor;
    case 'hourly':
      return Math.round((basis.rateMinor * basis.minutes) / 60);
    case 'flat':
      return basis.amountMinor;
  }
}

export function actorView(value: unknown): ActorSnapshot {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    kind: typeof v['kind'] === 'string' ? v['kind'] : 'unknown',
    accountId: typeof v['accountId'] === 'string' ? v['accountId'] : null,
    personId: typeof v['personId'] === 'string' ? v['personId'] : null,
    staffRoles: Array.isArray(v['staffRoles']) ? (v['staffRoles'] as string[]) : undefined,
    sessionId: typeof v['sessionId'] === 'string' ? v['sessionId'] : null,
    actorLabel: typeof v['actorLabel'] === 'string' ? v['actorLabel'] : 'unknown',
  };
}

export function accessActive(row: AssignmentRow, now: Date): boolean {
  return (
    row.access_status === 'granted' &&
    row.access_from !== null &&
    row.access_until !== null &&
    new Date(row.access_from).getTime() <= now.getTime() &&
    now.getTime() < new Date(row.access_until).getTime()
  );
}

export function toAssignment(row: AssignmentRow, now: Date): Assignment {
  return {
    id: row.id,
    facilityId: row.facility_id,
    personId: row.person_id,
    kind: row.kind,
    targetType: row.target_type,
    targetId: row.target_id,
    offeringId: row.offering_id,
    schedulingEventId: row.scheduling_event_id,
    targetTitle: row.target_title,
    role: row.role,
    slot: row.slot,
    engagement: row.engagement,
    status: row.status,
    scheduledStart: iso(row.scheduled_start),
    scheduledEnd: iso(row.scheduled_end),
    turnaroundMinutes: row.turnaround_minutes,
    committedUntil: iso(row.committed_end),
    replacesAssignmentId: row.replaces_assignment_id,
    offeredAt: isoOrNull(row.offered_at),
    respondedAt: isoOrNull(row.responded_at),
    acceptedAt: isoOrNull(row.accepted_at),
    declinedAt: isoOrNull(row.declined_at),
    declineReason: row.decline_reason,
    withdrawnAt: isoOrNull(row.withdrawn_at),
    withdrawnReason: row.withdrawn_reason,
    completedAt: isoOrNull(row.completed_at),
    access: {
      status: row.access_status,
      staffMembershipId: row.access_membership_id,
      from: isoOrNull(row.access_from),
      until: isoOrNull(row.access_until),
      active: accessActive(row, now),
    },
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toAvailability(row: AvailabilityRow): AvailabilityWindow {
  return {
    id: row.id,
    personId: row.person_id,
    interval: { start: iso(row.starts_at), end: iso(row.ends_at) },
    kind: row.kind,
    note: row.note,
    status: row.status,
    withdrawnAt: isoOrNull(row.withdrawn_at),
    withdrawnReason: row.withdrawn_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toQualification(row: QualificationRow): Qualification {
  return {
    id: row.id,
    personId: row.person_id,
    kind: row.kind,
    level: row.level,
    evidenceReference: row.evidence_reference,
    validFrom: iso(row.valid_from),
    validTo: isoOrNull(row.valid_to),
    status: row.status,
    verifiedAt: isoOrNull(row.verified_at),
    verifiedBy: row.verified_by ? actorView(row.verified_by) : null,
    statusReason: row.status_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

/** A verified qualification whose validity window contains the instant. */
export function qualificationHoldsAt(row: QualificationRow, at: Date): boolean {
  return (
    row.status === 'verified' &&
    new Date(row.valid_from).getTime() <= at.getTime() &&
    (row.valid_to === null || at.getTime() < new Date(row.valid_to).getTime())
  );
}

export function toFeeAdjustment(row: FeeAdjustmentRow): FeeAdjustment {
  return {
    id: row.id,
    sequence: row.sequence,
    previousAmountMinor: row.previous_amount_minor,
    adjustedAmountMinor: row.adjusted_amount_minor,
    currency: row.currency,
    reason: row.reason,
    adjustedBy: actorView(row.adjusted_by),
    adjustedAt: iso(row.adjusted_at),
  };
}

export function toFeeSubmission(
  row: FeeSubmissionRow,
  adjustments: FeeAdjustmentRow[],
): FeeSubmission {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    personId: row.person_id,
    rateBasis: RateBasisSchema.parse(row.rate_basis),
    computedAmountMinor: row.computed_amount_minor,
    submittedAmountMinor: row.submitted_amount_minor,
    currency: row.currency,
    note: row.note,
    status: row.status,
    submittedAt: iso(row.submitted_at),
    approvedAmountMinor: row.approved_amount_minor,
    approver: row.approver ? actorView(row.approver) : null,
    approvedAt: isoOrNull(row.approved_at),
    rejectedAt: isoOrNull(row.rejected_at),
    rejectionReason: row.rejection_reason,
    exportBatchId: row.export_batch_id,
    exportedAt: isoOrNull(row.exported_at),
    adjustments: adjustments
      .filter((a) => a.fee_submission_id === row.id)
      .sort((a, b) => a.sequence - b.sequence)
      .map(toFeeAdjustment),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toFeeExportBatch(row: FeeExportBatchRow): FeeExportBatch {
  return {
    id: row.id,
    currency: row.currency,
    submissionCount: row.submission_count,
    totalMinor: row.total_minor,
    lines: row.lines as unknown as FeeExportLine[],
    note: row.note,
    createdBy: actorView(row.created_by),
    operationId: row.operation_id,
    createdAt: iso(row.created_at),
  };
}

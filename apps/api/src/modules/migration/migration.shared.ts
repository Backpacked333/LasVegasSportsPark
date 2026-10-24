import {
  errors,
  systemPrincipal,
  type ActorSnapshot,
  type AuthorityAssignment,
  type AuthorityScope,
  type ExternalMapping,
  type ImportBatch,
  type ImportException,
  type ImportExceptionResolution,
  type ImportReason,
  type ImportRow,
  type OutcomeCounts,
  type Principal,
} from '@sportspark/contracts';
import type {
  AuthorityAssignmentsTable,
  Db,
  ExternalMappingsTable,
  ImportBatchesTable,
  ImportExceptionsTable,
  ImportRowOutcome,
  ImportRowsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { Trx } from '../../kernel';

export type Reader = Db | Trx;
export type BatchRow = Selectable<ImportBatchesTable>;
export type RowRow = Selectable<ImportRowsTable>;
export type MappingRow = Selectable<ExternalMappingsTable>;
export type ExceptionRow = Selectable<ImportExceptionsTable>;
export type AssignmentRow = Selectable<AuthorityAssignmentsTable>;

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

/** The principal the owning modules see during an apply: system, labelled with the batch (§4.9). */
export function importPrincipal(organizationId: string, batchId: string): Principal {
  return systemPrincipal(organizationId, `migration.import:${batchId}`);
}

/**
 * Correlation id passed to the owning module for one mapping. The owning module writes it on
 * the audit record of the creation in the same transaction as the record itself, which is how
 * an interrupted apply finds a record it already created instead of creating it twice.
 */
export function applyCorrelationId(mappingId: string): string {
  return `migration:${mappingId}`;
}

export function reason(code: string, message: string, details?: unknown): ImportReason {
  return details === undefined ? { code, message } : { code, message, details };
}

export const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null => (value ? iso(value) : null);

export function emptyCounts(): OutcomeCounts {
  return { created: 0, matched: 0, updated: 0, skipped: 0, exception: 0 };
}

export function countOutcomes(outcomes: Iterable<ImportRowOutcome | null>): OutcomeCounts {
  const counts = emptyCounts();
  for (const outcome of outcomes) if (outcome) counts[outcome] += 1;
  return counts;
}

function actorOf(value: unknown): ActorSnapshot {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    kind: String(v['kind'] ?? 'unknown'),
    accountId: (v['accountId'] as string | null | undefined) ?? null,
    personId: (v['personId'] as string | null | undefined) ?? null,
    staffRoles: Array.isArray(v['staffRoles']) ? (v['staffRoles'] as string[]) : [],
    sessionId: (v['sessionId'] as string | null | undefined) ?? null,
    actorLabel: String(v['actorLabel'] ?? 'unknown'),
  };
}

export interface BatchViewExtras {
  exceptions: { open: number; decided: number; withdrawn: number };
  sameChecksumBatchIds: string[];
}

export function toImportBatch(row: BatchRow, extras: BatchViewExtras): ImportBatch {
  const planned = row.planned_counts as Partial<OutcomeCounts>;
  const hasPlan = typeof planned.created === 'number';
  return {
    id: row.id,
    sourceSystem: row.source_system,
    snapshotTakenAt: iso(row.snapshot_taken_at),
    receivedAt: iso(row.received_at),
    transformationVersion: row.transformation_version,
    declaredChecksum: row.declared_checksum,
    declaredRowCount: row.declared_row_count,
    checksum: row.checksum,
    rowCount: row.row_count,
    status: row.status,
    extraction: row.extraction,
    controlTotals: row.control_totals,
    plannedCounts: hasPlan ? { ...emptyCounts(), ...planned } : null,
    outcomeCounts: {
      created: row.created_count,
      matched: row.matched_count,
      updated: row.updated_count,
      skipped: row.skipped_count,
      exception: row.exception_count,
    },
    validationSummary: row.validation_summary,
    exceptions: extras.exceptions,
    sameChecksumBatchIds: extras.sameChecksumBatchIds,
    validatedAt: isoOrNull(row.validated_at),
    reviewedAt: isoOrNull(row.reviewed_at),
    applyStartedAt: isoOrNull(row.apply_started_at),
    appliedAt: isoOrNull(row.applied_at),
    appliedOperationId: row.applied_operation_id,
    abortedAt: isoOrNull(row.aborted_at),
    abortReason: row.abort_reason,
    submittedBy: actorOf(row.submitted_by),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toImportRow(row: RowRow, internalId: string | null): ImportRow {
  return {
    id: row.id,
    batchId: row.batch_id,
    sequence: row.sequence,
    entityType: row.entity_type,
    externalId: row.external_id,
    payload: row.payload,
    payloadHash: row.payload_hash,
    plannedOutcome: row.planned_outcome,
    outcome: row.outcome,
    mappingId: row.mapping_id,
    internalId,
    reasons: (row.reasons as ImportReason[]) ?? [],
    appliedAt: isoOrNull(row.applied_at),
  };
}

export function toImportException(
  row: ExceptionRow,
  staged: { entityType: ImportRow['entityType']; externalId: string },
): ImportException {
  return {
    id: row.id,
    batchId: row.batch_id,
    rowId: row.row_id,
    entityType: staged.entityType,
    externalId: staged.externalId,
    kind: row.kind,
    phase: row.phase,
    reasons: row.reasons as ImportReason[],
    reviewOwnerRole: row.review_owner_role as ImportException['reviewOwnerRole'],
    status: row.status,
    decision: row.decision,
    resolution: (row.resolution as ImportExceptionResolution | null) ?? null,
    decisionReason: row.decision_reason,
    decidedBy: row.decided_by ? actorOf(row.decided_by) : null,
    decidedAt: isoOrNull(row.decided_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toExternalMapping(row: MappingRow): ExternalMapping {
  return {
    id: row.id,
    sourceSystem: row.source_system,
    entityType: row.entity_type,
    externalId: row.external_id,
    status: row.status,
    internalId: row.internal_id,
    firstSeenBatchId: row.first_seen_batch_id,
    lastSeenBatchId: row.last_seen_batch_id,
    provenance: row.provenance,
    linkedAt: isoOrNull(row.linked_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function scopeOf(row: AssignmentRow): AuthorityScope {
  switch (row.scope_kind) {
    case 'facility':
      return { kind: 'facility', facilityId: row.facility_id as string };
    case 'program':
      return { kind: 'program', programId: row.program_id as string };
    case 'competition':
      return { kind: 'competition', competitionId: row.competition_id as string };
    default:
      return { kind: 'organization' };
  }
}

export function toAuthorityAssignment(row: AssignmentRow): AuthorityAssignment {
  return {
    id: row.id,
    recordCategory: row.record_category,
    scope: scopeOf(row),
    authoritativeSystem: row.authoritative_system,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    reason: row.reason,
    policyReferences: row.policy_references,
    approvedBy: actorOf(row.approved_by),
    supersedesAssignmentId: row.supersedes_assignment_id,
    endedAt: isoOrNull(row.ended_at),
    endReason: row.end_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

/** The typed mapping column of an entity type (exactly one per mapped type, migration 1200). */
export const MAPPING_COLUMN = {
  person: 'person_id',
  household: 'household_id',
  relationship_evidence: 'relationship_id',
  program: 'program_id',
  open_obligation: 'obligation_id',
  credit: 'credit_id',
} as const;

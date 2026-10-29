import {
  decodeCursor,
  encodeCursor,
  errors,
  systemPrincipal,
  z,
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
import { sql, type RawBuilder, type Selectable } from 'kysely';
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

// ---------------------------------------------------------------------------------------------
// Keyset paging (MIG-01): created_at desc, id desc
// ---------------------------------------------------------------------------------------------

const KeysetCursorSchema = z.object({
  /** created_at at full (microsecond) precision, UTC: `2027-01-16T17:00:00.123456Z`. */
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  id: z.uuid(),
});
export type KeysetCursor = z.infer<typeof KeysetCursorSchema>;

/** The decoded cursor, null without one; an unreadable cursor is VALIDATION_FAILED. */
export function readKeysetCursor(cursor: string | undefined): KeysetCursor | null {
  const parsed = decodeCursor(cursor, KeysetCursorSchema);
  if (cursor && !parsed) throw errors.validation('The cursor is not valid.', { path: 'cursor' });
  return parsed;
}

/**
 * `created_at` as UTC text with microseconds, selected next to each row so the next cursor is
 * exact (a JavaScript Date keeps milliseconds only, which would skip rows created in the same
 * millisecond).
 */
export function createdAtText(column: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Rows strictly after the cursor in (created_at desc, id desc) order. */
export function afterKeyset(
  createdAt: string,
  id: string,
  cursor: KeysetCursor,
): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(createdAt)}, ${sql.ref(id)}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
}

/** The page of `limit` rows (the query read `limit + 1`) and the cursor after its last row. */
export function keysetPage<T extends { id: string; created_at_text: string }>(
  rows: readonly T[],
  limit: number,
): { rows: T[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor:
      rows.length > limit && last ? encodeCursor({ at: last.created_at_text, id: last.id }) : null,
  };
}

export interface BatchViewExtras {
  exceptions: { open: number; decided: number; withdrawn: number };
  sameChecksumBatchIds: string[];
  /** MIG-01 (§5.5): the batch's most recent reconciliation report, null until one exists. */
  latestReconciliationReportId: string | null;
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
    latestReconciliationReportId: extras.latestReconciliationReportId,
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

/** Entity types whose staged row states a money balance (amount in minor units + currency). */
const BALANCE_TYPES: ReadonlySet<ImportRow['entityType']> = new Set([
  'open_obligation',
  'credit',
  'refund',
]);

/**
 * MIG-01 (§5.5 "do not net", SPK-PAY-001): the staged amount and its currency when the exception
 * concerns a balance, read from the staged row as the source stated it; null otherwise (and when
 * the row does not state both, e.g. a validation error on the amount itself).
 */
export function stagedBalanceOf(
  entityType: ImportRow['entityType'],
  payload: unknown,
): { stagedAmountMinor: number | null; currency: string | null } {
  const none = { stagedAmountMinor: null, currency: null };
  if (!BALANCE_TYPES.has(entityType) || !payload || typeof payload !== 'object') return none;
  const p = payload as Record<string, unknown>;
  const raw = p['amountMinor'];
  const amount =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^-?\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  const currency = p['currency'];
  if (!Number.isSafeInteger(amount) || typeof currency !== 'string') return none;
  if (!/^[A-Z]{3}$/.test(currency)) return none;
  return { stagedAmountMinor: amount, currency };
}

export function toImportException(
  row: ExceptionRow,
  staged: { entityType: ImportRow['entityType']; externalId: string; payload: unknown },
): ImportException {
  return {
    ...stagedBalanceOf(staged.entityType, staged.payload),
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

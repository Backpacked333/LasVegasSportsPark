import {
  AuthoritativeSystemSchema,
  defineEvent,
  ImportExceptionDecisionSchema,
  ImportExceptionKindSchema,
  ImportEntityTypeSchema,
  OutcomeCountsSchema,
  ReconciliationAreaSchema,
  z,
} from '@sportspark/contracts';

/**
 * Migration domain events (§4.12). Payloads carry identifiers, counts and categories only: staged
 * payloads (names, dates of birth, contact values) never travel in events (§4.14). No handler of
 * these events notifies a customer: an import never sends historical notifications (§5.4).
 */
export const MigrationEvents = {
  batchReceived: defineEvent(
    'migration.batch_received',
    z.object({ batchId: z.uuid(), sourceSystem: z.string(), rowCount: z.number().int() }),
  ),
  batchValidated: defineEvent(
    'migration.batch_validated',
    z.object({
      batchId: z.uuid(),
      plannedCounts: OutcomeCountsSchema,
      openExceptions: z.number().int(),
    }),
  ),
  batchReviewed: defineEvent('migration.batch_reviewed', z.object({ batchId: z.uuid() })),
  batchApplied: defineEvent(
    'migration.batch_applied',
    z.object({ batchId: z.uuid(), sourceSystem: z.string(), counts: OutcomeCountsSchema }),
  ),
  batchAborted: defineEvent('migration.batch_aborted', z.object({ batchId: z.uuid() })),
  exceptionRaised: defineEvent(
    'migration.import_exception_raised',
    z.object({
      exceptionId: z.uuid(),
      batchId: z.uuid(),
      kind: ImportExceptionKindSchema,
      reviewOwnerRole: z.string(),
    }),
  ),
  exceptionDecided: defineEvent(
    'migration.import_exception_decided',
    z.object({
      exceptionId: z.uuid(),
      batchId: z.uuid(),
      decision: ImportExceptionDecisionSchema,
    }),
  ),
  authorityAssigned: defineEvent(
    'migration.authority_assigned',
    z.object({
      assignmentId: z.uuid(),
      recordCategory: ImportEntityTypeSchema,
      scopeKind: z.enum(['organization', 'facility', 'program', 'competition']),
      scopeId: z.uuid().nullable(),
      authoritativeSystem: AuthoritativeSystemSchema,
      effectiveFrom: z.iso.datetime(),
      effectiveTo: z.iso.datetime().nullable(),
      supersedesAssignmentId: z.uuid().nullable(),
    }),
  ),
  authorityEnded: defineEvent(
    'migration.authority_ended',
    z.object({
      assignmentId: z.uuid(),
      recordCategory: ImportEntityTypeSchema,
      effectiveTo: z.iso.datetime(),
    }),
  ),
  reconciliationGenerated: defineEvent(
    'migration.reconciliation_generated',
    z.object({
      reportId: z.uuid(),
      batchId: z.uuid(),
      status: z.enum(['balanced', 'discrepancy']),
      discrepancyCount: z.number().int(),
    }),
  ),
  reconciliationDecided: defineEvent(
    'migration.reconciliation_decided',
    z.object({
      reportId: z.uuid(),
      batchId: z.uuid(),
      area: ReconciliationAreaSchema,
      decision: z.enum(['approved', 'rejected']),
      approvalStatus: z.enum(['pending', 'approved', 'rejected']),
    }),
  ),
};

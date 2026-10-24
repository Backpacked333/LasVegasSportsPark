import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/**
 * Migration actions (specification §5.3..§5.8, §6.6 "Migration scope and writer authority —
 * Migration owner/operator"). Staging, validating, reviewing and applying a batch belong to the
 * migration operators (general manager as operator, system administrator as technical owner).
 * Writer authority (the authority matrix) is an operator decision: only the general manager
 * assigns it. Reviewers in the owning areas read batches, decide their queue's exceptions and
 * approve their area of a reconciliation report (§5.5). Batches and rows carry customer-private
 * data, so every batch-targeted read and command is a protected record (§4.10: NOT_FOUND).
 */
const OPERATORS: readonly StaffRole[] = ['general_manager', 'system_administrator'];
const REVIEWERS: readonly StaffRole[] = [
  ...OPERATORS,
  'finance_operator',
  'program_manager',
  'league_manager',
  'scheduler',
  'support_operator',
];
const ALL_STAFF: readonly StaffRole[] = [
  ...REVIEWERS,
  'front_desk',
  'facilities_operator',
  'coach',
  'official',
];

export const MigrationActions = defineActions({
  stageBatch: {
    id: 'migration.stage_batch',
    description: 'Stage a source snapshot (rows, control totals, checksum, provenance)',
    staffRoles: OPERATORS,
    requirements: ['§5.3', '§5.4'],
  },
  readBatch: {
    id: 'migration.read_batch',
    description: 'Read import batches, staged rows and row outcomes',
    staffRoles: REVIEWERS,
    requirements: ['§5.4'],
  },
  validateBatch: {
    id: 'migration.validate_batch',
    description: 'Seal and dry-run a batch; ambiguity and conflicts enter review queues',
    staffRoles: OPERATORS,
    requirements: ['§5.4'],
  },
  reviewBatch: {
    id: 'migration.review_batch',
    description: 'Complete the review of a batch whose exceptions are all decided',
    staffRoles: OPERATORS,
    requirements: ['§5.4'],
  },
  applyBatch: {
    id: 'migration.apply_batch',
    description:
      'Apply a reviewed batch through the owning modules (idempotent per external id; no charges, no notices)',
    staffRoles: OPERATORS,
    requirements: ['§5.4', '§4.7.5', '§4.7.11', 'SPK-AT-024'],
  },
  abortBatch: {
    id: 'migration.abort_batch',
    description: 'Abort a batch before any apply started (prelaunch abort)',
    staffRoles: OPERATORS,
    requirements: ['§5.8'],
  },
  readExceptions: {
    id: 'migration.read_exceptions',
    description: 'Read the import review queues',
    staffRoles: REVIEWERS,
    requirements: ['§5.4'],
  },
  decideException: {
    id: 'migration.decide_exception',
    description:
      'Decide an import exception owned by your queue (relationships: support; balances: finance)',
    staffRoles: ['general_manager', 'system_administrator', 'finance_operator', 'support_operator'],
    requirements: ['§5.4'],
  },
  readMappings: {
    id: 'migration.read_mappings',
    description: 'Look up external identifiers mapped to internal records',
    staffRoles: REVIEWERS,
    requirements: ['§5.3'],
  },
  readAuthority: {
    id: 'migration.read_authority',
    description: 'Read the authority matrix (where each record category is written)',
    staffRoles: ALL_STAFF,
    requirements: ['§5.6'],
  },
  assignAuthority: {
    id: 'migration.assign_authority',
    description: 'Assign, transfer or end the authoritative system of a record category and scope',
    staffRoles: ['general_manager'],
    requirements: ['§5.6', '§5.7', '§5.8', '§4.7.11'],
  },
  reconcile: {
    id: 'migration.reconcile',
    description: 'Generate a reconciliation report for an applied batch',
    staffRoles: REVIEWERS,
    requirements: ['§5.5'],
  },
  readReconciliation: {
    id: 'migration.read_reconciliation',
    description: 'Read reconciliation reports, discrepancies and approvals',
    staffRoles: REVIEWERS,
    requirements: ['§5.5'],
  },
  approveReconciliation: {
    id: 'migration.approve_reconciliation',
    description: 'Approve or reject one area of a reconciliation report',
    staffRoles: [
      'finance_operator',
      'program_manager',
      'league_manager',
      'scheduler',
      'general_manager',
      'support_operator',
    ],
    requirements: ['§5.5'],
  },
});

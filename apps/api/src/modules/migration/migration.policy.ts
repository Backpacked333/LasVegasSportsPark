import type {
  GrantPermissionValue,
  ImportExceptionKindValue,
  ReconciliationAreaValue,
  StaffRole,
} from '@sportspark/contracts';

/**
 * Policy values the specification leaves to operators. Each value is the specification's
 * proposed default or an engineering proposal, injected under MIGRATION_POLICY so an approved
 * operator decision replaces it without code changes:
 *   - which relationship evidence is imported without review and which permissions always need
 *     review: §6.6 "Guardian verification and child-account policy" (Operator/privacy owner) and
 *     "Migration scope and writer authority" (Migration owner/operator) — pending;
 *   - who reviews each exception queue and who approves each reconciliation area: §5.5 ("Finance
 *     approves opening balances. Program and league owners approve active participation.
 *     Operations approves the schedule."); the identity area is proposed for the operator
 *     (general manager) and support;
 *   - the apply lease: an engineering default (an interrupted apply can be resumed after it).
 */
export const MIGRATION_POLICY = Symbol('MIGRATION_POLICY');

export type RelationshipBasis = 'documented' | 'inferred' | 'self_reported';

export interface MigrationPolicy {
  /** Evidence bases imported without review. Proposed: only explicitly documented capacity. */
  relationshipBasesWithoutReview: readonly RelationshipBasis[];
  /** Permissions never imported without review. Proposed: `collect` (pickup, SPK-AT-016). */
  permissionsRequiringReview: readonly GrantPermissionValue[];
  /** Queue that owns each exception kind (general managers may decide any of them). */
  exceptionOwners: Readonly<Record<ImportExceptionKindValue, StaffRole>>;
  /** Roles that may approve each reconciliation area (§5.5). */
  areaApprovers: Readonly<Record<ReconciliationAreaValue, readonly StaffRole[]>>;
  /** Minutes an apply holds the per-source lock without progress before another may resume it. */
  applyLeaseMinutes: number;
  /** Largest batch accepted (the §5.10 envelope is 25,000 people). */
  maxRowsPerBatch: number;
  /** Uses of an imported credit when the source does not say (finance decides, SPK-PAY-009). */
  defaultCreditUses: readonly ('registration' | 'obligation')[];
}

export const DEFAULT_MIGRATION_POLICY: MigrationPolicy = {
  relationshipBasesWithoutReview: ['documented'],
  permissionsRequiringReview: ['collect'],
  exceptionOwners: {
    ambiguous_relationship: 'support_operator',
    ambiguous_balance: 'finance_operator',
    conflict: 'system_administrator',
    validation: 'system_administrator',
  },
  areaApprovers: {
    finance: ['finance_operator', 'general_manager'],
    participation: ['program_manager', 'league_manager', 'general_manager'],
    schedule: ['scheduler', 'general_manager'],
    identity: ['general_manager', 'support_operator'],
  },
  applyLeaseMinutes: 15,
  maxRowsPerBatch: 50_000,
  defaultCreditUses: ['registration', 'obligation'],
};

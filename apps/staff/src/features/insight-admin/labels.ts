/**
 * Vocabulary of the Reports and Administration screens (SCR-S-43 to SCR-S-48). Staff status labels
 * are the machine state names verbatim (docs/package-a/journeys.md section 3 rule 4, SPK-UX-010),
 * always with a glyph and text (never colour alone, SPK-UX-009). Report names follow the
 * SPK-REPORT-002 to SPK-REPORT-006 lists; decision owners are copied from
 * docs/package-a/decision-register.md. Nothing here is a policy value.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export type ReportKey = Schema<'ReportKey'>;
export type StaffRole = Schema<'StaffMembership'>['roles'][number];

/** Report scope: facility reports need a facility; organization reports need organization-wide access. */
export type ReportParameterShape =
  'facility_date' | 'facility_range' | 'facility_only' | 'organization_now' | 'organization_period';

export interface ReportCatalogEntry {
  key: ReportKey;
  title: string;
  path: string;
  shape: ReportParameterShape;
  requirement: string;
}

/** SPK-REPORT-002 required operating reports (SCR-S-43), in specification order. */
export const OPERATING_REPORTS: readonly ReportCatalogEntry[] = [
  r('daily_schedule', 'Daily schedule', 'daily-schedule', 'facility_date'),
  r('expected_arrivals', 'Expected arrivals', 'expected-arrivals', 'facility_date'),
  r('attendance', 'Attendance', 'attendance', 'facility_range'),
  r('match_readiness', 'Match readiness', 'match-readiness', 'facility_range'),
  r('uncovered_assignments', 'Uncovered assignments', 'uncovered-assignments', 'facility_range'),
  r('waitlist_demand', 'Waitlist demand', 'waitlist-demand', 'facility_range'),
  r('registration_funnel', 'Registration funnel', 'registration-funnel', 'facility_range'),
  r(
    'enrollment_completeness',
    'Enrollment and roster completeness',
    'enrollment-completeness',
    'facility_only',
  ),
  r(
    'outstanding_obligations',
    'Outstanding obligations',
    'outstanding-obligations',
    'organization_now',
  ),
  r(
    'payment_reconciliation',
    'Payment and refund reconciliation',
    'payment-reconciliation',
    'organization_period',
  ),
  r(
    'maintenance_restrictions',
    'Maintenance restrictions',
    'maintenance-restrictions',
    'facility_only',
  ),
  r(
    'communication_failures',
    'Communication failures',
    'communication-failures',
    'organization_period',
  ),
];

/** SCR-S-44: utilization, economics, demand and retention. */
export const INSIGHT_REPORTS: readonly ReportCatalogEntry[] = [
  {
    ...r('utilization', 'Field utilization', 'utilization', 'facility_range'),
    requirement: 'SPK-REPORT-003',
  },
  { ...r('economics', 'Economics', 'economics', 'facility_range'), requirement: 'SPK-REPORT-004' },
  { ...r('demand', 'Demand', 'demand', 'facility_range'), requirement: 'SPK-REPORT-006' },
  {
    ...r('retention', 'Retention', 'retention', 'organization_now'),
    requirement: 'SPK-REPORT-005',
  },
];

function r(
  key: ReportKey,
  title: string,
  path: string,
  shape: ReportParameterShape,
): ReportCatalogEntry {
  return { key, title, path: `/reports/${path}`, shape, requirement: 'SPK-REPORT-002' };
}

export const ALL_REPORTS: readonly ReportCatalogEntry[] = [
  ...OPERATING_REPORTS,
  ...INSIGHT_REPORTS,
];

export function reportEntry(key: string): ReportCatalogEntry | undefined {
  return ALL_REPORTS.find((entry) => entry.key === key);
}

export function reportTitle(key: string): string {
  return reportEntry(key)?.title ?? key;
}

/** Freshness classes of the metric dictionary section 3.2 (contract `ReportingFreshnessClass`). */
export const FRESHNESS_LABELS: Record<Schema<'ReportingFreshnessClass'>, string> = {
  F1: 'F1 live read',
  F2: 'F2 event-derived',
  F3: 'F3 stored snapshot',
};

/** How far a rerun at the same as-of instant recomputes the same figures (SPK-REPORT-007). */
export const POINT_IN_TIME_LABELS: Record<Schema<'ReportingPointInTime'>, string> = {
  full: 'Reproducible from source records at the as-of instant',
  partial: 'Partly reproducible; the stored run is the reproducible record',
  none: 'Evaluated live only; the stored run is the record',
};

export const ROLE_LABELS: Record<StaffRole, string> = {
  front_desk: 'Front desk',
  league_manager: 'League manager',
  program_manager: 'Program manager',
  scheduler: 'Scheduler',
  finance_operator: 'Finance operator',
  facilities_operator: 'Facilities operator',
  general_manager: 'General manager',
  system_administrator: 'System administrator',
  support_operator: 'Support operator',
  coach: 'Coach or instructor',
  official: 'Referee or official',
};

export const STAFF_ROLES = Object.keys(ROLE_LABELS) as StaffRole[];

export function roleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role;
}

export interface Badge {
  tone: StatusTone;
  label: string;
}

const badge = (tone: StatusTone, label: string): Badge => ({ tone, label });

export const EXPORT_BADGES: Record<Schema<'ReportExportStatus'>, Badge> = {
  ready: badge('success', 'ready'),
  downloaded: badge('neutral', 'downloaded'),
  expired: badge('neutral', 'expired'),
  revoked: badge('neutral', 'revoked'),
};

export const BATCH_BADGES: Record<Schema<'ImportBatchStatus'>, Badge> = {
  received: badge('info', 'received'),
  validated: badge('info', 'validated'),
  reviewed: badge('pending', 'reviewed'),
  applied: badge('success', 'applied'),
  aborted: badge('neutral', 'aborted'),
};

/** `ImportRowOutcome` is published as nullable (a null outcome means not planned or not applied). */
export type RowOutcome = NonNullable<Schema<'ImportRowOutcome'>>;

export const ROW_OUTCOME_BADGES: Record<RowOutcome, Badge> = {
  created: badge('success', 'created'),
  matched: badge('success', 'matched'),
  updated: badge('success', 'updated'),
  skipped: badge('neutral', 'skipped'),
  exception: badge('warning', 'exception'),
};

export const EXCEPTION_STATUS_BADGES: Record<Schema<'ImportException'>['status'], Badge> = {
  open: badge('warning', 'open'),
  decided: badge('success', 'decided'),
  withdrawn: badge('neutral', 'withdrawn'),
};

export const EXCEPTION_KIND_LABELS: Record<Schema<'ImportExceptionKind'>, string> = {
  ambiguous_relationship: 'Ambiguous relationship',
  ambiguous_balance: 'Ambiguous balance',
  conflict: 'Conflict',
  validation: 'Validation error',
};

export const RECONCILIATION_BADGES: Record<'balanced' | 'discrepancy', Badge> = {
  balanced: badge('success', 'balanced'),
  discrepancy: badge('warning', 'discrepancy'),
};

export const APPROVAL_BADGES: Record<
  Schema<'MigrationReconciliationReport'>['approvalStatus'],
  Badge
> = {
  pending: badge('pending', 'pending'),
  approved: badge('success', 'approved'),
  rejected: badge('danger', 'rejected'),
  superseded: badge('neutral', 'superseded'),
};

export const RECONCILIATION_LEVEL_LABELS: Record<Schema<'ReconciliationLevel'>, string> = {
  control_totals: '1. Control totals',
  record_identity: '2. Record identity',
  relationships: '3. Relationships',
  operational_outcomes: '4. Operational outcomes',
};

export const RECONCILIATION_AREA_LABELS: Record<Schema<'ReconciliationArea'>, string> = {
  identity: 'Identity',
  participation: 'Participation',
  schedule: 'Schedule',
  finance: 'Finance',
};

export const ENTITY_TYPE_LABELS: Record<Schema<'ImportEntityType'>, string> = {
  person: 'People',
  household: 'Households',
  relationship_evidence: 'Relationship evidence',
  account: 'Accounts',
  program: 'Programs',
  season: 'Seasons',
  team: 'Teams',
  roster: 'Rosters',
  future_schedule: 'Future schedules',
  attendance_history: 'Attendance history',
  result: 'Results',
  order: 'Orders',
  open_obligation: 'Open obligations',
  credit: 'Credits',
  refund: 'Refunds',
  document: 'Documents',
  communication_preference: 'Communication preferences',
};

export const ENTITY_TYPES = Object.keys(ENTITY_TYPE_LABELS) as Schema<'ImportEntityType'>[];

export const AUTHORITY_BASIS_BADGES: Record<Schema<'AuthorityResolution'>['basis'], Badge> = {
  assignment: badge('info', 'assignment'),
  default: badge('neutral', 'default'),
  conflict: badge('danger', 'conflict'),
};

export const POLICY_BADGES: Record<Schema<'PolicyApprovalStatus'>, Badge> = {
  draft: badge('info', 'draft'),
  approved: badge('success', 'approved'),
  retired: badge('neutral', 'retired'),
};

export const MEMBERSHIP_BADGES: Record<Schema<'StaffMembership'>['status'], Badge> = {
  active: badge('success', 'active'),
  ended: badge('neutral', 'ended'),
};

export const GRANT_PERMISSION_LABELS: Record<Schema<'GrantPermission'>, string> = {
  view: 'View',
  register: 'Register',
  pay: 'Pay',
  receive_messages: 'Receive messages',
  complete_forms: 'Complete forms',
  collect: 'Collect (pickup)',
};

/**
 * Operator decisions these screens depend on, with the "Required owner" wording of
 * docs/package-a/decision-register.md. Every one has answer status "unknown".
 */
export const DECISIONS = {
  providers: { ids: ['DEC-013'], owner: 'Technical lead/account owners' },
  identityProvider: { ids: ['DEC-018'], owner: 'Technical lead/account owners' },
  migrationScope: { ids: ['DEC-014'], owner: 'Migration owner/operator' },
  reconciliationSignOff: {
    ids: ['DEC-067'],
    owner:
      'Migration owner/operator (coordination); Finance; Program manager; League manager; Operations',
  },
  cutoverOwner: { ids: ['DEC-068'], owner: 'Migration owner/operator' },
  allocationMethod: { ids: ['DEC-085'], owner: 'Finance' },
  benchmarkTargets: { ids: ['DEC-045'], owner: 'Sponsor (acceptance authority)' },
  exportRetention: {
    ids: ['DEC-060'],
    owner: "Operator/privacy owner (with the responsible operator's advisers)",
  },
  capabilities: { ids: ['DEC-016'], owner: 'Product owner' },
  facilityInventory: { ids: ['DEC-001'], owner: 'Operations' },
  rentalApplicability: { ids: ['DEC-076', 'DEC-077'], owner: 'Product owner' },
} as const;

/** Owners of the decisions the integration register names per gate (decision register). */
export function decisionOwner(decision: string): string {
  return ['DEC-013', 'DEC-018', 'DEC-019', 'DEC-020', 'DEC-021', 'DEC-022', 'DEC-023'].includes(
    decision,
  )
    ? DECISIONS.providers.owner
    : 'see the decision register';
}

/**
 * Titles of the §5.2 provider-selection gates the integration register returns
 * (`GET /v1/admin/integrations`; each gate names its own pending decision, DEC-018 to DEC-023 and
 * DEC-013 for the assistant). A gate the client does not know is shown by its id.
 */
export const PROVIDER_GATE_TITLES: Record<Schema<'ProviderGate'>, string> = {
  identity: 'Identity provider',
  payments: 'Payment processor and merchant arrangement',
  messaging: 'Messaging providers (push, email, SMS)',
  hosting: 'Hosting and recovery environment',
  accounting: 'Accounting connection',
  hardware: 'Hardware interfaces',
  assistant: 'Operational assistant',
};

export function gateTitle(gate: string): string {
  return (PROVIDER_GATE_TITLES as Record<string, string>)[gate] ?? gate;
}

/** The twelve §5.1 register fields recorded for every provider, in the API's field order. */
export const REGISTER_FIELD_LABELS: Record<keyof Schema<'IntegrationRegister'>, string> = {
  productAndVendor: 'Product and vendor',
  accountOwner: 'Account owner',
  authorizedAccess: 'Authorized access',
  supportedOperations: 'Supported operations',
  sandboxAvailability: 'Sandbox availability',
  documentation: 'Documentation',
  eventBehavior: 'Event behavior',
  rateLimits: 'Rate limits',
  idempotency: 'Idempotency',
  failureHandling: 'Failure handling',
  reconciliationOwner: 'Reconciliation owner',
  exitProcedure: 'Exit procedure',
};

/** §5.1 capability evidence, in order. */
export const EVIDENCE_LEVELS: readonly string[] = ['documented', 'tested', 'accepted', 'live'];

/** The §5.2 scenarios a deterministic fake adapter reproduces. */
export const SCENARIO_LABELS: Record<Schema<'IntegrationScenario'>, string> = {
  success: 'success',
  failure: 'failure',
  timeout_unknown: 'timeout or unknown outcome',
  duplicate: 'duplicate webhook',
};

export const ADAPTER_KIND_LABELS: Record<Schema<'IntegrationAdapter'>['adapter']['kind'], string> =
  {
    fake: 'Test adapter (deterministic fake)',
    local: 'Local adapter',
    provider: 'Provider adapter',
  };

/** Provider event states of the inbox (§4.12); "dead" means its retries are exhausted. */
export const PROVIDER_EVENT_BADGES: Record<Schema<'ProviderEventStatus'>, Badge> = {
  received: badge('info', 'received'),
  processed: badge('success', 'processed'),
  failed: badge('danger', 'failed'),
  ignored: badge('neutral', 'ignored'),
  dead: badge('danger', 'dead'),
};

/** How a capability switch is enforced (K-12). */
export const ENFORCEMENT_LABELS: Record<Schema<'CapabilityEnforcement'>, string> = {
  commands: 'New commitments check this switch; existing records stay readable and can be ended.',
  recorded_only:
    'Recorded only: nothing checks this switch; whether it is enforced is itself a DEC-016 question.',
};

export const FACILITY_STATUS_BADGES: Record<Schema<'FacilityStatus'>, Badge> = {
  active: badge('success', 'active'),
  closed: badge('warning', 'closed'),
  archived: badge('neutral', 'archived'),
};

export const ORGANIZATION_STATUS_BADGES: Record<
  Schema<'AdminOrganizationSettings'>['status'],
  Badge
> = {
  active: badge('success', 'active'),
  suspended: badge('warning', 'suspended'),
  archived: badge('neutral', 'archived'),
};

import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { StaffRole } from '../principal';
import { Instant } from '../time';
import { DeliveryChannelSchema, NotificationCategorySchema } from './communications';
import { RosterPlayingStatusSchema, SeasonStatusSchema, TeamStatusSchema } from './competition';
import { ActorSnapshotSchema } from './facilities';
import { GrantPermissionSchema } from './identity';
import { EventKind } from './scheduling';

/**
 * Migration module API contract (specification §5.3 inventory, §5.4 import behaviour, §5.5
 * reconciliation, §5.6 one authority during transition, §4.4 Migration, §4.7 invariant 11,
 * SPK-AT-024).
 *
 * NEUTRAL STAGING CONTRACT (version `staging-v1`). No legacy system or export has been supplied
 * (§1.4), so its format is unknown. The operator's extraction step transforms whatever the source
 * produces into rows of `(entityType, externalId, payload)`:
 *   - `entityType` is one line of the §5.3 inventory (`ImportEntityTypeSchema`);
 *   - `externalId` is the source system's own stable identifier — never a name or an email;
 *   - `payload` is a flat JSON object whose fields are given per entity type below
 *     (`*ImportPayloadSchema`); references to other staged records use their external ids.
 * Rows arrive as JSON (`rows`) or as CSV (`csv`: one document per entity type, a header row of
 * payload field names plus `external_id`; list fields separated by `;`; empty cells are absent;
 * amounts are integer minor units). Large snapshots are staged in chunks (`POST
 * /import-batches/{id}/rows`); validation seals the batch and verifies the declared checksum
 * (SHA-256 over the canonical rows, see `apps/api/src/modules/migration/staging/checksum.ts`) and
 * the declared row count. Organization scope always comes from the authenticated principal.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary (mirrored by the check constraints in migration 1200)
// ---------------------------------------------------------------------------------------------

export const IMPORT_ENTITY_TYPES = [
  'person',
  'household',
  'relationship_evidence',
  'account',
  'program',
  'season',
  'team',
  'roster',
  'future_schedule',
  'attendance_history',
  'result',
  'order',
  'open_obligation',
  'credit',
  'refund',
  'document',
  'communication_preference',
] as const;
/** §5.3 inventory line; also the record category of the authority matrix (§5.6). */
export const ImportEntityTypeSchema = z.enum(IMPORT_ENTITY_TYPES).openapi('ImportEntityType');
export type ImportEntityTypeValue = z.infer<typeof ImportEntityTypeSchema>;

export const ImportBatchStatusSchema = z
  .enum(['received', 'validated', 'reviewed', 'applied', 'aborted'])
  .openapi('ImportBatchStatus');
export type ImportBatchStatusValue = z.infer<typeof ImportBatchStatusSchema>;

export const ImportRowOutcomeSchema = z
  .enum(['created', 'matched', 'updated', 'skipped', 'exception'])
  .openapi('ImportRowOutcome');
export type ImportRowOutcomeValue = z.infer<typeof ImportRowOutcomeSchema>;

export const ImportExceptionKindSchema = z
  .enum(['ambiguous_relationship', 'ambiguous_balance', 'conflict', 'validation'])
  .openapi('ImportExceptionKind');
export type ImportExceptionKindValue = z.infer<typeof ImportExceptionKindSchema>;

export const ImportExceptionDecisionSchema = z
  .enum(['accept', 'reject', 'defer'])
  .openapi('ImportExceptionDecision');
export type ImportExceptionDecisionValue = z.infer<typeof ImportExceptionDecisionSchema>;

export const AuthoritativeSystemSchema = z
  .enum(['legacy', 'sportspark'])
  .openapi('AuthoritativeSystem');
export type AuthoritativeSystemValue = z.infer<typeof AuthoritativeSystemSchema>;

export const ReconciliationLevelSchema = z
  .enum(['control_totals', 'record_identity', 'relationships', 'operational_outcomes'])
  .openapi('ReconciliationLevel');
export type ReconciliationLevelValue = z.infer<typeof ReconciliationLevelSchema>;

export const ReconciliationAreaSchema = z
  .enum(['identity', 'participation', 'schedule', 'finance'])
  .openapi('ReconciliationArea');
export type ReconciliationAreaValue = z.infer<typeof ReconciliationAreaSchema>;

export const SourceSystem = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'source system is a lower-case identifier chosen by the operator (e.g. legacy-registration)',
  );
export const ExternalId = z.string().trim().min(1).max(200);
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lower-case SHA-256 hex digest');
const Reason = z.string().trim().min(1).max(2000);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');

// ---------------------------------------------------------------------------------------------
// Staged payloads per entity type (staging-v1). CSV values arrive as strings: list, integer and
// boolean fields accept their CSV spelling. Payloads are validated at `validate`, not at staging,
// so an invalid row becomes a reviewable validation exception instead of refusing the snapshot.
// ---------------------------------------------------------------------------------------------

const csvList = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(';')
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
        : value,
    z.array(item),
  );
const csvInt = z.preprocess(
  (value) => (typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value),
  z.number().int().safe(),
);
const csvBool = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);
const Text200 = z.string().trim().min(1).max(200);

export const PersonImportPayloadSchema = z.looseObject({
  givenName: Text200,
  familyName: Text200,
  dateOfBirth: DateOnly.optional(),
  kind: z.enum(['adult', 'child']).optional(),
  /** Imported as an unverified contact point: never a key, never a login (§5.3). */
  email: z.string().trim().min(3).max(320).optional(),
  phone: z.string().trim().min(3).max(320).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export const HouseholdImportPayloadSchema = z.looseObject({
  name: Text200,
  memberExternalIds: csvList(ExternalId).pipe(z.array(ExternalId).min(1).max(50)),
});
export const RelationshipEvidenceImportPayloadSchema = z.looseObject({
  actorExternalId: ExternalId,
  subjectExternalId: ExternalId,
  kind: z.enum(['guardian', 'delegate', 'caregiver']),
  permissions: csvList(GrantPermissionSchema).pipe(z.array(GrantPermissionSchema).min(1)),
  /**
   * How the source knew: `documented` (an explicit record of the capacity and permissions),
   * `inferred` (derived from a shared household, address or contact), `self_reported`.
   */
  basis: z.enum(['documented', 'inferred', 'self_reported']),
  effectiveFrom: Instant.optional(),
  effectiveTo: Instant.optional(),
});
export const ProgramImportPayloadSchema = z.looseObject({
  name: Text200,
  description: z.string().trim().min(1).max(5000).optional(),
  activityType: z.string().trim().min(1).max(100),
  format: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['draft', 'active']).optional(),
});
export const OpenObligationImportPayloadSchema = z.looseObject({
  debtorExternalId: ExternalId,
  /** The amount still owed at the snapshot, in minor units. */
  amountMinor: csvInt,
  currency: CurrencyCode,
  dueAt: Instant,
  description: z.string().trim().min(1).max(500),
  originalAmountMinor: csvInt.optional(),
  paidMinor: csvInt.optional(),
  disputed: csvBool.optional(),
});
export const CreditImportPayloadSchema = z.looseObject({
  ownerExternalId: ExternalId,
  /** The unredeemed balance at the snapshot, in minor units. */
  amountMinor: csvInt,
  currency: CurrencyCode,
  expiresAt: Instant.optional(),
  permittedUses: csvList(z.enum(['registration', 'obligation'])).optional(),
});
export const RefundImportPayloadSchema = z.looseObject({
  amountMinor: csvInt,
  currency: CurrencyCode,
  status: z.enum(['settled', 'pending', 'processing', 'failed', 'canceled', 'unknown']),
});
export const OrderImportPayloadSchema = z.looseObject({
  totalMinor: csvInt,
  currency: CurrencyCode,
});
/** Records kept as staged history only: their own fields are free-form. */
export const HistoryImportPayloadSchema = z.looseObject({});
/** Operational records the owning module has no import command for yet. */
export const OperationalImportPayloadSchema = z.looseObject({
  /** Whether the record is active (rosters, seasons, teams) or upcoming (schedules) at the snapshot. */
  active: csvBool.optional(),
});

// Operational categories created through the owning modules' import commands (MIG-02, IF-40).
// Records that are SportsPark configuration rather than §5.3 inventory lines — competitions, rule
// sets, divisions, facilities and resources (supplied by Operations, DEC-001) — are referenced by
// their SportsPark ids; everything staged is referenced by external id. Proposed contract, pending
// the migration scope decision (§6.6).

/** A season of a SportsPark competition, under one of its rule sets (competition importSeason). */
export const SeasonImportPayloadSchema = z.looseObject({
  competitionId: z.uuid(),
  ruleSetId: z.uuid(),
  name: Text200,
  startsOn: DateOnly,
  endsOn: DateOnly,
  /** The season's status at the snapshot; never defaulted. */
  status: SeasonStatusSchema,
  registrationOpensAt: Instant.optional(),
  registrationClosesAt: Instant.optional(),
  active: csvBool.optional(),
});
export type SeasonImportPayload = z.infer<typeof SeasonImportPayloadSchema>;

/** `record: 'team'` (default): a team, which persists across seasons (competition importTeam). */
export const TeamRecordImportPayloadSchema = z.looseObject({
  record: z.literal('team'),
  name: Text200,
  primaryColor: z.string().trim().min(1).max(50).optional(),
  secondaryColor: z.string().trim().min(1).max(50).optional(),
  status: TeamStatusSchema.optional(),
  active: csvBool.optional(),
});
/**
 * `record: 'entry'`: a staged team's entry in a staged season (competition importTeamEntry). Only
 * `applied` and `approved` entries are imported; withdrawn and rejected entries stay history.
 */
export const TeamEntryImportPayloadSchema = z.looseObject({
  record: z.literal('entry'),
  teamExternalId: ExternalId,
  seasonExternalId: ExternalId,
  /** A SportsPark division of the season (configuration). */
  divisionId: z.uuid().optional(),
  status: z.enum(['applied', 'approved']),
  appliedAt: Instant,
  /** Required when `status` is `approved`, and only then. */
  approvedAt: Instant.optional(),
  /** The person (external id) holding the captain role from `appliedAt`. */
  captainExternalId: ExternalId.optional(),
  active: csvBool.optional(),
});
/** One `team` inventory line is a team or a team's entry in a season (one record per row). */
export const TeamImportPayloadSchema = z.preprocess(
  (value) =>
    value && typeof value === 'object' && !Array.isArray(value) && !('record' in value)
      ? { ...value, record: 'team' }
      : value,
  z.discriminatedUnion('record', [TeamRecordImportPayloadSchema, TeamEntryImportPayloadSchema]),
);
export type TeamImportPayload = z.infer<typeof TeamImportPayloadSchema>;

/** A roster membership on a staged team entry (competition importRosterMembership). */
export const RosterImportPayloadSchema = z.looseObject({
  /** The external id of the staged team row with `record: 'entry'`. */
  entryExternalId: ExternalId,
  personExternalId: ExternalId,
  status: RosterPlayingStatusSchema,
  effectiveFrom: Instant,
  effectiveTo: Instant.optional(),
  jerseyNumber: csvInt.pipe(z.number().int().min(0).max(999)).optional(),
  active: csvBool.optional(),
});
export type RosterImportPayload = z.infer<typeof RosterImportPayloadSchema>;

/**
 * A future event, imported as a draft that holds no space (scheduling importEvent): it is
 * published only through a schedule draft under SportsPark's scheduling authority (§5.6).
 */
export const FutureScheduleImportPayloadSchema = z.looseObject({
  /** A SportsPark facility and its resources (the inventory is supplied by Operations, DEC-001). */
  facilityId: z.uuid(),
  resourceIds: csvList(z.uuid()).pipe(z.array(z.uuid()).min(1).max(20)),
  kind: EventKind,
  title: Text200,
  format: z.string().trim().min(1).max(100).optional(),
  scheduledStart: Instant,
  scheduledEnd: Instant,
  setupMinutes: csvInt.pipe(z.number().int().min(0).max(240)).optional(),
  cleanupMinutes: csvInt.pipe(z.number().int().min(0).max(240)).optional(),
});
export type FutureScheduleImportPayload = z.infer<typeof FutureScheduleImportPayloadSchema>;

/** One preference: JSON `{ channel, category, enabled }` or CSV `category.channel=true|false`. */
const ImportedPreferenceSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const match = /^([a-z_]+)\.([a-z_]+)=(true|false)$/.exec(value.trim());
    return match ? { category: match[1], channel: match[2], enabled: match[3] === 'true' } : value;
  },
  z
    .object({
      channel: DeliveryChannelSchema,
      category: NotificationCategorySchema,
      enabled: z.boolean(),
    })
    .strict(),
);
/** A person's communication preferences (communications importPreferences). */
export const CommunicationPreferenceImportPayloadSchema = z.looseObject({
  personExternalId: ExternalId,
  preferences: csvList(ImportedPreferenceSchema).pipe(
    z
      .array(
        z.object({
          channel: DeliveryChannelSchema,
          category: NotificationCategorySchema,
          enabled: z.boolean(),
        }),
      )
      .min(1)
      .max(20),
  ),
});
export type CommunicationPreferenceImportPayload = z.infer<
  typeof CommunicationPreferenceImportPayloadSchema
>;

export const IMPORT_PAYLOAD_SCHEMAS: Record<ImportEntityTypeValue, z.ZodType> = {
  person: PersonImportPayloadSchema,
  household: HouseholdImportPayloadSchema,
  relationship_evidence: RelationshipEvidenceImportPayloadSchema,
  account: HistoryImportPayloadSchema,
  program: ProgramImportPayloadSchema,
  season: SeasonImportPayloadSchema,
  team: TeamImportPayloadSchema,
  roster: RosterImportPayloadSchema,
  future_schedule: FutureScheduleImportPayloadSchema,
  attendance_history: HistoryImportPayloadSchema,
  result: HistoryImportPayloadSchema,
  order: OrderImportPayloadSchema,
  open_obligation: OpenObligationImportPayloadSchema,
  credit: CreditImportPayloadSchema,
  refund: RefundImportPayloadSchema,
  document: HistoryImportPayloadSchema,
  communication_preference: CommunicationPreferenceImportPayloadSchema,
};

// ---------------------------------------------------------------------------------------------
// Staging (POST /import-batches, POST /import-batches/{id}/rows)
// ---------------------------------------------------------------------------------------------

export const StagedRowSchema = z
  .object({
    entityType: ImportEntityTypeSchema,
    externalId: ExternalId,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .openapi('StagedRow');
export type StagedRow = z.infer<typeof StagedRowSchema>;

export const CsvDocumentSchema = z
  .object({
    entityType: ImportEntityTypeSchema,
    /** RFC 4180 CSV with a header row; one column must be `external_id`. */
    content: z.string().min(1).max(500_000),
  })
  .strict()
  .openapi('CsvDocument');
export type CsvDocument = z.infer<typeof CsvDocumentSchema>;

const MONEY_TOTAL_TYPES = ['open_obligation', 'credit', 'order', 'refund'] as const;
export const ControlTotalAmountSchema = z
  .object({
    entityType: z.enum(MONEY_TOTAL_TYPES),
    currency: CurrencyCode,
    totalMinor: z.number().int().safe(),
  })
  .strict()
  .openapi('ControlTotalAmount');

/** Totals the source system reports for the snapshot (§5.5 level 1), compared without netting. */
export const ControlTotalsSchema = z
  .object({
    counts: z
      .record(z.string(), z.number().int().min(0))
      .refine(
        (value) => Object.keys(value).every((k) => ImportEntityTypeSchema.safeParse(k).success),
        {
          message: 'count keys must be import entity types',
        },
      )
      .default({}),
    amounts: z.array(ControlTotalAmountSchema).max(100).default([]),
  })
  .strict()
  .openapi('ControlTotals');
export type ControlTotals = z.infer<typeof ControlTotalsSchema>;

export const MAX_ROWS_PER_REQUEST = 2000;

export const ExtractionProvenanceSchema = z
  .object({
    tool: z.string().trim().min(1).max(200).optional(),
    query: z.string().trim().min(1).max(5000).optional(),
    extractedBy: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .openapi('ExtractionProvenance');

export const CreateImportBatchBody = withCommandMeta({
  sourceSystem: SourceSystem,
  snapshotTakenAt: Instant,
  transformationVersion: z.string().trim().min(1).max(100),
  /** SHA-256 the extraction computed over the canonical rows; verified when the batch is sealed. */
  checksum: Sha256Hex.optional(),
  /** Total rows of the snapshot when it is staged in several chunks; verified when sealed. */
  rowCount: z.number().int().min(0).max(200_000).optional(),
  extraction: ExtractionProvenanceSchema.default({}),
  controlTotals: ControlTotalsSchema,
  rows: z.array(StagedRowSchema).max(MAX_ROWS_PER_REQUEST).default([]),
  csv: z.array(CsvDocumentSchema).max(17).default([]),
})
  .strict()
  .openapi('CreateImportBatchRequest');
export type CreateImportBatchInput = z.infer<typeof CreateImportBatchBody>;

export const AppendImportRowsBody = withCommandMeta({
  rows: z.array(StagedRowSchema).max(MAX_ROWS_PER_REQUEST).default([]),
  csv: z.array(CsvDocumentSchema).max(17).default([]),
})
  .strict()
  .openapi('AppendImportRowsRequest');
export type AppendImportRowsInput = z.infer<typeof AppendImportRowsBody>;

export const ValidateImportBatchBody = withCommandMeta({})
  .strict()
  .openapi('ValidateImportBatchRequest');
export type ValidateImportBatchInput = z.infer<typeof ValidateImportBatchBody>;

export const ReviewImportBatchBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .strict()
  .openapi('ReviewImportBatchRequest');
export type ReviewImportBatchInput = z.infer<typeof ReviewImportBatchBody>;

export const ApplyImportBatchBody = withCommandMeta({}).strict().openapi('ApplyImportBatchRequest');
export type ApplyImportBatchInput = z.infer<typeof ApplyImportBatchBody>;

export const AbortImportBatchBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .strict()
  .openapi('AbortImportBatchRequest');
export type AbortImportBatchInput = z.infer<typeof AbortImportBatchBody>;

export const ListImportBatchesQuery = PageRequestSchema.extend({
  sourceSystem: SourceSystem.optional(),
  status: ImportBatchStatusSchema.optional(),
});
export type ListImportBatchesQuery = z.infer<typeof ListImportBatchesQuery>;

export const ListImportRowsQuery = PageRequestSchema.extend({
  entityType: ImportEntityTypeSchema.optional(),
  outcome: ImportRowOutcomeSchema.optional(),
  plannedOutcome: ImportRowOutcomeSchema.optional(),
});
export type ListImportRowsQuery = z.infer<typeof ListImportRowsQuery>;

// ---------------------------------------------------------------------------------------------
// Batch, row and exception views
// ---------------------------------------------------------------------------------------------

export const ImportReasonSchema = z
  .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
  .openapi('ImportReason');
export type ImportReason = z.infer<typeof ImportReasonSchema>;

export const OutcomeCountsSchema = z
  .object({
    created: z.number().int(),
    matched: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    exception: z.number().int(),
  })
  .openapi('ImportOutcomeCounts');
export type OutcomeCounts = z.infer<typeof OutcomeCountsSchema>;

export const ImportBatchSchema = z
  .object({
    id: z.uuid(),
    sourceSystem: z.string(),
    snapshotTakenAt: Instant,
    receivedAt: Instant,
    transformationVersion: z.string(),
    declaredChecksum: z.string().nullable(),
    declaredRowCount: z.number().int().nullable(),
    /** Computed over the staged rows when the batch is sealed by validation. */
    checksum: z.string().nullable(),
    rowCount: z.number().int(),
    status: ImportBatchStatusSchema,
    extraction: z.record(z.string(), z.unknown()),
    controlTotals: z.record(z.string(), z.unknown()),
    plannedCounts: OutcomeCountsSchema.nullable(),
    outcomeCounts: OutcomeCountsSchema,
    validationSummary: z.record(z.string(), z.unknown()),
    exceptions: z.object({
      open: z.number().int(),
      decided: z.number().int(),
      withdrawn: z.number().int(),
    }),
    /** Other batches of this source with the same checksum: a re-import of the same snapshot. */
    sameChecksumBatchIds: z.array(z.uuid()),
    /**
     * The batch's most recent reconciliation report (§5.5), null until one is generated; earlier
     * ones are listed at GET /import-batches/{id}/reconciliation-reports (MIG-01).
     */
    latestReconciliationReportId: z.uuid().nullable(),
    validatedAt: Instant.nullable(),
    reviewedAt: Instant.nullable(),
    applyStartedAt: Instant.nullable(),
    appliedAt: Instant.nullable(),
    appliedOperationId: z.uuid().nullable(),
    abortedAt: Instant.nullable(),
    abortReason: z.string().nullable(),
    submittedBy: ActorSnapshotSchema,
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('ImportBatch');
export type ImportBatch = z.infer<typeof ImportBatchSchema>;

export const ImportRowSchema = z
  .object({
    id: z.uuid(),
    batchId: z.uuid(),
    sequence: z.number().int(),
    entityType: ImportEntityTypeSchema,
    externalId: z.string(),
    payload: z.record(z.string(), z.unknown()),
    payloadHash: z.string(),
    plannedOutcome: ImportRowOutcomeSchema.nullable(),
    outcome: ImportRowOutcomeSchema.nullable(),
    mappingId: z.uuid().nullable(),
    internalId: z.uuid().nullable(),
    reasons: z.array(ImportReasonSchema),
    appliedAt: Instant.nullable(),
  })
  .openapi('ImportRow');
export type ImportRow = z.infer<typeof ImportRowSchema>;

export const ImportExceptionResolutionSchema = z
  .object({
    /** Ambiguous relationship: the permissions approved for import (a subset of those staged). */
    permissions: z.array(GrantPermissionSchema).min(1).optional(),
    /** Ambiguous balance: the opening amount finance approved, in minor units. */
    amountMinor: z.number().int().min(1).safe().optional(),
  })
  .strict()
  .openapi('ImportExceptionResolution');
export type ImportExceptionResolution = z.infer<typeof ImportExceptionResolutionSchema>;

export const ImportExceptionSchema = z
  .object({
    id: z.uuid(),
    batchId: z.uuid(),
    rowId: z.uuid(),
    entityType: ImportEntityTypeSchema,
    externalId: z.string(),
    /**
     * MIG-01 (§5.5, SPK-PAY-001): when the exception concerns a balance (an opening obligation,
     * credit or refund row), the amount in minor units and its currency as the staged row states
     * them; null otherwise. An approved amount (`resolution.amountMinor`) is in this currency.
     */
    stagedAmountMinor: z.number().int().nullable(),
    currency: z.string().nullable(),
    kind: ImportExceptionKindSchema,
    phase: z.enum(['validation', 'apply']),
    reasons: z.array(ImportReasonSchema),
    reviewOwnerRole: StaffRole,
    status: z.enum(['open', 'decided', 'withdrawn']),
    decision: ImportExceptionDecisionSchema.nullable(),
    resolution: ImportExceptionResolutionSchema.nullable(),
    decisionReason: z.string().nullable(),
    decidedBy: ActorSnapshotSchema.nullable(),
    decidedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('ImportException');
export type ImportException = z.infer<typeof ImportExceptionSchema>;

export const ListImportExceptionsQuery = PageRequestSchema.extend({
  batchId: z.uuid().optional(),
  status: z.enum(['open', 'decided', 'withdrawn']).optional(),
  kind: ImportExceptionKindSchema.optional(),
  reviewOwnerRole: StaffRole.optional(),
});
export type ListImportExceptionsQuery = z.infer<typeof ListImportExceptionsQuery>;

export const DecideImportExceptionBody = withCommandMeta({
  decision: ImportExceptionDecisionSchema,
  resolution: ImportExceptionResolutionSchema.optional(),
})
  .extend({ reason: Reason, expectedRevision: Revision })
  .strict()
  .refine((v) => v.resolution === undefined || v.decision === 'accept', {
    message: 'a resolution is only recorded with an accept decision',
    path: ['resolution'],
  })
  .openapi('DecideImportExceptionRequest');
export type DecideImportExceptionInput = z.infer<typeof DecideImportExceptionBody>;

export const ExternalMappingSchema = z
  .object({
    id: z.uuid(),
    sourceSystem: z.string(),
    entityType: ImportEntityTypeSchema,
    externalId: z.string(),
    status: z.enum(['pending', 'linked']),
    internalId: z.uuid().nullable(),
    firstSeenBatchId: z.uuid(),
    lastSeenBatchId: z.uuid(),
    provenance: z.record(z.string(), z.unknown()),
    linkedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('ExternalMapping');
export type ExternalMapping = z.infer<typeof ExternalMappingSchema>;

export const ListExternalMappingsQuery = PageRequestSchema.extend({
  sourceSystem: SourceSystem.optional(),
  entityType: ImportEntityTypeSchema.optional(),
  externalId: ExternalId.optional(),
  internalId: z.uuid().optional(),
});
export type ListExternalMappingsQuery = z.infer<typeof ListExternalMappingsQuery>;

// ---------------------------------------------------------------------------------------------
// Authority matrix (§5.6, §4.7 invariant 11)
// ---------------------------------------------------------------------------------------------

export const AuthorityScopeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('organization') }).strict(),
    z.object({ kind: z.literal('facility'), facilityId: z.uuid() }).strict(),
    z.object({ kind: z.literal('program'), programId: z.uuid() }).strict(),
    z.object({ kind: z.literal('competition'), competitionId: z.uuid() }).strict(),
  ])
  .openapi('AuthorityScope');
export type AuthorityScope = z.infer<typeof AuthorityScopeSchema>;

export const AuthorityAssignmentSchema = z
  .object({
    id: z.uuid(),
    recordCategory: ImportEntityTypeSchema,
    scope: AuthorityScopeSchema,
    authoritativeSystem: AuthoritativeSystemSchema,
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
    reason: z.string(),
    policyReferences: z.array(z.string()),
    approvedBy: ActorSnapshotSchema,
    supersedesAssignmentId: z.uuid().nullable(),
    endedAt: Instant.nullable(),
    endReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('AuthorityAssignment');
export type AuthorityAssignment = z.infer<typeof AuthorityAssignmentSchema>;

export const CreateAuthorityAssignmentBody = withCommandMeta({
  recordCategory: ImportEntityTypeSchema,
  scope: AuthorityScopeSchema.default({ kind: 'organization' }),
  authoritativeSystem: AuthoritativeSystemSchema,
  /** Defaults to now; authority is never assigned retroactively (§4.7 invariant 9). */
  effectiveFrom: Instant.optional(),
  effectiveTo: Instant.optional(),
  /** The assignment in effect at `effectiveFrom`, ended there by this transfer (§4.9 stale edits). */
  supersedes: z.object({ assignmentId: z.uuid(), expectedRevision: Revision }).strict().optional(),
})
  .extend({ reason: Reason })
  .strict()
  .openapi('CreateAuthorityAssignmentRequest');
export type CreateAuthorityAssignmentInput = z.infer<typeof CreateAuthorityAssignmentBody>;

export const EndAuthorityAssignmentBody = withCommandMeta({
  /** Defaults to now; never in the past. */
  effectiveTo: Instant.optional(),
})
  .extend({ reason: Reason, expectedRevision: Revision })
  .strict()
  .openapi('EndAuthorityAssignmentRequest');
export type EndAuthorityAssignmentInput = z.infer<typeof EndAuthorityAssignmentBody>;

export const ListAuthorityAssignmentsQuery = PageRequestSchema.extend({
  recordCategory: ImportEntityTypeSchema.optional(),
  /** Only assignments in effect at this instant. */
  at: Instant.optional(),
});
export type ListAuthorityAssignmentsQuery = z.infer<typeof ListAuthorityAssignmentsQuery>;

export const AuthorityMatrixQuery = z.object({
  at: Instant.optional(),
  facilityId: z.uuid().optional(),
  programId: z.uuid().optional(),
  competitionId: z.uuid().optional(),
});
export type AuthorityMatrixQuery = z.infer<typeof AuthorityMatrixQuery>;

export const AuthorityResolutionSchema = z
  .object({
    recordCategory: ImportEntityTypeSchema,
    authoritativeSystem: AuthoritativeSystemSchema,
    /** `assignment`: the most specific assignment in effect; `default`: none (SportsPark). */
    basis: z.enum(['assignment', 'default', 'conflict']),
    assignmentId: z.uuid().nullable(),
    scope: AuthorityScopeSchema.nullable(),
    effectiveFrom: Instant.nullable(),
    effectiveTo: Instant.nullable(),
  })
  .openapi('AuthorityResolution');
export type AuthorityResolution = z.infer<typeof AuthorityResolutionSchema>;

export const AuthorityMatrixSchema = z
  .object({
    at: Instant,
    facilityId: z.uuid().nullable(),
    programId: z.uuid().nullable(),
    competitionId: z.uuid().nullable(),
    entries: z.array(AuthorityResolutionSchema),
  })
  .openapi('AuthorityMatrix');
export type AuthorityMatrix = z.infer<typeof AuthorityMatrixSchema>;

// ---------------------------------------------------------------------------------------------
// Reconciliation (§5.5)
// ---------------------------------------------------------------------------------------------

export const MigrationDiscrepancySchema = z
  .object({
    id: z.uuid(),
    level: ReconciliationLevelSchema,
    area: ReconciliationAreaSchema,
    entityType: ImportEntityTypeSchema,
    code: z.string(),
    externalId: z.string().nullable(),
    internalId: z.uuid().nullable(),
    expected: z.unknown().nullable(),
    actual: z.unknown().nullable(),
    currency: z.string().nullable(),
    differenceMinor: z.number().int().nullable(),
    countDifference: z.number().int().nullable(),
    details: z.record(z.string(), z.unknown()),
  })
  .openapi('MigrationDiscrepancy');
export type MigrationDiscrepancy = z.infer<typeof MigrationDiscrepancySchema>;

export const MigrationReconciliationApprovalSchema = z
  .object({
    area: ReconciliationAreaSchema,
    decision: z.enum(['approved', 'rejected']),
    approverPersonId: z.uuid(),
    approverRole: StaffRole,
    reason: z.string().nullable(),
    acknowledgedDiscrepancies: z.number().int(),
    decidedAt: Instant,
  })
  .openapi('MigrationReconciliationApproval');

export const MigrationReconciliationReportSchema = z
  .object({
    id: z.uuid(),
    batchId: z.uuid(),
    generatedAt: Instant,
    generatedBy: ActorSnapshotSchema,
    status: z.enum(['balanced', 'discrepancy']),
    levels: z.array(
      z.object({
        level: ReconciliationLevelSchema,
        status: z.enum(['balanced', 'discrepancy']),
        checked: z.number().int(),
        discrepancyCount: z.number().int(),
      }),
    ),
    discrepancyCount: z.number().int(),
    requiredAreas: z.array(ReconciliationAreaSchema),
    approvalStatus: z.enum(['pending', 'approved', 'rejected', 'superseded']),
    approvals: z.array(MigrationReconciliationApprovalSchema),
    discrepancies: z.array(MigrationDiscrepancySchema),
    supersededByReportId: z.uuid().nullable(),
    revision: Revision,
  })
  .openapi('MigrationReconciliationReport');
export type MigrationReconciliationReport = z.infer<typeof MigrationReconciliationReportSchema>;

/** GET /import-batches/{id}/reconciliation-reports: every report of the batch, newest first. */
export const MigrationReconciliationReportListSchema = z
  .object({ items: z.array(MigrationReconciliationReportSchema) })
  .openapi('MigrationReconciliationReportList');
export type MigrationReconciliationReportList = z.infer<
  typeof MigrationReconciliationReportListSchema
>;

export const GenerateReconciliationBody = withCommandMeta({})
  .strict()
  .openapi('GenerateMigrationReconciliationRequest');
export type GenerateReconciliationInput = z.infer<typeof GenerateReconciliationBody>;

export const ApproveReconciliationBody = withCommandMeta({
  area: ReconciliationAreaSchema,
  decision: z.enum(['approved', 'rejected']),
})
  .strict()
  .openapi('ApproveMigrationReconciliationRequest');
export type ApproveReconciliationInput = z.infer<typeof ApproveReconciliationBody>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

const IdParams = z.object({ id: z.uuid() });
const TAG = 'Migration';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });

function command(
  path: string,
  summary: string,
  body: z.ZodType,
  response: z.ZodType,
  status = 201,
) {
  openApiRegistry.registerPath({
    method: 'post',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotencyHeader,
      body: { content: { 'application/json': { schema: body } } },
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied, or the record category is still maintained in the legacy system'),
      404: err('Not found or not visible'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
    },
  });
}

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape> | null,
  response: z.ZodType,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      query: request ?? undefined,
    },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

command(
  '/import-batches',
  'Stage a source snapshot as an import batch (neutral JSON/CSV staging contract, §5.3/§5.4)',
  CreateImportBatchBody,
  ImportBatchSchema,
);
query(
  '/import-batches',
  'List import batches, newest first (cursor paging)',
  ListImportBatchesQuery,
  pageSchema(ImportBatchSchema),
);
query('/import-batches/{id}', 'Read an import batch with its counts', null, ImportBatchSchema);
command(
  '/import-batches/{id}/rows',
  'Append a chunk of staged rows to a received batch',
  AppendImportRowsBody,
  ImportBatchSchema,
  200,
);
query(
  '/import-batches/{id}/rows',
  'List staged rows with outcomes',
  ListImportRowsQuery,
  pageSchema(ImportRowSchema),
);
command(
  '/import-batches/{id}/validate',
  'Seal and dry-run the batch: planned outcomes; ambiguity and conflicts enter review queues (§5.4)',
  ValidateImportBatchBody,
  ImportBatchSchema,
  200,
);
command(
  '/import-batches/{id}/review',
  'Complete the review once every exception is decided',
  ReviewImportBatchBody,
  ImportBatchSchema,
  200,
);
command(
  '/import-batches/{id}/apply',
  'Apply the batch through the owning modules (idempotent per external id; never charges or notifies, §5.4, SPK-AT-024)',
  ApplyImportBatchBody,
  ImportBatchSchema,
  200,
);
command(
  '/import-batches/{id}/abort',
  'Abort a batch before any apply started',
  AbortImportBatchBody,
  ImportBatchSchema,
  200,
);
query(
  '/import-exceptions',
  'Import review queue (ambiguous relationships and balances, conflicts, validation errors), newest first (cursor paging)',
  ListImportExceptionsQuery,
  pageSchema(ImportExceptionSchema),
);
command(
  '/import-exceptions/{id}/decide',
  'Record a review decision (accept, reject or defer) with a reason',
  DecideImportExceptionBody,
  ImportExceptionSchema,
  200,
);
query(
  '/external-mappings',
  'Look up external identifiers mapped to internal records, newest first (cursor paging)',
  ListExternalMappingsQuery,
  pageSchema(ExternalMappingSchema),
);
command(
  '/import-batches/{id}/reconciliation-reports',
  'Reconcile an applied batch at the four §5.5 levels (discrepancies are never netted)',
  GenerateReconciliationBody,
  MigrationReconciliationReportSchema,
);
query(
  '/import-batches/{id}/reconciliation-reports',
  'List the reconciliation reports of a batch, newest first; the batch names the latest (§5.5)',
  null,
  MigrationReconciliationReportListSchema,
);
query(
  '/import-reconciliation-reports/{id}',
  'Read a reconciliation report with its discrepancies and approvals',
  null,
  MigrationReconciliationReportSchema,
);
command(
  '/import-reconciliation-reports/{id}/approvals',
  'Approve or reject one area of a reconciliation report (finance, participation, schedule, identity)',
  ApproveReconciliationBody,
  MigrationReconciliationReportSchema,
  200,
);
query(
  '/authority-assignments',
  'List the authority matrix assignments, newest first (cursor paging, §5.6)',
  ListAuthorityAssignmentsQuery,
  pageSchema(AuthorityAssignmentSchema),
);
query(
  '/authority-assignments/{id}',
  'Read an authority assignment',
  null,
  AuthorityAssignmentSchema,
);
command(
  '/authority-assignments',
  'Assign or transfer the authoritative system for a record category and scope (one authority per instant, §4.7 invariant 11)',
  CreateAuthorityAssignmentBody,
  AuthorityAssignmentSchema,
);
command(
  '/authority-assignments/{id}/end',
  'End an authority assignment (never retroactively)',
  EndAuthorityAssignmentBody,
  AuthorityAssignmentSchema,
  200,
);
query(
  '/authority-matrix',
  'Resolve the authoritative system for every record category at a scope and instant',
  AuthorityMatrixQuery,
  AuthorityMatrixSchema,
);

import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { StaffRole } from '../principal';
import { Instant } from '../time';
import {
  EligibilitySeveritySchema,
  FixtureStatusSchema,
  TeamEntryStatusSchema,
  TiebreakerSchema,
} from './competition';
import { ActorSnapshotSchema } from './facilities';
import { DateOnly } from './identity';

/**
 * Competition API contract, part 2: results, standings, brackets, fixture generation, readiness,
 * disputes and discipline (specification §3.8 SPK-FIX-001..005, §3.9 SPK-READY-001..004, §3.11
 * SPK-RESULT-001..005, §3.12 SPK-DISC-001..005, §4.4 Matches and Discipline, §4.6 Result machine,
 * §4.8 `GET /v1/fixtures/{id}/readiness`, `POST /v1/fixtures/{id}/results`,
 * `POST /v1/results/{id}/publish`, SPK-STAFF-005). Organization scope always comes from the principal.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary (mirrored by the check constraints in migration 0450)
// ---------------------------------------------------------------------------------------------
export const ResultStatusSchema = z
  .enum(['draft', 'submitted', 'official', 'superseded'])
  .openapi('ResultStatus');
export type ResultStatus = z.infer<typeof ResultStatusSchema>;
/** SPK-RESULT-002: ordinary completion, forfeit, cancellation, abandonment, postponement, disputed. */
export const ResultClassificationSchema = z
  .enum(['completed', 'forfeit', 'canceled', 'abandoned', 'postponed', 'disputed'])
  .openapi('ResultClassification');
export type ResultClassification = z.infer<typeof ResultClassificationSchema>;
export const CardKindSchema = z.enum(['yellow', 'second_yellow', 'red']).openapi('CardKind');
export type CardKind = z.infer<typeof CardKindSchema>;
export const SolverOutcomeSchema = z
  .enum(['feasible', 'proven_optimal', 'proven_infeasible', 'no_proposal_within_limit'])
  .openapi('SolverOutcome');
export type SolverOutcome = z.infer<typeof SolverOutcomeSchema>;
export const IncidentKindSchema = z
  .enum(['card', 'misconduct', 'complaint', 'operational', 'injury'])
  .openapi('IncidentKind');
export type IncidentKind = z.infer<typeof IncidentKindSchema>;
export const IncidentSeveritySchema = z
  .enum(['low', 'medium', 'high', 'critical'])
  .openapi('IncidentSeverity');
export const IncidentStatusSchema = z
  .enum(['open', 'under_review', 'closed'])
  .openapi('IncidentStatus');
export const DisciplinaryDecisionKindSchema = z
  .enum(['no_action', 'warning', 'suspension', 'other'])
  .openapi('DisciplinaryDecisionKind');
export const DisciplinaryDecisionStatusSchema = z
  .enum(['issued', 'overturned'])
  .openapi('DisciplinaryDecisionStatus');
export const SuspensionScopeSchema = z.enum(['all', 'competitions']).openapi('SuspensionScope');
export const SuspensionStatusSchema = z
  .enum(['proposed', 'active', 'served', 'overturned'])
  .openapi('SuspensionStatus');
export type SuspensionStatus = z.infer<typeof SuspensionStatusSchema>;
export const AppealStatusSummarySchema = z
  .enum(['none', 'pending', 'granted', 'denied'])
  .openapi('AppealStatusSummary');
export const DisputeStatusSchema = z
  .enum(['submitted', 'under_review', 'decided', 'withdrawn'])
  .openapi('DisputeStatus');
export type DisputeStatus = z.infer<typeof DisputeStatusSchema>;
export const DisputeDecisionSchema = z.enum(['upheld', 'rejected']).openapi('DisputeDecision');
export const PublicationConsequenceSchema = z
  .enum(['none', 'result_stands', 'correction_required', 'replay_ordered'])
  .openapi('PublicationConsequence');
export const AppealStatusSchema = z
  .enum(['submitted', 'under_review', 'granted', 'denied', 'withdrawn'])
  .openapi('AppealStatus');
export type AppealStatus = z.infer<typeof AppealStatusSchema>;
export const ReadinessStatusSchema = z
  .enum(['ready', 'warning', 'unknown', 'blocked'])
  .openapi('ReadinessStatus');
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;

const Reason = z.string().trim().min(1).max(2000);
const Note = z.string().trim().max(4000);
const Score = z.number().int().min(0).max(999);

export const EvidenceRefSchema = z
  .object({
    kind: z.string().trim().min(1).max(50),
    reference: z.string().trim().min(1).max(500),
    description: z.string().trim().max(500).optional(),
  })
  .openapi('EvidenceRef');
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// ---------------------------------------------------------------------------------------------
// Results (SPK-RESULT-001/002/004, SPK-STAFF-005)
// ---------------------------------------------------------------------------------------------
export const ResultCardSchema = z
  .object({
    personId: z.uuid(),
    teamEntryId: z.uuid(),
    kind: CardKindSchema,
    minute: z.number().int().min(0).max(200).nullable().default(null),
  })
  .openapi('ResultCard');
export type ResultCard = z.infer<typeof ResultCardSchema>;

export const AbandonmentDetailsSchema = z
  .object({
    minutePlayed: z.number().int().min(0).max(200),
    reason: Reason,
  })
  .openapi('AbandonmentDetails');
export type AbandonmentDetails = z.infer<typeof AbandonmentDetailsSchema>;

/** An incident reported with the result (SPK-STAFF-005 "match incidents"); the narrative stays restricted. */
export const ResultIncidentInputSchema = z
  .object({
    kind: IncidentKindSchema,
    subjectPersonId: z.uuid().optional(),
    teamEntryId: z.uuid().optional(),
    severity: IncidentSeveritySchema,
    summary: z.string().trim().min(1).max(300),
    narrative: Note.optional(),
    minute: z.number().int().min(0).max(200).optional(),
    cardKind: CardKindSchema.optional(),
    evidence: z.array(EvidenceRefSchema).max(20).optional(),
  })
  .refine((i) => (i.kind === 'card') === (i.cardKind !== undefined), {
    message: 'cardKind is given exactly for card incidents',
    path: ['cardKind'],
  })
  .refine((i) => i.kind !== 'card' || i.subjectPersonId !== undefined, {
    message: 'a card names the carded person',
    path: ['subjectPersonId'],
  })
  .openapi('ResultIncidentInput');
export type ResultIncidentInput = z.infer<typeof ResultIncidentInputSchema>;

export const ResultDetailsSchema = z
  .object({
    cards: z.array(ResultCardSchema),
    abandonment: AbandonmentDetailsSchema.nullable(),
    incidentIds: z.array(z.uuid()),
    notes: z.string().nullable(),
    /** The dispute a correction answers, when any. */
    disputeId: z.uuid().nullable(),
  })
  .openapi('ResultDetails');
export type ResultDetails = z.infer<typeof ResultDetailsSchema>;

export const ResultRevisionSchema = z
  .object({
    id: z.uuid(),
    fixtureId: z.uuid(),
    revisionNo: z.number().int(),
    status: ResultStatusSchema,
    classification: ResultClassificationSchema,
    homeScore: z.number().int().nullable(),
    awayScore: z.number().int().nullable(),
    forfeitingEntryId: z.uuid().nullable(),
    details: ResultDetailsSchema,
    submittedBy: ActorSnapshotSchema,
    submittedAt: Instant.nullable(),
    returnedAt: Instant.nullable(),
    returnReason: z.string().nullable(),
    publishedBy: ActorSnapshotSchema.nullable(),
    publishedAt: Instant.nullable(),
    supersedesRevisionId: z.uuid().nullable(),
    supersededAt: Instant.nullable(),
    supersededByRevisionId: z.uuid().nullable(),
    reason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('ResultRevision');
export type ResultRevision = z.infer<typeof ResultRevisionSchema>;

const resultShape = {
  classification: ResultClassificationSchema,
  homeScore: Score.optional(),
  awayScore: Score.optional(),
  /** Required for a forfeit: the entry that forfeited. */
  forfeitingEntryId: z.uuid().optional(),
  cards: z.array(ResultCardSchema).max(60).optional(),
  incidents: z.array(ResultIncidentInputSchema).max(20).optional(),
  abandonment: AbandonmentDetailsSchema.optional(),
  notes: Note.optional(),
  /** The dispute this revision answers (corrections only). */
  disputeId: z.uuid().optional(),
};

interface ResultShapeOutput {
  classification: ResultClassification;
  homeScore?: number | undefined;
  awayScore?: number | undefined;
  forfeitingEntryId?: string | undefined;
  abandonment?: AbandonmentDetails | undefined;
}

function refineResult<T extends z.ZodType<ResultShapeOutput>>(schema: T): T {
  return schema
    .refine(
      (b) =>
        !(b.classification === 'completed' || b.classification === 'forfeit') ||
        (b.homeScore !== undefined && b.awayScore !== undefined),
      { message: 'scores are required for a completed or forfeited match', path: ['homeScore'] },
    )
    .refine((b) => b.classification !== 'forfeit' || b.forfeitingEntryId !== undefined, {
      message: 'a forfeit names the forfeiting entry',
      path: ['forfeitingEntryId'],
    })
    .refine((b) => b.classification !== 'abandoned' || b.abandonment !== undefined, {
      message: 'an abandonment carries its details',
      path: ['abandonment'],
    });
}

/**
 * `POST /v1/fixtures/{id}/results`: an assigned official or the league manager submits a result
 * revision (draft → submitted in one command). A fixture that already has an official result
 * receives a correction revision; publishing it supersedes the official one (SPK-RESULT-004).
 */
export const SubmitResultBody = refineResult(withCommandMeta(resultShape)).openapi(
  'SubmitResultRequest',
);
export type SubmitResultInput = z.infer<typeof SubmitResultBody>;

/** `POST /v1/results/{id}/submit`: resubmit a revision returned for correction (draft → submitted). */
export const ResubmitResultBody = refineResult(
  withCommandMeta(resultShape).extend({ expectedRevision: Revision }),
).openapi('ResubmitResultRequest');
export type ResubmitResultInput = z.infer<typeof ResubmitResultBody>;

/** `POST /v1/results/{id}/return`: submitted → draft with a reason. */
export const ReturnResultBody = withCommandMeta({})
  .extend({ expectedRevision: Revision, reason: Reason })
  .openapi('ReturnResultRequest');
export type ReturnResultInput = z.infer<typeof ReturnResultBody>;

/** `POST /v1/results/{id}/publish`: submitted → official; a correction requires a reason. */
export const PublishResultBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('PublishResultRequest');
export type PublishResultInput = z.infer<typeof PublishResultBody>;

export const StandingsRowSchema = z
  .object({
    position: z.number().int(),
    teamEntryId: z.uuid(),
    teamName: z.string(),
    played: z.number().int(),
    won: z.number().int(),
    drawn: z.number().int(),
    lost: z.number().int(),
    goalsFor: z.number().int(),
    goalsAgainst: z.number().int(),
    goalDifference: z.number().int(),
    points: z.number().int(),
    /** Fair-play penalty points (yellow and red cards); lower is better. */
    fairPlayPoints: z.number().int(),
    forfeits: z.number().int(),
  })
  .openapi('StandingsRow');
export type StandingsRow = z.infer<typeof StandingsRowSchema>;

/** SPK-RESULT-003: how a tie between teams on equal points was decided. */
export const TiebreakExplanationSchema = z
  .object({
    teamEntryIds: z.array(z.uuid()),
    points: z.number().int(),
    steps: z.array(
      z.object({
        /** `exhausted` when the rule set names no further tiebreaker for a remaining tie. */
        tiebreaker: z.union([TiebreakerSchema, z.literal('exhausted')]),
        outcome: z.enum(['resolved', 'partially_resolved', 'not_separating', 'unresolved']),
        values: z.array(z.object({ teamEntryId: z.uuid(), value: z.string() })),
        explanation: z.string(),
      }),
    ),
    resolved: z.boolean(),
  })
  .openapi('TiebreakExplanation');
export type TiebreakExplanation = z.infer<typeof TiebreakExplanationSchema>;

export const StandingsSchema = z
  .object({
    id: z.uuid().nullable(),
    seasonId: z.uuid(),
    divisionId: z.uuid().nullable(),
    ruleSetId: z.uuid(),
    ruleSetVersion: z.number().int(),
    computedAt: Instant,
    /** Official result revisions the table derives from (SPK-RESULT-001). */
    sourceResultIds: z.array(z.uuid()),
    rows: z.array(StandingsRowSchema),
    tiebreakExplanations: z.array(TiebreakExplanationSchema),
  })
  .openapi('Standings');
export type Standings = z.infer<typeof StandingsSchema>;

export const StandingsQuery = z.object({ divisionId: z.uuid().optional() });
export type StandingsQuery = z.infer<typeof StandingsQuery>;

export const PublishResultOutcomeSchema = z
  .object({
    revision: ResultRevisionSchema,
    /** False when the correction needs management review (SPK-RESULT-004): nothing was rewritten. */
    published: z.boolean(),
    supersededRevisionId: z.uuid().nullable(),
    reviewExceptionId: z.uuid().nullable(),
    standings: StandingsSchema.nullable(),
    operationId: z.uuid(),
  })
  .openapi('PublishResultOutcome');
export type PublishResultOutcome = z.infer<typeof PublishResultOutcomeSchema>;

// ---------------------------------------------------------------------------------------------
// Brackets (§4.4 BracketNode, SPK-AT-014)
// ---------------------------------------------------------------------------------------------
export const BracketSourceSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('seed'), seed: z.number().int().min(1) }),
    z.object({ kind: z.literal('winner_of'), nodeId: z.uuid() }),
    z.object({ kind: z.literal('loser_of'), nodeId: z.uuid() }),
    z.object({ kind: z.literal('bye') }),
  ])
  .openapi('BracketSource');
export type BracketSource = z.infer<typeof BracketSourceSchema>;

export const BracketNodeSchema = z
  .object({
    id: z.uuid(),
    seasonId: z.uuid(),
    divisionId: z.uuid().nullable(),
    name: z.string().nullable(),
    round: z.number().int(),
    slot: z.number().int(),
    sourceRule: z.object({ home: BracketSourceSchema, away: BracketSourceSchema }),
    homeEntryId: z.uuid().nullable(),
    awayEntryId: z.uuid().nullable(),
    fixtureId: z.uuid().nullable(),
    winnerEntryId: z.uuid().nullable(),
    published: z.boolean(),
    publishedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('BracketNode');
export type BracketNode = z.infer<typeof BracketNodeSchema>;

export const CreateBracketNodeBody = withCommandMeta({
  divisionId: z.uuid().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  round: z.number().int().min(1),
  slot: z.number().int().min(1),
  home: BracketSourceSchema,
  away: BracketSourceSchema,
  homeEntryId: z.uuid().optional(),
  awayEntryId: z.uuid().optional(),
  /** The fixture that plays this node, when it exists already. */
  fixtureId: z.uuid().optional(),
}).openapi('CreateBracketNodeRequest');
export type CreateBracketNodeInput = z.infer<typeof CreateBracketNodeBody>;

export const PublishBracketNodeBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('PublishBracketNodeRequest');
export type PublishBracketNodeInput = z.infer<typeof PublishBracketNodeBody>;

export const ListBracketNodesQuery = z.object({ divisionId: z.uuid().optional() });

// ---------------------------------------------------------------------------------------------
// Fixture generation (SPK-FIX-001..005)
// ---------------------------------------------------------------------------------------------
export const BlackoutSchema = z
  .object({ start: DateOnly, end: DateOnly })
  .refine((b) => b.start <= b.end, { message: 'start must not be after end' })
  .openapi('Blackout');
export type Blackout = z.infer<typeof BlackoutSchema>;

export const AllowedStartTimeSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'local time must be HH:MM'),
  })
  .openapi('AllowedStartTime');
export type AllowedStartTime = z.infer<typeof AllowedStartTimeSchema>;

/** SPK-FIX-003 fairness preferences; `hard` makes a preference a constraint (DEC-049). */
export const FairnessPreferenceKindSchema = z
  .enum([
    'home_away_balance',
    'rest_distribution',
    'no_consecutive_games',
    'early_late_distribution',
    'no_repeated_opponents',
    'preferred_availability',
  ])
  .openapi('FairnessPreferenceKind');
export type FairnessPreferenceKind = z.infer<typeof FairnessPreferenceKindSchema>;

export const FairnessPreferenceSchema = z
  .object({
    kind: FairnessPreferenceKindSchema,
    hard: z.boolean().default(false),
    weight: z.number().int().min(1).max(100).default(1),
    /** preferred_availability: entries and the weekday/time pairs they prefer. */
    teamEntryId: z.uuid().optional(),
    startTimes: z.array(AllowedStartTimeSchema).max(50).optional(),
  })
  .openapi('FairnessPreference');
export type FairnessPreference = z.infer<typeof FairnessPreferenceSchema>;

export const PlayoffStructureSchema = z
  .object({
    kind: z.enum(['single_elimination']),
    /** Entries that qualify (2, 4, 8 …). */
    teams: z.number().int().min(2).max(64),
  })
  .openapi('PlayoffStructure');
export type PlayoffStructure = z.infer<typeof PlayoffStructureSchema>;

export const FixtureSpecificationSchema = z
  .object({
    id: z.uuid(),
    seasonId: z.uuid(),
    divisionId: z.uuid(),
    facilityId: z.uuid(),
    name: z.string(),
    teamEntryIds: z.array(z.uuid()),
    gamesPerTeam: z.number().int(),
    opponentFrequency: z.number().int(),
    startsOn: DateOnly,
    endsOn: DateOnly,
    blackouts: z.array(BlackoutSchema),
    byesAllowed: z.boolean(),
    minimumRestMinutes: z.number().int(),
    allowedStartTimes: z.array(AllowedStartTimeSchema),
    matchDurationMinutes: z.number().int(),
    requiredResourceIds: z.array(z.uuid()),
    playoffStructure: PlayoffStructureSchema.nullable(),
    fairnessPreferences: z.array(FairnessPreferenceSchema),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('FixtureSpecification');
export type FixtureSpecification = z.infer<typeof FixtureSpecificationSchema>;

export const CreateFixtureSpecificationBody = withCommandMeta({
  name: z.string().trim().min(1).max(200),
  facilityId: z.uuid(),
  gamesPerTeam: z.number().int().min(1).max(100),
  opponentFrequency: z.number().int().min(1).max(10).default(1),
  startsOn: DateOnly,
  endsOn: DateOnly,
  blackouts: z.array(BlackoutSchema).max(100).default([]),
  byesAllowed: z.boolean().default(true),
  minimumRestMinutes: z
    .number()
    .int()
    .min(0)
    .max(14 * 24 * 60)
    .default(0),
  allowedStartTimes: z.array(AllowedStartTimeSchema).min(1).max(200),
  /** Defaults to the rule set's match length plus the resource turnover. */
  matchDurationMinutes: z.number().int().min(10).max(300).optional(),
  requiredResourceIds: z.array(z.uuid()).min(1).max(20),
  playoffStructure: PlayoffStructureSchema.optional(),
  fairnessPreferences: z.array(FairnessPreferenceSchema).max(20).default([]),
})
  .refine((b) => b.startsOn <= b.endsOn, { message: 'startsOn must not be after endsOn' })
  .openapi('CreateFixtureSpecificationRequest');
export type CreateFixtureSpecificationInput = z.infer<typeof CreateFixtureSpecificationBody>;

export const SearchSettingsSchema = z
  .object({
    /** Candidate orderings tried before the search stops (SPK-FIX-004 search limit). */
    maxCandidates: z.number().int().min(1).max(500).default(40),
    timeLimitMs: z.number().int().min(10).max(60_000).default(2_000),
    seed: z.number().int().min(0).default(1),
  })
  .openapi('SearchSettings');
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;

export const GenerateFixturesBody = withCommandMeta({
  searchSettings: SearchSettingsSchema.default({ maxCandidates: 40, timeLimitMs: 2_000, seed: 1 }),
  /** Compute and record the run without creating fixtures or a schedule draft. */
  dryRun: z.boolean().default(false),
  draftName: z.string().trim().min(1).max(200).optional(),
}).openapi('GenerateFixturesRequest');
export type GenerateFixturesInput = z.infer<typeof GenerateFixturesBody>;

export const ProposedGameSchema = z
  .object({
    key: z.string(),
    round: z.number().int(),
    homeEntryId: z.uuid(),
    /** Null for a bye. */
    awayEntryId: z.uuid().nullable(),
    fixtureId: z.uuid().nullable(),
    scheduledStart: Instant.nullable(),
    scheduledEnd: Instant.nullable(),
    resourceId: z.uuid().nullable(),
  })
  .openapi('ProposedGame');
export type ProposedGame = z.infer<typeof ProposedGameSchema>;

export const ConstraintViolationSchema = z
  .object({
    constraint: z.string(),
    hard: z.boolean(),
    message: z.string(),
    gameKeys: z.array(z.string()),
  })
  .openapi('ConstraintViolation');
export type ConstraintViolation = z.infer<typeof ConstraintViolationSchema>;

export const PreferenceScoreSchema = z
  .object({
    kind: FairnessPreferenceKindSchema,
    hard: z.boolean(),
    weight: z.number().int(),
    penalty: z.number(),
    explanation: z.string(),
  })
  .openapi('PreferenceScore');
export type PreferenceScore = z.infer<typeof PreferenceScoreSchema>;

export const CompletenessIssueSchema = z
  .object({
    code: z.enum([
      'missing_fixture',
      'duplicate_fixture',
      'excess_games',
      'unscheduled_game',
      'opponent_frequency',
      'invalid_bye',
      'playoff_unfulfilled',
      'games_per_team_mismatch',
    ]),
    message: z.string(),
    teamEntryIds: z.array(z.uuid()),
    gameKeys: z.array(z.string()),
  })
  .openapi('CompletenessIssue');
export type CompletenessIssue = z.infer<typeof CompletenessIssueSchema>;

/** SPK-FIX-002: remaining obligations after a partial result, with owner and deadline. */
export const RemainingObligationSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    owner: z.string(),
    deadline: Instant.nullable(),
    gameKeys: z.array(z.string()),
  })
  .openapi('RemainingObligation');
export type RemainingObligation = z.infer<typeof RemainingObligationSchema>;

export const CompletenessReportSchema = z
  .object({
    complete: z.boolean(),
    expectedGames: z.number().int(),
    proposedGames: z.number().int(),
    scheduledGames: z.number().int(),
    byes: z.array(z.object({ teamEntryId: z.uuid(), count: z.number().int() })),
    issues: z.array(CompletenessIssueSchema),
    remainingObligations: z.array(RemainingObligationSchema),
  })
  .openapi('CompletenessReport');
export type CompletenessReport = z.infer<typeof CompletenessReportSchema>;

export const SolverExplanationSchema = z
  .object({
    hardViolations: z.array(ConstraintViolationSchema),
    preferenceScores: z.array(PreferenceScoreSchema),
    totalPenalty: z.number(),
    candidatesTried: z.number().int(),
    stoppedBy: z.enum(['exhausted', 'candidate_limit', 'time_limit', 'proof']),
    /** Why the outcome is what it is, in plain words (SPK-AT-011). */
    summary: z.string(),
  })
  .openapi('SolverExplanation');
export type SolverExplanation = z.infer<typeof SolverExplanationSchema>;

export const SolverRunSchema = z
  .object({
    id: z.uuid(),
    specificationId: z.uuid(),
    ruleSetId: z.uuid(),
    searchSettings: SearchSettingsSchema,
    outcome: SolverOutcomeSchema,
    proposal: z.object({ games: z.array(ProposedGameSchema) }).nullable(),
    completenessReport: CompletenessReportSchema,
    explanation: SolverExplanationSchema,
    dryRun: z.boolean(),
    /** The scheduling draft holding the proposal; never published here (SPK-FIX-005). */
    scheduleDraftId: z.uuid().nullable(),
    fixtureIds: z.array(z.uuid()),
    operationId: z.uuid().nullable(),
    startedAt: Instant,
    finishedAt: Instant,
    createdAt: Instant,
  })
  .openapi('SolverRun');
export type SolverRun = z.infer<typeof SolverRunSchema>;

// ---------------------------------------------------------------------------------------------
// Readiness (SPK-READY-001..004, §4.8 GET /v1/fixtures/{id}/readiness)
// ---------------------------------------------------------------------------------------------
export const FixtureReadinessIssueSchema = z
  .object({
    code: z.string(),
    severity: EligibilitySeveritySchema,
    message: z.string(),
    source: z.object({ type: z.string(), id: z.string().nullable() }),
    responsibleRole: z.string(),
    requiredAction: z.string(),
    lastEvaluatedAt: Instant,
    deadline: Instant.nullable(),
  })
  .openapi('FixtureReadinessIssue');
export type FixtureReadinessIssue = z.infer<typeof FixtureReadinessIssueSchema>;

export const ReadinessCheckOutcomeSchema = z
  .object({
    name: z.string(),
    status: ReadinessStatusSchema,
    issueCount: z.number().int(),
  })
  .openapi('ReadinessCheckOutcome');

export const FixtureReadinessSchema = z
  .object({
    fixtureId: z.uuid(),
    fixtureStatus: FixtureStatusSchema,
    status: ReadinessStatusSchema,
    evaluatedAt: Instant,
    scheduledStart: Instant.nullable(),
    checks: z.array(ReadinessCheckOutcomeSchema),
    issues: z.array(FixtureReadinessIssueSchema),
    sides: z.array(
      z.object({
        teamEntryId: z.uuid(),
        teamName: z.string(),
        entryStatus: TeamEntryStatusSchema,
        rosterSize: z.number().int(),
        eligiblePlayers: z.number().int(),
        unknownPlayers: z.number().int(),
        minimumPlayers: z.number().int(),
      }),
    ),
  })
  .openapi('FixtureReadiness');
export type FixtureReadiness = z.infer<typeof FixtureReadinessSchema>;

// ---------------------------------------------------------------------------------------------
// Disputes (SPK-RESULT-005)
// ---------------------------------------------------------------------------------------------
export const DisputeSchema = z
  .object({
    id: z.uuid(),
    fixtureId: z.uuid(),
    resultRevisionId: z.uuid().nullable(),
    submittingTeamEntryId: z.uuid().nullable(),
    submittingRole: z.string(),
    submittedBy: ActorSnapshotSchema,
    submittedAt: Instant,
    submissionDeadlineAt: Instant,
    reason: z.string(),
    evidence: z.array(EvidenceRefSchema),
    status: DisputeStatusSchema,
    reviewer: ActorSnapshotSchema.nullable(),
    decision: DisputeDecisionSchema.nullable(),
    decidedAt: Instant.nullable(),
    decisionReason: z.string().nullable(),
    publicationConsequence: PublicationConsequenceSchema.nullable(),
    appealStatus: AppealStatusSummarySchema,
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Dispute');
export type Dispute = z.infer<typeof DisputeSchema>;

export const CreateDisputeBody = withCommandMeta({
  /** Captains name the entry they dispute for; staff may omit it. */
  teamEntryId: z.uuid().optional(),
  resultRevisionId: z.uuid().optional(),
  evidence: z.array(EvidenceRefSchema).max(20).default([]),
})
  .extend({ reason: Reason })
  .openapi('CreateDisputeRequest');
export type CreateDisputeInput = z.infer<typeof CreateDisputeBody>;

export const DecideDisputeBody = withCommandMeta({
  action: z.enum(['review', 'decide', 'withdraw']),
  decision: DisputeDecisionSchema.optional(),
  publicationConsequence: PublicationConsequenceSchema.optional(),
})
  .extend({ expectedRevision: Revision })
  .refine(
    (b) =>
      b.action !== 'decide' ||
      (b.decision !== undefined && b.publicationConsequence !== undefined && !!b.reason),
    {
      message: 'a decision names its outcome, publication consequence and reason',
      path: ['decision'],
    },
  )
  .openapi('DecideDisputeRequest');
export type DecideDisputeInput = z.infer<typeof DecideDisputeBody>;

// ---------------------------------------------------------------------------------------------
// Discipline (SPK-DISC-001..005)
// ---------------------------------------------------------------------------------------------
/** Restricted view (league management): includes the narrative (SPK-DISC-004). */
export const IncidentSchema = z
  .object({
    id: z.uuid(),
    kind: IncidentKindSchema,
    fixtureId: z.uuid().nullable(),
    seasonId: z.uuid().nullable(),
    competitionId: z.uuid().nullable(),
    subjectPersonId: z.uuid().nullable(),
    teamEntryId: z.uuid().nullable(),
    resultRevisionId: z.uuid().nullable(),
    occurredAt: Instant,
    minute: z.number().int().nullable(),
    cardKind: CardKindSchema.nullable(),
    severity: IncidentSeveritySchema,
    summary: z.string(),
    narrative: z.string().nullable(),
    evidence: z.array(EvidenceRefSchema),
    reportedBy: ActorSnapshotSchema,
    status: IncidentStatusSchema,
    closedAt: Instant.nullable(),
    closureNote: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Incident');
export type Incident = z.infer<typeof IncidentSchema>;

export const CreateIncidentBody = withCommandMeta({
  kind: IncidentKindSchema,
  fixtureId: z.uuid().optional(),
  seasonId: z.uuid().optional(),
  competitionId: z.uuid().optional(),
  subjectPersonId: z.uuid().optional(),
  teamEntryId: z.uuid().optional(),
  occurredAt: Instant.optional(),
  minute: z.number().int().min(0).max(200).optional(),
  cardKind: CardKindSchema.optional(),
  severity: IncidentSeveritySchema,
  summary: z.string().trim().min(1).max(300),
  /** Restricted narrative: operational facts only, never diagnosis (SPK-DISC-005). */
  narrative: Note.optional(),
  evidence: z.array(EvidenceRefSchema).max(20).default([]),
})
  .refine((i) => (i.kind === 'card') === (i.cardKind !== undefined), {
    message: 'cardKind is given exactly for card incidents',
    path: ['cardKind'],
  })
  .refine((i) => i.kind !== 'card' || i.subjectPersonId !== undefined, {
    message: 'a card names the carded person',
    path: ['subjectPersonId'],
  })
  .openapi('CreateIncidentRequest');
export type CreateIncidentInput = z.infer<typeof CreateIncidentBody>;

export const UpdateIncidentBody = withCommandMeta({
  action: z.enum(['review', 'close']),
  closureNote: Note.optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateIncidentRequest');
export type UpdateIncidentInput = z.infer<typeof UpdateIncidentBody>;

export const ListIncidentsQuery = z.object({
  fixtureId: z.uuid().optional(),
  seasonId: z.uuid().optional(),
  subjectPersonId: z.uuid().optional(),
  status: IncidentStatusSchema.optional(),
});
export type ListIncidentsQuery = z.infer<typeof ListIncidentsQuery>;

export const DisciplinaryDecisionSchema = z
  .object({
    id: z.uuid(),
    incidentId: z.uuid().nullable(),
    subjectPersonId: z.uuid(),
    ruleSetId: z.uuid().nullable(),
    basis: z.string(),
    decision: DisciplinaryDecisionKindSchema,
    details: z.record(z.string(), z.unknown()),
    decidedBy: ActorSnapshotSchema,
    decidedAt: Instant,
    status: DisciplinaryDecisionStatusSchema,
    overturnedAt: Instant.nullable(),
    overturnReason: z.string().nullable(),
    /** The suspension the decision created, when it is a suspension. */
    suspensionId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('DisciplinaryDecision');
export type DisciplinaryDecision = z.infer<typeof DisciplinaryDecisionSchema>;

export const SuspensionTermsSchema = z
  .object({
    scope: SuspensionScopeSchema,
    competitionIds: z.array(z.uuid()).max(50).default([]),
    effectiveFrom: Instant.optional(),
    effectiveTo: Instant.optional(),
    matchCount: z.number().int().min(1).max(100).optional(),
    completionCriteria: z.string().trim().min(1).max(2000),
  })
  .refine((s) => s.matchCount !== undefined || s.effectiveFrom !== undefined, {
    message: 'a suspension states an effective period or a match count',
    path: ['matchCount'],
  })
  .refine((s) => s.scope !== 'competitions' || s.competitionIds.length > 0, {
    message: 'a competition-scoped suspension names its competitions',
    path: ['competitionIds'],
  })
  .refine(
    (s) =>
      s.effectiveFrom === undefined ||
      s.effectiveTo === undefined ||
      new Date(s.effectiveFrom) < new Date(s.effectiveTo),
    { message: 'effectiveFrom must be before effectiveTo', path: ['effectiveTo'] },
  )
  .openapi('SuspensionTerms');
export type SuspensionTerms = z.infer<typeof SuspensionTermsSchema>;

export const CreateDisciplinaryDecisionBody = withCommandMeta({
  incidentId: z.uuid().optional(),
  subjectPersonId: z.uuid(),
  /** The approved rule-set version the decision applies (SPK-DISC-003). */
  ruleSetId: z.uuid().optional(),
  basis: Reason,
  decision: DisciplinaryDecisionKindSchema,
  details: z.record(z.string(), z.unknown()).optional(),
  /** Required when the decision is a suspension: creates it in `proposed` state. */
  suspension: SuspensionTermsSchema.optional(),
})
  .refine((b) => (b.decision === 'suspension') === (b.suspension !== undefined), {
    message: 'suspension terms are given exactly for a suspension decision',
    path: ['suspension'],
  })
  .openapi('CreateDisciplinaryDecisionRequest');
export type CreateDisciplinaryDecisionInput = z.infer<typeof CreateDisciplinaryDecisionBody>;

export const OverturnDecisionBody = withCommandMeta({})
  .extend({ expectedRevision: Revision, reason: Reason })
  .openapi('OverturnDecisionRequest');
export type OverturnDecisionInput = z.infer<typeof OverturnDecisionBody>;

export const SuspensionSchema = z
  .object({
    id: z.uuid(),
    subjectPersonId: z.uuid(),
    decisionId: z.uuid().nullable(),
    basis: z.string(),
    scope: SuspensionScopeSchema,
    competitionIds: z.array(z.uuid()),
    effectiveFrom: Instant.nullable(),
    effectiveTo: Instant.nullable(),
    matchCount: z.number().int().nullable(),
    matchesServed: z.number().int(),
    servedFixtureIds: z.array(z.uuid()),
    completionCriteria: z.string(),
    status: SuspensionStatusSchema,
    approvedBy: ActorSnapshotSchema.nullable(),
    approvedAt: Instant.nullable(),
    appealStatus: AppealStatusSummarySchema,
    overturnedAt: Instant.nullable(),
    overturnReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Suspension');
export type Suspension = z.infer<typeof SuspensionSchema>;

export const CreateSuspensionBody = withCommandMeta({
  subjectPersonId: z.uuid(),
  decisionId: z.uuid().optional(),
  basis: Reason,
  terms: SuspensionTermsSchema,
}).openapi('CreateSuspensionRequest');
export type CreateSuspensionInput = z.infer<typeof CreateSuspensionBody>;

export const UpdateSuspensionBody = withCommandMeta({
  action: z.enum(['approve', 'overturn']),
})
  .extend({ expectedRevision: Revision })
  .refine((b) => b.action !== 'overturn' || !!b.reason, {
    message: 'overturning requires a reason',
    path: ['reason'],
  })
  .openapi('UpdateSuspensionRequest');
export type UpdateSuspensionInput = z.infer<typeof UpdateSuspensionBody>;

export const ListSuspensionsQuery = z.object({
  subjectPersonId: z.uuid().optional(),
  status: SuspensionStatusSchema.optional(),
});
export type ListSuspensionsQuery = z.infer<typeof ListSuspensionsQuery>;

export const AppealSchema = z
  .object({
    id: z.uuid(),
    subjectPersonId: z.uuid(),
    decisionId: z.uuid().nullable(),
    suspensionId: z.uuid().nullable(),
    disputeId: z.uuid().nullable(),
    grounds: z.string(),
    evidence: z.array(EvidenceRefSchema),
    submittedBy: ActorSnapshotSchema,
    submittedAt: Instant,
    status: AppealStatusSchema,
    reviewer: ActorSnapshotSchema.nullable(),
    decidedAt: Instant.nullable(),
    decisionReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Appeal');
export type Appeal = z.infer<typeof AppealSchema>;

export const CreateAppealBody = withCommandMeta({
  decisionId: z.uuid().optional(),
  suspensionId: z.uuid().optional(),
  disputeId: z.uuid().optional(),
  /** The person the appeal is made for; a guardian or captain may appeal for them. Staff name them. */
  subjectPersonId: z.uuid().optional(),
  grounds: Reason,
  evidence: z.array(EvidenceRefSchema).max(20).default([]),
})
  .refine(
    (b) => [b.decisionId, b.suspensionId, b.disputeId].filter((v) => v !== undefined).length === 1,
    { message: 'give exactly one of decisionId, suspensionId or disputeId', path: ['decisionId'] },
  )
  .openapi('CreateAppealRequest');
export type CreateAppealInput = z.infer<typeof CreateAppealBody>;

export const DecideAppealBody = withCommandMeta({
  action: z.enum(['review', 'grant', 'deny', 'withdraw']),
})
  .extend({ expectedRevision: Revision })
  .refine((b) => !(b.action === 'grant' || b.action === 'deny') || !!b.reason, {
    message: 'an appeal decision requires a reason',
    path: ['reason'],
  })
  .openapi('DecideAppealRequest');
export type DecideAppealInput = z.infer<typeof DecideAppealBody>;

/** Roles the proposed defaults let publish; the rule set's `resultApproval.approveRoles` adds to them (DEC-065). */
export const ResultPublicationRolesSchema = z.array(StaffRole);

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const TAG = 'Competition';
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
  method: 'post' | 'patch',
  path: string,
  summary: string,
  body: z.ZodType | null,
  response: z.ZodType,
  status = 201,
) {
  openApiRegistry.registerPath({
    method,
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotencyHeader,
      body: body ? { content: { 'application/json': { schema: body } } } : undefined,
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied'),
      404: err('Not found or not visible'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
      422: err('Eligibility failed'),
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
  'post',
  '/fixtures/{id}/results',
  'Submit a result revision (§4.8, SPK-STAFF-005, SPK-RESULT-001)',
  SubmitResultBody,
  ResultRevisionSchema,
);
query(
  '/fixtures/{id}/results',
  'List the result revisions of a fixture',
  null,
  z.array(ResultRevisionSchema),
);
query('/results/{id}', 'Read a result revision', null, ResultRevisionSchema);
command(
  'post',
  '/results/{id}/submit',
  'Resubmit a returned result revision',
  ResubmitResultBody,
  ResultRevisionSchema,
  200,
);
command(
  'post',
  '/results/{id}/return',
  'Return a submitted result for correction',
  ReturnResultBody,
  ResultRevisionSchema,
  200,
);
command(
  'post',
  '/results/{id}/publish',
  'Make an approved result official and recalculate standings (§4.8, SPK-RESULT-004)',
  PublishResultBody,
  PublishResultOutcomeSchema,
  200,
);
query(
  '/seasons/{id}/standings',
  'Official standings with tiebreak explanations (SPK-RESULT-003)',
  StandingsQuery,
  StandingsSchema,
);

command(
  'post',
  '/seasons/{id}/bracket-nodes',
  'Create a bracket node',
  CreateBracketNodeBody,
  BracketNodeSchema,
);
query(
  '/seasons/{id}/bracket-nodes',
  'List bracket nodes',
  ListBracketNodesQuery,
  z.array(BracketNodeSchema),
);
command(
  'post',
  '/bracket-nodes/{id}/publish',
  'Publish a bracket node',
  PublishBracketNodeBody,
  BracketNodeSchema,
  200,
);

command(
  'post',
  '/divisions/{id}/fixture-specifications',
  'Define a fixture specification (SPK-FIX-001)',
  CreateFixtureSpecificationBody,
  FixtureSpecificationSchema,
);
query(
  '/fixture-specifications/{id}',
  'Read a fixture specification',
  null,
  FixtureSpecificationSchema,
);
command(
  'post',
  '/fixture-specifications/{id}/generate',
  'Generate a fixture proposal as a scheduling draft (SPK-FIX-002..005)',
  GenerateFixturesBody,
  SolverRunSchema,
);
query('/solver-runs/{id}', 'Read a solver run', null, SolverRunSchema);

query(
  '/fixtures/{id}/readiness',
  'Explain current readiness (§4.8, SPK-READY-001..004)',
  null,
  FixtureReadinessSchema,
);

command(
  'post',
  '/fixtures/{id}/disputes',
  'Submit a dispute (SPK-RESULT-005)',
  CreateDisputeBody,
  DisputeSchema,
);
query('/fixtures/{id}/disputes', 'List the disputes of a fixture', null, z.array(DisputeSchema));
query('/disputes/{id}', 'Read a dispute', null, DisputeSchema);
command(
  'post',
  '/disputes/{id}/decide',
  'Review, decide or withdraw a dispute',
  DecideDisputeBody,
  DisputeSchema,
  200,
);

command(
  'post',
  '/incidents',
  'Record a restricted incident (SPK-DISC-001/004/005)',
  CreateIncidentBody,
  IncidentSchema,
);
query(
  '/incidents',
  'List incidents (league management)',
  ListIncidentsQuery,
  z.array(IncidentSchema),
);
query('/incidents/{id}', 'Read an incident', null, IncidentSchema);
command(
  'patch',
  '/incidents/{id}',
  'Review or close an incident',
  UpdateIncidentBody,
  IncidentSchema,
  200,
);
command(
  'post',
  '/disciplinary-decisions',
  'Issue a disciplinary decision (SPK-DISC-003)',
  CreateDisciplinaryDecisionBody,
  DisciplinaryDecisionSchema,
);
query('/disciplinary-decisions/{id}', 'Read a decision', null, DisciplinaryDecisionSchema);
command(
  'post',
  '/disciplinary-decisions/{id}/overturn',
  'Overturn a decision after authorized review',
  OverturnDecisionBody,
  DisciplinaryDecisionSchema,
  200,
);
command(
  'post',
  '/suspensions',
  'Propose a suspension (SPK-DISC-002)',
  CreateSuspensionBody,
  SuspensionSchema,
);
query('/suspensions', 'List suspensions', ListSuspensionsQuery, z.array(SuspensionSchema));
query('/suspensions/{id}', 'Read a suspension', null, SuspensionSchema);
command(
  'patch',
  '/suspensions/{id}',
  'Approve or overturn a suspension',
  UpdateSuspensionBody,
  SuspensionSchema,
  200,
);
command('post', '/appeals', 'Submit an appeal', CreateAppealBody, AppealSchema);
query('/appeals/{id}', 'Read an appeal', null, AppealSchema);
command(
  'post',
  '/appeals/{id}/decide',
  'Review, grant, deny or withdraw an appeal',
  DecideAppealBody,
  AppealSchema,
  200,
);

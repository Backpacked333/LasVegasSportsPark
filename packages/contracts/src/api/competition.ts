import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { StaffRole } from '../principal';
import { Instant } from '../time';
import { ContactPointKindSchema, DateOnly, PersonKindSchema } from './identity';

/**
 * Competition API contract, part 1 (specification §3.4 SPK-COMP-001..005, §3.5 SPK-CAP-001..005,
 * §4.4 Competition and Matches, §4.8). Organization scope always comes from the principal.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary (mirrored by the check constraints in migration 0400)
// ---------------------------------------------------------------------------------------------
export const CompetitionKindSchema = z.enum(['league', 'tournament']).openapi('CompetitionKind');
export type CompetitionKind = z.infer<typeof CompetitionKindSchema>;
export const SportFormatSchema = z
  .enum(['outdoor', 'indoor_boarded', 'futsal', 'small_sided_other'])
  .openapi('SportFormat');
export type SportFormat = z.infer<typeof SportFormatSchema>;
export const CompetitionStatusSchema = z
  .enum(['draft', 'active', 'archived'])
  .openapi('CompetitionStatus');
export type CompetitionStatus = z.infer<typeof CompetitionStatusSchema>;
export const SeasonStatusSchema = z
  .enum(['draft', 'open', 'active', 'completed', 'archived'])
  .openapi('SeasonStatus');
export type SeasonStatus = z.infer<typeof SeasonStatusSchema>;
export const TeamStatusSchema = z.enum(['active', 'inactive', 'archived']).openapi('TeamStatus');
export type TeamStatus = z.infer<typeof TeamStatusSchema>;
export const TeamEntryStatusSchema = z
  .enum(['applied', 'approved', 'withdrawn', 'rejected'])
  .openapi('TeamEntryStatus');
export type TeamEntryStatus = z.infer<typeof TeamEntryStatusSchema>;
export const TeamEntryEligibilityStatusSchema = z
  .enum(['pending', 'eligible', 'ineligible', 'review_required'])
  .openapi('TeamEntryEligibilityStatus');
export const TeamRoleSchema = z.enum(['captain', 'co_captain', 'member']).openapi('TeamRole');
export type TeamRoleValue = z.infer<typeof TeamRoleSchema>;
export const RosterMembershipStatusSchema = z
  .enum(['invited', 'requested', 'active', 'removed', 'guest', 'substitute'])
  .openapi('RosterMembershipStatus');
export type RosterMembershipStatus = z.infer<typeof RosterMembershipStatusSchema>;
export const RosterPlayingStatusSchema = z
  .enum(['active', 'guest', 'substitute'])
  .openapi('RosterPlayingStatus');
export type RosterPlayingStatus = z.infer<typeof RosterPlayingStatusSchema>;
export const RosterSourceSchema = z.enum([
  'invitation',
  'join_request',
  'captain',
  'staff',
  'renewal',
  /** A paid and approved join_team registration (SPK-AT-002). */
  'registration',
  /** Created by a migration import (CMP-09, §5.3). */
  'import',
]);
export const TeamInvitationStatusSchema = z
  .enum(['pending', 'accepted', 'declined', 'revoked', 'expired'])
  .openapi('TeamInvitationStatus');
export const JoinRequestStatusSchema = z
  .enum(['pending', 'approved', 'declined', 'withdrawn'])
  .openapi('JoinRequestStatus');
export const FixtureStatusSchema = z
  .enum(['unscheduled', 'scheduled', 'played', 'forfeit', 'canceled', 'abandoned', 'postponed'])
  .openapi('FixtureStatus');
export type FixtureStatus = z.infer<typeof FixtureStatusSchema>;
export const AvailabilityStateSchema = z
  .enum(['available', 'unavailable', 'tentative', 'no_response'])
  .openapi('AvailabilityState');
export type AvailabilityState = z.infer<typeof AvailabilityStateSchema>;
/** SPK-READY-002: blocking, warning, informational, unknown or stale evidence. */
export const EligibilitySeveritySchema = z
  .enum(['blocking', 'warning', 'info', 'unknown'])
  .openapi('EligibilitySeverity');
export type EligibilitySeverity = z.infer<typeof EligibilitySeveritySchema>;

const Name = z.string().trim().min(1).max(200);
const Reason = z.string().trim().min(1).max(2000);
const Note = z.string().trim().max(2000);
const Count = z.number().int().min(0);

// ---------------------------------------------------------------------------------------------
// Rule sets (SPK-COMP-002). Every field of the requirement is present; format-specific sections
// are null unless they apply to the rule set's format (validated by assertRuleSetContentForFormat).
// ---------------------------------------------------------------------------------------------
export const SubstitutionRulesSchema = z
  .object({
    unlimited: z.boolean(),
    /** Null when unlimited. */
    maxPerMatch: Count.nullable(),
    /** Rolling ("on the fly") substitutions without a stoppage. */
    rolling: z.boolean(),
    reEntryAllowed: z.boolean(),
  })
  .refine((r) => (r.unlimited ? r.maxPerMatch === null : r.maxPerMatch !== null), {
    message: 'maxPerMatch is null exactly when substitutions are unlimited',
    path: ['maxPerMatch'],
  })
  .openapi('SubstitutionRules');

/** Age eligibility is evaluated from the date of birth at a reference date, never a stored age (§4.5). */
export const EligibilityReferenceDateSchema = z
  .discriminatedUnion('rule', [
    z.object({ rule: z.literal('season_start') }),
    z.object({ rule: z.literal('calendar_year_start') }),
    z.object({ rule: z.literal('match_date') }),
    z.object({ rule: z.literal('fixed_date'), date: DateOnly }),
  ])
  .openapi('EligibilityReferenceDate');
export type EligibilityReferenceDate = z.infer<typeof EligibilityReferenceDateSchema>;

export const MultiTeamRestrictionsSchema = z
  .object({
    /** Entries a person may be on in one season; null = unlimited. */
    maxEntriesPerSeason: z.number().int().min(1).nullable(),
    allowSameDivision: z.boolean(),
    allowCrossDivision: z.boolean(),
  })
  .openapi('MultiTeamRestrictions');

export const ScoringRulesSchema = z
  .object({
    win: Count,
    draw: Count,
    loss: Count,
    forfeitWin: Count,
    forfeitLoss: Count,
  })
  .openapi('ScoringRules');

export const OvertimeRulesSchema = z
  .object({
    enabled: z.boolean(),
    periods: z.number().int().min(1).max(4).nullable(),
    periodLengthMinutes: z.number().int().min(1).max(60).nullable(),
    goldenGoal: z.boolean(),
  })
  .refine(
    (o) =>
      o.enabled
        ? o.periods !== null && o.periodLengthMinutes !== null
        : o.periods === null && o.periodLengthMinutes === null && !o.goldenGoal,
    { message: 'overtime periods are set exactly when overtime is enabled' },
  )
  .openapi('OvertimeRules');

export const ShootoutRulesSchema = z
  .object({ enabled: z.boolean(), kicks: z.number().int().min(1).max(11).nullable() })
  .refine((s) => (s.enabled ? s.kicks !== null : s.kicks === null), {
    message: 'kicks are set exactly when a shootout is enabled',
  })
  .openapi('ShootoutRules');

export const CardRulesSchema = z
  .object({
    /** Yellow cards that trigger an accumulation suspension; null = no accumulation rule. */
    yellowAccumulationThreshold: z.number().int().min(1).nullable(),
    yellowAccumulationSuspensionMatches: Count,
    redCardSuspensionMatches: Count,
    secondYellowIsRed: z.boolean(),
    /** Timed sin bin (indoor and small-sided formats); null for outdoor. */
    sinBinMinutes: z.number().int().min(1).max(30).nullable(),
  })
  .openapi('CardRules');

export const ForfeitRulesSchema = z
  .object({
    scoreFor: Count,
    scoreAgainst: Count,
    graceMinutes: z.number().int().min(0).max(60),
    minimumPlayersToStart: z.number().int().min(1),
  })
  .openapi('ForfeitRules');

export const AbandonmentRulesSchema = z
  .object({
    /** Minutes after which an abandoned match's result stands; null = never. */
    minimumMinutesForResult: z.number().int().min(1).nullable(),
    policy: z.enum([
      'result_stands_if_minimum_played',
      'replay',
      'replay_remaining',
      'league_decision',
    ]),
  })
  .openapi('AbandonmentRules');

export const TiebreakerSchema = z.enum([
  'points',
  'head_to_head',
  'goal_difference',
  'goals_for',
  'goals_against',
  'wins',
  'fair_play',
  'draw_of_lots',
  'play_off',
]);

export const ResultApprovalRulesSchema = z
  .object({
    submitRoles: z.array(StaffRole).min(1),
    approveRoles: z.array(StaffRole).min(1),
    captainConfirmationRequired: z.boolean(),
  })
  .openapi('ResultApprovalRules');

/** Roster policy (POL-032, SPK-CAP-004): guests and substitutes never bypass eligibility. */
export const RosterPolicySchema = z
  .object({
    guestPlayersAllowed: z.boolean(),
    /** Guests on the effective roster at once; null = no limit. */
    guestMaxConcurrent: z.number().int().min(1).nullable(),
    substitutesAllowed: z.boolean(),
    /** When true a captain cannot add a guest or substitute: a league manager must (required approvals). */
    guestOrSubstituteRequiresApproval: z.boolean(),
    /** Whether a co-captain satisfies captain checks (kernel team authority). Proposed default: false. */
    coCaptainMayActAsCaptain: z.boolean(),
    /**
     * CMP-13 (SPK-COMP-005, DEC-002): the jersey numbers the competition allows. Absent or null,
     * only per-entry uniqueness applies (no range is assumed).
     */
    jerseyNumbers: z
      .object({ min: z.number().int().min(0).max(999), max: z.number().int().min(0).max(999) })
      .refine((r) => r.min <= r.max, { message: 'min must not exceed max', path: ['min'] })
      .nullable()
      .optional(),
  })
  .openapi('RosterPolicy');

export const OutdoorRulesSchema = z
  .object({ offside: z.boolean(), throwIns: z.boolean() })
  .openapi('OutdoorRules');
export const IndoorBoardedRulesSchema = z
  .object({
    wallPlayAllowed: z.boolean(),
    ceilingOutOfPlay: z.boolean(),
    flySubstitutions: z.boolean(),
  })
  .openapi('IndoorBoardedRules');
export const FutsalRulesSchema = z
  .object({
    accumulatedFoulsLimit: z.number().int().min(1),
    secondPenaltySpot: z.boolean(),
    kickIns: z.boolean(),
    timeoutsPerHalf: Count,
  })
  .openapi('FutsalRules');
export const SmallSidedOtherRulesSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    offside: z.boolean(),
    boards: z.boolean(),
  })
  .openapi('SmallSidedOtherRules');

export const RuleSetContentSchema = z
  .object({
    playersOnField: z.number().int().min(3).max(11),
    rosterMin: z.number().int().min(1),
    rosterMax: z.number().int().min(1).max(60),
    matchLengthMinutes: z.number().int().min(10).max(180),
    periods: z.number().int().min(1).max(4),
    minimumPlayers: z.number().int().min(1),
    substitutions: SubstitutionRulesSchema,
    eligibilityReferenceDate: EligibilityReferenceDateSchema,
    multiTeamRestrictions: MultiTeamRestrictionsSchema,
    scoring: ScoringRulesSchema,
    drawsAllowed: z.boolean(),
    overtime: OvertimeRulesSchema,
    shootout: ShootoutRulesSchema,
    /**
     * CMP-10 (SPK-COMP-001, DEC-002): how a drawn playoff (bracket) game is decided. Only
     * `shootout` lets a drawn bracket game name a winner on its result; absent or null, a drawn
     * playoff game names none and the bracket waits for a league decision.
     */
    tiebreak: z
      .object({ playoff: z.enum(['shootout', 'replay', 'league_decision']) })
      .nullable()
      .optional(),
    cards: CardRulesSchema,
    forfeit: ForfeitRulesSchema,
    abandonment: AbandonmentRulesSchema,
    /** Ordered: the first tiebreaker is applied first. */
    tiebreakers: z.array(TiebreakerSchema).min(1).max(9),
    protestDeadlineHours: z.number().int().min(1).max(336),
    resultApproval: ResultApprovalRulesSchema,
    roster: RosterPolicySchema,
    outdoor: OutdoorRulesSchema.nullable(),
    indoorBoarded: IndoorBoardedRulesSchema.nullable(),
    futsal: FutsalRulesSchema.nullable(),
    smallSidedOther: SmallSidedOtherRulesSchema.nullable(),
  })
  .superRefine((c, ctx) => {
    if (c.rosterMin > c.rosterMax) {
      ctx.addIssue({ code: 'custom', path: ['rosterMin'], message: 'rosterMin exceeds rosterMax' });
    }
    if (c.minimumPlayers > c.playersOnField) {
      ctx.addIssue({
        code: 'custom',
        path: ['minimumPlayers'],
        message: 'minimumPlayers cannot exceed playersOnField',
      });
    }
    if (c.rosterMin < c.minimumPlayers) {
      ctx.addIssue({
        code: 'custom',
        path: ['rosterMin'],
        message: 'rosterMin cannot be below minimumPlayers',
      });
    }
    if (c.forfeit.minimumPlayersToStart > c.playersOnField) {
      ctx.addIssue({
        code: 'custom',
        path: ['forfeit', 'minimumPlayersToStart'],
        message: 'minimumPlayersToStart cannot exceed playersOnField',
      });
    }
    if (!c.drawsAllowed && !c.overtime.enabled && !c.shootout.enabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['drawsAllowed'],
        message: 'when draws are not allowed, overtime or a shootout must decide the match',
      });
    }
    if (c.tiebreak?.playoff === 'shootout' && !c.shootout.enabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiebreak', 'playoff'],
        message: 'a shootout decides drawn playoff games only when shootouts are enabled',
      });
    }
    if (new Set(c.tiebreakers).size !== c.tiebreakers.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['tiebreakers'],
        message: 'tiebreakers must be unique',
      });
    }
  })
  .openapi('RuleSetContent');
export type RuleSetContent = z.infer<typeof RuleSetContentSchema>;

const FORMAT_SECTIONS: Record<SportFormat, keyof RuleSetContent> = {
  outdoor: 'outdoor',
  indoor_boarded: 'indoorBoarded',
  futsal: 'futsal',
  small_sided_other: 'smallSidedOther',
};

/** Issues when the content carries sections that do not apply to the format (SPK-COMP-002 "irrelevant fields remain disabled"). */
export function ruleSetFormatIssues(
  format: SportFormat,
  content: RuleSetContent,
): Array<{ path: string[]; message: string }> {
  const issues: Array<{ path: string[]; message: string }> = [];
  for (const [f, key] of Object.entries(FORMAT_SECTIONS) as [SportFormat, keyof RuleSetContent][]) {
    const value = content[key];
    if (f === format && value === null) {
      issues.push({ path: [key], message: `${key} rules are required for the ${format} format` });
    }
    if (f !== format && value !== null) {
      issues.push({ path: [key], message: `${key} rules do not apply to the ${format} format` });
    }
  }
  if (format === 'outdoor' && content.cards.sinBinMinutes !== null) {
    issues.push({ path: ['cards', 'sinBinMinutes'], message: 'sin bins do not apply to outdoor' });
  }
  if (
    format !== 'futsal' &&
    content.substitutions.rolling === false &&
    format === 'indoor_boarded'
  ) {
    // boarded indoor play uses rolling substitutions by definition of the format
    issues.push({
      path: ['substitutions', 'rolling'],
      message: 'boarded indoor soccer uses rolling substitutions',
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------------------------
export const CompetitionSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    kind: CompetitionKindSchema,
    sportFormat: SportFormatSchema,
    description: z.string().nullable(),
    status: CompetitionStatusSchema,
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Competition');
export type Competition = z.infer<typeof CompetitionSchema>;

export const CreateCompetitionBody = withCommandMeta({
  name: Name,
  kind: CompetitionKindSchema,
  sportFormat: SportFormatSchema,
  description: Note.optional(),
}).openapi('CreateCompetitionRequest');
export type CreateCompetitionInput = z.infer<typeof CreateCompetitionBody>;

export const UpdateCompetitionBody = withCommandMeta({
  name: Name.optional(),
  description: Note.nullable().optional(),
  status: CompetitionStatusSchema.optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateCompetitionRequest');
export type UpdateCompetitionInput = z.infer<typeof UpdateCompetitionBody>;

export const ListCompetitionsQuery = z.object({
  status: CompetitionStatusSchema.optional(),
  sportFormat: SportFormatSchema.optional(),
});
export type ListCompetitionsQuery = z.infer<typeof ListCompetitionsQuery>;

// ---------------------------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------------------------
export const RuleSetSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    format: SportFormatSchema,
    version: z.number().int(),
    content: RuleSetContentSchema,
    supersedesRuleSetId: z.uuid().nullable(),
    createdAt: Instant,
  })
  .openapi('RuleSet');
export type RuleSet = z.infer<typeof RuleSetSchema>;

/** Posting an existing name creates the next version (rule sets are immutable). */
export const CreateRuleSetBody = withCommandMeta({
  name: Name,
  format: SportFormatSchema,
  content: RuleSetContentSchema,
})
  .superRefine((b, ctx) => {
    for (const issue of ruleSetFormatIssues(b.format, b.content)) {
      ctx.addIssue({ code: 'custom', path: ['content', ...issue.path], message: issue.message });
    }
  })
  .openapi('CreateRuleSetRequest');
export type CreateRuleSetInput = z.infer<typeof CreateRuleSetBody>;

export const ListRuleSetsQuery = z.object({
  name: Name.optional(),
  format: SportFormatSchema.optional(),
  /** When true only the latest version of each name is returned. */
  latestOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type ListRuleSetsQuery = z.infer<typeof ListRuleSetsQuery>;

// ---------------------------------------------------------------------------------------------
// Seasons and divisions (SPK-COMP-003)
// ---------------------------------------------------------------------------------------------
export const SeasonSchema = z
  .object({
    id: z.uuid(),
    competitionId: z.uuid(),
    name: z.string(),
    ruleSetId: z.uuid(),
    startsOn: DateOnly,
    endsOn: DateOnly,
    /** Catalog offering id (string reference, no cross-module key). */
    registrationOfferingRef: z.string().nullable(),
    registrationOpensAt: Instant.nullable(),
    registrationClosesAt: Instant.nullable(),
    status: SeasonStatusSchema,
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Season');
export type Season = z.infer<typeof SeasonSchema>;

export const CreateSeasonBody = withCommandMeta({
  competitionId: z.uuid(),
  name: Name,
  ruleSetId: z.uuid(),
  startsOn: DateOnly,
  endsOn: DateOnly,
  registrationOfferingRef: z.string().trim().min(1).max(200).optional(),
  registrationOpensAt: Instant.optional(),
  registrationClosesAt: Instant.optional(),
})
  .refine((b) => b.startsOn <= b.endsOn, { message: 'startsOn must not be after endsOn' })
  .openapi('CreateSeasonRequest');
export type CreateSeasonInput = z.infer<typeof CreateSeasonBody>;

export const UpdateSeasonBody = withCommandMeta({
  name: Name.optional(),
  ruleSetId: z.uuid().optional(),
  startsOn: DateOnly.optional(),
  endsOn: DateOnly.optional(),
  registrationOfferingRef: z.string().trim().min(1).max(200).nullable().optional(),
  registrationOpensAt: Instant.nullable().optional(),
  registrationClosesAt: Instant.nullable().optional(),
  status: SeasonStatusSchema.optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateSeasonRequest');
export type UpdateSeasonInput = z.infer<typeof UpdateSeasonBody>;

export const ListSeasonsQuery = z.object({
  competitionId: z.uuid().optional(),
  status: SeasonStatusSchema.optional(),
});
export type ListSeasonsQuery = z.infer<typeof ListSeasonsQuery>;

/** Documented placement criteria (SPK-COMP-003, DEC-048), never informal labels alone. */
export const DivisionCriteriaSchema = z
  .object({
    ageBand: z
      .object({
        minAge: z.number().int().min(0).max(120).nullable(),
        maxAge: z.number().int().min(0).max(120).nullable(),
      })
      .refine((b) => b.minAge === null || b.maxAge === null || b.minAge <= b.maxAge, {
        message: 'minAge must not exceed maxAge',
      })
      .nullable()
      .default(null),
    level: z.string().trim().min(1).max(100).nullable().default(null),
    category: z.string().trim().min(1).max(100).nullable().default(null),
    format: z.string().trim().min(1).max(50).nullable().default(null),
  })
  .openapi('DivisionCriteria');
export type DivisionCriteria = z.infer<typeof DivisionCriteriaSchema>;

export const DivisionSchema = z
  .object({
    id: z.uuid(),
    seasonId: z.uuid(),
    name: z.string(),
    criteria: DivisionCriteriaSchema,
    facilityId: z.uuid().nullable(),
    capacityTeamEntries: z.number().int().nullable(),
    /** Entries applied or approved in this division (capacity consumption). */
    entryCount: z.number().int(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Division');
export type Division = z.infer<typeof DivisionSchema>;

export const CreateDivisionBody = withCommandMeta({
  seasonId: z.uuid(),
  name: Name,
  criteria: DivisionCriteriaSchema.optional(),
  facilityId: z.uuid().optional(),
  capacityTeamEntries: z.number().int().min(1).optional(),
}).openapi('CreateDivisionRequest');
export type CreateDivisionInput = z.infer<typeof CreateDivisionBody>;

export const UpdateDivisionBody = withCommandMeta({
  name: Name.optional(),
  criteria: DivisionCriteriaSchema.optional(),
  facilityId: z.uuid().nullable().optional(),
  capacityTeamEntries: z.number().int().min(1).nullable().optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateDivisionRequest');
export type UpdateDivisionInput = z.infer<typeof UpdateDivisionBody>;

export const ListDivisionsQuery = z.object({ seasonId: z.uuid() });

// ---------------------------------------------------------------------------------------------
// Teams and team entries (SPK-COMP-004, SPK-CAP-001/005, §4.5)
// ---------------------------------------------------------------------------------------------
export const TeamColorsSchema = z
  .object({
    primary: z.string().trim().min(1).max(50).optional(),
    secondary: z.string().trim().min(1).max(50).optional(),
  })
  .openapi('TeamColors');
export type TeamColors = z.infer<typeof TeamColorsSchema>;

export const TeamSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    colors: TeamColorsSchema,
    createdByPersonId: z.uuid().nullable(),
    status: TeamStatusSchema,
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Team');
export type Team = z.infer<typeof TeamSchema>;

export const UpdateTeamBody = withCommandMeta({
  name: Name.optional(),
  colors: TeamColorsSchema.optional(),
  status: TeamStatusSchema.optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateTeamRequest');
export type UpdateTeamInput = z.infer<typeof UpdateTeamBody>;

export const EligibilityReasonSchema = z
  .object({
    code: z.string(),
    severity: EligibilitySeveritySchema,
    message: z.string(),
    /** SPK-READY-003: source record, responsible role and required action. */
    source: z.object({ type: z.string(), id: z.string().nullable() }),
    responsibleRole: z.string(),
    requiredAction: z.string(),
  })
  .openapi('EligibilityReason');
export type EligibilityReason = z.infer<typeof EligibilityReasonSchema>;

export const EligibilityEvaluationSchema = z
  .object({
    teamEntryId: z.uuid(),
    personId: z.uuid(),
    at: Instant,
    membershipStatus: RosterPlayingStatusSchema,
    eligible: z.boolean(),
    reasons: z.array(EligibilityReasonSchema),
    evaluatedAt: Instant,
  })
  .openapi('EligibilityEvaluation');
export type EligibilityEvaluation = z.infer<typeof EligibilityEvaluationSchema>;

export const TeamEntrySchema = z
  .object({
    id: z.uuid(),
    seasonId: z.uuid(),
    divisionId: z.uuid().nullable(),
    teamId: z.uuid(),
    /** CMP-01: the continuing team's name. */
    teamName: z.string(),
    status: TeamEntryStatusSchema,
    appliedByPersonId: z.uuid().nullable(),
    appliedAt: Instant,
    approvedAt: Instant.nullable(),
    approvalNote: z.string().nullable(),
    rejectedAt: Instant.nullable(),
    rejectionReason: z.string().nullable(),
    withdrawnAt: Instant.nullable(),
    withdrawalReason: z.string().nullable(),
    /** Finance obligation reference, set by the finance module; null until it exists. */
    financialStatusRef: z.string().nullable(),
    eligibilityStatus: TeamEntryEligibilityStatusSchema,
    eligibilityReasons: z.array(EligibilityReasonSchema),
    renewedFromEntryId: z.uuid().nullable(),
    /** Derived from the effective roster against the rule set (never stored, SPK-COMP-004). */
    rosterComplete: z.boolean(),
    rosterCount: z.number().int(),
    rosterMin: z.number().int(),
    rosterMax: z.number().int(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('TeamEntry');
export type TeamEntry = z.infer<typeof TeamEntrySchema>;

/**
 * Create (new team) or renew (prior entry) a season entry. Exactly one of `team`, `teamId` or
 * `renewFromEntryId` is given. A renewal prefills the continuing team and suggests prior players;
 * nothing is charged and every rule is re-evaluated (SPK-CAP-005).
 */
export const CreateTeamEntryBody = withCommandMeta({
  seasonId: z.uuid(),
  team: z.object({ name: Name, colors: TeamColorsSchema.optional() }).optional(),
  teamId: z.uuid().optional(),
  renewFromEntryId: z.uuid().optional(),
  /** Staff only: the captain of the new entry (defaults to the acting customer). */
  captainPersonId: z.uuid().optional(),
  /** Staff only: place the entry in a division immediately. */
  divisionId: z.uuid().optional(),
})
  .refine(
    (b) => [b.team, b.teamId, b.renewFromEntryId].filter((v) => v !== undefined).length === 1,
    { message: 'give exactly one of team, teamId or renewFromEntryId', path: ['team'] },
  )
  .openapi('CreateTeamEntryRequest');
export type CreateTeamEntryInput = z.infer<typeof CreateTeamEntryBody>;

export const SuggestedPlayerSchema = z
  .object({
    personId: z.uuid(),
    displayName: z.string(),
    lastStatus: RosterPlayingStatusSchema,
    lastEffectiveTo: Instant.nullable(),
  })
  .openapi('SuggestedPlayer');

export const TeamEntryCreatedSchema = z
  .object({
    entry: TeamEntrySchema,
    team: TeamSchema,
    operationId: z.uuid(),
    /** Renewal only: the entry the details were prefilled from. */
    renewedFromEntryId: z.uuid().nullable(),
    /** Renewal only: prior players, as suggestions; each is re-evaluated when added. */
    suggestedPlayers: z.array(SuggestedPlayerSchema),
  })
  .openapi('TeamEntryCreated');
export type TeamEntryCreated = z.infer<typeof TeamEntryCreatedSchema>;

export const ApproveTeamEntryBody = withCommandMeta({
  divisionId: z.uuid().optional(),
  note: Note.optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('ApproveTeamEntryRequest');
export type ApproveTeamEntryInput = z.infer<typeof ApproveTeamEntryBody>;

export const RejectTeamEntryBody = withCommandMeta({})
  .extend({ expectedRevision: Revision, reason: Reason })
  .openapi('RejectTeamEntryRequest');
export type RejectTeamEntryInput = z.infer<typeof RejectTeamEntryBody>;

export const WithdrawTeamEntryBody = withCommandMeta({})
  .extend({ expectedRevision: Revision, reason: Reason })
  .openapi('WithdrawTeamEntryRequest');
export type WithdrawTeamEntryInput = z.infer<typeof WithdrawTeamEntryBody>;

export const ListTeamEntriesQuery = z.object({
  seasonId: z.uuid(),
  divisionId: z.uuid().optional(),
  status: TeamEntryStatusSchema.optional(),
});
export type ListTeamEntriesQuery = z.infer<typeof ListTeamEntriesQuery>;

export const TeamRoleRecordSchema = z
  .object({
    id: z.uuid(),
    teamEntryId: z.uuid(),
    personId: z.uuid(),
    role: TeamRoleSchema,
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
  })
  .openapi('TeamRoleRecord');
export type TeamRoleRecord = z.infer<typeof TeamRoleRecordSchema>;

// ---------------------------------------------------------------------------------------------
// Rosters (SPK-COMP-005, SPK-CAP-002 privacy: readiness indicators only)
// ---------------------------------------------------------------------------------------------
export const RosterEligibilityIndicatorSchema = z
  .object({
    status: z.enum(['eligible', 'ineligible', 'unknown']),
    blocking: z.number().int(),
    warnings: z.number().int(),
    codes: z.array(z.string()),
  })
  .openapi('RosterEligibilityIndicator');

export const RosterMemberSchema = z
  .object({
    id: z.uuid(),
    teamEntryId: z.uuid(),
    personId: z.uuid(),
    displayName: z.string(),
    personKind: PersonKindSchema,
    status: RosterMembershipStatusSchema,
    /** For a removed row: the status it held while effective. */
    statusBeforeRemoval: RosterPlayingStatusSchema.nullable(),
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
    jerseyNumber: z.number().int().nullable(),
    source: RosterSourceSchema,
    removedAt: Instant.nullable(),
    removalReason: z.string().nullable(),
    eligibility: RosterEligibilityIndicatorSchema.nullable(),
  })
  .openapi('RosterMember');
export type RosterMember = z.infer<typeof RosterMemberSchema>;

export const RosterChangeSchema = z
  .discriminatedUnion('action', [
    z.object({
      action: z.literal('add'),
      personId: z.uuid(),
      status: RosterPlayingStatusSchema.default('active'),
      effectiveFrom: Instant.optional(),
      jerseyNumber: z.number().int().min(0).max(999).optional(),
    }),
    z.object({
      action: z.literal('remove'),
      personId: z.uuid(),
      effectiveTo: Instant.optional(),
      reason: Reason,
    }),
  ])
  .openapi('RosterChange');
export type RosterChange = z.infer<typeof RosterChangeSchema>;

export const ChangeRosterBody = withCommandMeta({
  changes: z.array(RosterChangeSchema).min(1).max(50),
}).openapi('ChangeRosterRequest');
export type ChangeRosterInput = z.infer<typeof ChangeRosterBody>;

export const RosterQuery = z.object({
  /** Effective instant; defaults to now. A player removed today is still listed for last week. */
  at: Instant.optional(),
  /** Include pending (invited/requested) and removed rows. */
  includeHistory: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type RosterQuery = z.infer<typeof RosterQuery>;

export const RosterResponseSchema = z
  .object({ teamEntryId: z.uuid(), at: Instant, members: z.array(RosterMemberSchema) })
  .openapi('Roster');
export type RosterResponse = z.infer<typeof RosterResponseSchema>;

export const EligibilityQuery = z.object({
  personId: z.uuid(),
  at: Instant.optional(),
  status: RosterPlayingStatusSchema.default('active'),
});
export type EligibilityQuery = z.infer<typeof EligibilityQuery>;

// ---------------------------------------------------------------------------------------------
// Team invitations (§4.8) and join requests
// ---------------------------------------------------------------------------------------------
export const TeamInvitationSchema = z
  .object({
    id: z.uuid(),
    teamEntryId: z.uuid(),
    invitedByPersonId: z.uuid().nullable(),
    recipientPersonId: z.uuid().nullable(),
    recipientContact: z.object({ kind: ContactPointKindSchema, value: z.string() }).nullable(),
    message: z.string().nullable(),
    status: TeamInvitationStatusSchema,
    expiresAt: Instant,
    acceptedAt: Instant.nullable(),
    acceptedByPersonId: z.uuid().nullable(),
    revokedAt: Instant.nullable(),
    rosterMembershipId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('TeamInvitation');
export type TeamInvitation = z.infer<typeof TeamInvitationSchema>;

export const CreateTeamInvitationBody = withCommandMeta({
  recipientPersonId: z.uuid().optional(),
  recipientContact: z
    .object({ kind: ContactPointKindSchema, value: z.string().trim().min(3).max(320) })
    .optional(),
  message: Note.optional(),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
})
  .refine((b) => (b.recipientPersonId === undefined) !== (b.recipientContact === undefined), {
    message: 'give exactly one of recipientPersonId or recipientContact',
    path: ['recipientPersonId'],
  })
  .openapi('CreateTeamInvitationRequest');
export type CreateTeamInvitationInput = z.infer<typeof CreateTeamInvitationBody>;

export const TeamInvitationIssuedSchema = TeamInvitationSchema.extend({
  /** Returned once to the inviter (no messaging provider is selected, §5.2). */
  token: z.string(),
  eligibilityPreview: RosterEligibilityIndicatorSchema.nullable(),
}).openapi('TeamInvitationIssued');
export type TeamInvitationIssued = z.infer<typeof TeamInvitationIssuedSchema>;

export const AcceptTeamInvitationBody = withCommandMeta({
  token: z.string().min(16).max(512),
  /** A guardian holding `register` accepts for the invited child; defaults to the acting person. */
  personId: z.uuid().optional(),
}).openapi('AcceptTeamInvitationRequest');
export type AcceptTeamInvitationInput = z.infer<typeof AcceptTeamInvitationBody>;

export const RevokeTeamInvitationBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RevokeTeamInvitationRequest');
export type RevokeTeamInvitationInput = z.infer<typeof RevokeTeamInvitationBody>;

/**
 * CMP-03 (SPK-CAP-001, §4.10): an invitation as its recipient, the entry's captains and
 * co-captains, and league staff read it. The token is never returned. `effectiveStatus` is
 * `expired` for a pending invitation past its expiry that the sweep has not recorded yet.
 */
export const TeamInvitationViewSchema = z
  .object({
    id: z.uuid(),
    teamEntryId: z.uuid(),
    teamName: z.string(),
    seasonName: z.string(),
    invitedBy: z.object({ personId: z.uuid(), displayName: z.string() }).nullable(),
    message: z.string().nullable(),
    status: TeamInvitationStatusSchema,
    effectiveStatus: TeamInvitationStatusSchema,
    expiresAt: Instant,
    revision: Revision,
  })
  .openapi('TeamInvitationView');
export type TeamInvitationView = z.infer<typeof TeamInvitationViewSchema>;

export const ListMyTeamInvitationsQuery = PageRequestSchema.extend({
  status: TeamInvitationStatusSchema.default('pending'),
});
export type ListMyTeamInvitationsQuery = z.infer<typeof ListMyTeamInvitationsQuery>;

export const DeclineTeamInvitationBody = withCommandMeta({}).openapi(
  'DeclineTeamInvitationRequest',
);
export type DeclineTeamInvitationInput = z.infer<typeof DeclineTeamInvitationBody>;

export const TeamInvitationAcceptedSchema = z
  .object({ invitation: TeamInvitationSchema, membership: RosterMemberSchema })
  .openapi('TeamInvitationAccepted');
export type TeamInvitationAccepted = z.infer<typeof TeamInvitationAcceptedSchema>;

export const JoinRequestSchema = z
  .object({
    id: z.uuid(),
    teamEntryId: z.uuid(),
    personId: z.uuid(),
    requestedByPersonId: z.uuid().nullable(),
    message: z.string().nullable(),
    status: JoinRequestStatusSchema,
    decidedByPersonId: z.uuid().nullable(),
    decidedAt: Instant.nullable(),
    decisionNote: z.string().nullable(),
    rosterMembershipId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('JoinRequest');
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

export const CreateJoinRequestBody = withCommandMeta({
  /** The player; a guardian with `register` may request for a child. Defaults to the acting person. */
  personId: z.uuid().optional(),
  message: Note.optional(),
}).openapi('CreateJoinRequestRequest');
export type CreateJoinRequestInput = z.infer<typeof CreateJoinRequestBody>;

export const DecideJoinRequestBody = withCommandMeta({
  decision: z.enum(['approve', 'decline']),
  note: Note.optional(),
}).openapi('DecideJoinRequestRequest');
export type DecideJoinRequestInput = z.infer<typeof DecideJoinRequestBody>;

export const JoinRequestDecidedSchema = z
  .object({ request: JoinRequestSchema, membership: RosterMemberSchema.nullable() })
  .openapi('JoinRequestDecided');
export type JoinRequestDecided = z.infer<typeof JoinRequestDecidedSchema>;

/**
 * CMP-13 (SPK-COMP-005, SPK-CAP-001, §4.9): the captain (or league staff) hands a role to an
 * effective roster member; the outgoing and incoming role rows end and start at one instant.
 */
export const HandoverTeamRoleBody = withCommandMeta({
  role: z.enum(['captain', 'co_captain']),
  fromPersonId: z.uuid(),
  toPersonId: z.uuid(),
})
  .extend({ reason: Reason, expectedRevision: Revision })
  .refine((b) => b.fromPersonId !== b.toPersonId, {
    message: 'the role passes to another person',
    path: ['toPersonId'],
  })
  .openapi('HandoverTeamRoleRequest');
export type HandoverTeamRoleInput = z.infer<typeof HandoverTeamRoleBody>;

export const TeamRoleHandoverSchema = z
  .object({
    teamEntryId: z.uuid(),
    role: TeamRoleSchema,
    fromPersonId: z.uuid(),
    toPersonId: z.uuid(),
    effectiveAt: Instant,
    roles: z.array(TeamRoleRecordSchema),
    entryRevision: Revision,
  })
  .openapi('TeamRoleHandover');
export type TeamRoleHandover = z.infer<typeof TeamRoleHandoverSchema>;

// ---------------------------------------------------------------------------------------------
// Fixtures (§4.4 Matches) and availability (SPK-CAP-003)
// ---------------------------------------------------------------------------------------------
export const FixtureSchema = z
  .object({
    id: z.uuid(),
    seasonId: z.uuid(),
    divisionId: z.uuid().nullable(),
    round: z.number().int().nullable(),
    homeEntryId: z.uuid(),
    /** Null for a bye. */
    awayEntryId: z.uuid().nullable(),
    schedulingEventId: z.uuid().nullable(),
    scheduledStart: Instant.nullable(),
    scheduledEnd: Instant.nullable(),
    status: FixtureStatusSchema,
    notes: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Fixture');
export type Fixture = z.infer<typeof FixtureSchema>;

export const FixtureScheduleSchema = z
  .object({
    facilityId: z.uuid(),
    resourceIds: z.array(z.uuid()).min(1).max(20),
    scheduledStart: Instant,
    scheduledEnd: Instant,
    setupMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .optional(),
    cleanupMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .optional(),
    /** false creates a draft event that holds no space until a schedule draft publishes it (SPK-FIX-005). */
    publish: z.boolean().default(true),
  })
  .refine((s) => new Date(s.scheduledStart) < new Date(s.scheduledEnd), {
    message: 'scheduledStart must be before scheduledEnd',
    path: ['scheduledStart'],
  })
  .openapi('FixtureSchedule');
export type FixtureSchedule = z.infer<typeof FixtureScheduleSchema>;

export const CreateFixtureBody = withCommandMeta({
  seasonId: z.uuid(),
  divisionId: z.uuid().optional(),
  round: z.number().int().min(1).optional(),
  homeEntryId: z.uuid(),
  awayEntryId: z.uuid().optional(),
  notes: Note.optional(),
  schedule: FixtureScheduleSchema.optional(),
})
  .refine((b) => b.awayEntryId === undefined || b.awayEntryId !== b.homeEntryId, {
    message: 'a team cannot play itself',
    path: ['awayEntryId'],
  })
  .openapi('CreateFixtureRequest');
export type CreateFixtureInput = z.infer<typeof CreateFixtureBody>;

export const UpdateFixtureBody = withCommandMeta({
  action: z.enum(['schedule', 'reschedule', 'postpone', 'unschedule', 'cancel', 'edit']),
  schedule: FixtureScheduleSchema.optional(),
  round: z.number().int().min(1).nullable().optional(),
  divisionId: z.uuid().nullable().optional(),
  notes: Note.nullable().optional(),
})
  .extend({ expectedRevision: Revision })
  .refine(
    (b) => !(b.action === 'schedule' || b.action === 'reschedule') || b.schedule !== undefined,
    { message: 'schedule is required for this action', path: ['schedule'] },
  )
  .refine((b) => !(b.action === 'cancel' || b.action === 'postpone') || !!b.reason, {
    message: 'reason is required for this action',
    path: ['reason'],
  })
  .openapi('UpdateFixtureRequest');
export type UpdateFixtureInput = z.infer<typeof UpdateFixtureBody>;

export const FixtureCommandResultSchema = z
  .object({
    fixture: FixtureSchema,
    operationId: z.uuid(),
    operationStatus: z.enum(['succeeded', 'failed']),
  })
  .openapi('FixtureCommandResult');
export type FixtureCommandResult = z.infer<typeof FixtureCommandResultSchema>;

export const AvailabilitySummarySchema = z
  .object({
    available: z.number().int(),
    unavailable: z.number().int(),
    tentative: z.number().int(),
    noResponse: z.number().int(),
  })
  .openapi('AvailabilitySummary');
export type AvailabilitySummary = z.infer<typeof AvailabilitySummarySchema>;

export const FixtureSideSchema = z
  .object({
    entryId: z.uuid(),
    teamId: z.uuid(),
    teamName: z.string(),
    availability: AvailabilitySummarySchema,
  })
  .openapi('FixtureSide');

/**
 * CMP-04 (SPK-SCHED-008, SPK-UX-004): where a fixture is played, copied from its scheduling event:
 * the facility, its IANA time zone (every facility-local time is shown in it) and the resources
 * (pitches) by name. Null until the fixture's event changes after this projection existed.
 */
export const FixtureVenueSchema = z
  .object({
    facilityId: z.uuid(),
    facilityName: z.string(),
    /** IANA time zone of the facility (SPK-SCHED-008). */
    timezone: z.string(),
    resources: z.array(z.object({ id: z.uuid(), name: z.string() })),
  })
  .openapi('FixtureVenue');
export type FixtureVenue = z.infer<typeof FixtureVenueSchema>;

/** CMP-04 (SPK-CAP-003): an answer the viewer may see and change (themselves or a child with register). */
export const FixtureResponseSchema = z
  .object({
    personId: z.uuid(),
    state: AvailabilityStateSchema,
    /** Null while no answer is recorded; send it as `expectedRevision` when changing an answer. */
    revision: z.number().int().nullable(),
    respondedAt: Instant.nullable(),
  })
  .openapi('FixtureResponse');
export type FixtureResponse = z.infer<typeof FixtureResponseSchema>;

export const FixtureDetailSchema = FixtureSchema.extend({
  home: FixtureSideSchema,
  away: FixtureSideSchema.nullable(),
  /** Deprecated (CMP-04): use `responses`. The acting person's own response when on a roster. */
  myResponse: AvailabilityStateSchema.nullable(),
  /** CMP-04: the venue copied from the scheduling event, or null. */
  venue: FixtureVenueSchema.nullable(),
  /** CMP-04: the viewer's playing status on either side at kickoff; null when not on a roster. */
  rosterStatus: RosterPlayingStatusSchema.nullable(),
  /** CMP-04: answers of the viewer and of every rostered person they hold `register` over. */
  responses: z.array(FixtureResponseSchema),
}).openapi('FixtureDetail');
export type FixtureDetail = z.infer<typeof FixtureDetailSchema>;

/** CMP-01: a row of `GET /v1/seasons/{id}/fixtures` with the two teams' names (null for a bye). */
export const SeasonFixtureSchema = FixtureSchema.extend({
  homeTeamName: z.string(),
  awayTeamName: z.string().nullable(),
}).openapi('SeasonFixture');
export type SeasonFixture = z.infer<typeof SeasonFixtureSchema>;

/**
 * CMP-14 (SPK-CAP-001 "request player availability", SCR-C-24): a captain (a co-captain only when
 * the rule set lets one act as captain) or league staff asks the entry's roster players without an
 * answer; a later request is the reminder and reaches only those still without one.
 */
export const CreateAvailabilityRequestBody = withCommandMeta({
  teamEntryId: z.uuid(),
  message: z.string().trim().min(1).max(500).optional(),
}).openapi('CreateAvailabilityRequestRequest');
export type CreateAvailabilityRequestInput = z.infer<typeof CreateAvailabilityRequestBody>;

export const AvailabilityRequestSchema = z
  .object({
    id: z.uuid(),
    fixtureId: z.uuid(),
    teamEntryId: z.uuid(),
    requestedByPersonId: z.uuid().nullable(),
    message: z.string().nullable(),
    requestedAt: Instant,
    recipientCount: z.number().int(),
  })
  .openapi('AvailabilityRequest');
export type AvailabilityRequest = z.infer<typeof AvailabilityRequestSchema>;

export const ListAvailabilityRequestsQuery = z.object({ teamEntryId: z.uuid().optional() });
export type ListAvailabilityRequestsQuery = z.infer<typeof ListAvailabilityRequestsQuery>;

export const FixtureAvailabilityResponseSchema = z
  .object({
    id: z.uuid(),
    fixtureId: z.uuid(),
    teamEntryId: z.uuid(),
    personId: z.uuid(),
    state: AvailabilityStateSchema,
    respondedAt: Instant.nullable(),
    note: z.string().nullable(),
    revision: Revision,
  })
  .openapi('FixtureAvailabilityResponse');
export type FixtureAvailabilityResponse = z.infer<typeof FixtureAvailabilityResponseSchema>;

export const RecordAvailabilityBody = withCommandMeta({
  /** The player; a guardian with `register` responds for a child. Defaults to the acting person. */
  personId: z.uuid().optional(),
  state: AvailabilityStateSchema,
  note: Note.optional(),
}).openapi('RecordAvailabilityRequest');
export type RecordAvailabilityInput = z.infer<typeof RecordAvailabilityBody>;

export const ListSeasonFixturesQuery = PageRequestSchema.extend({
  divisionId: z.uuid().optional(),
  teamEntryId: z.uuid().optional(),
  status: FixtureStatusSchema.optional(),
  from: Instant.optional(),
  to: Instant.optional(),
});
export type ListSeasonFixturesQuery = z.infer<typeof ListSeasonFixturesQuery>;

// ---------------------------------------------------------------------------------------------
// Captain workspace (SPK-CAP-001/002)
// ---------------------------------------------------------------------------------------------
export const ReadinessIssueSchema = z
  .object({
    code: z.string(),
    severity: EligibilitySeveritySchema,
    message: z.string(),
    responsibleRole: z.string(),
    requiredAction: z.string(),
  })
  .openapi('ReadinessIssue');

export const TeamEntryReadinessSchema = z
  .object({
    approval: TeamEntryStatusSchema,
    financialStatusRef: z.string().nullable(),
    rosterCount: z.number().int(),
    rosterMin: z.number().int(),
    rosterMax: z.number().int(),
    rosterComplete: z.boolean(),
    eligiblePlayers: z.number().int(),
    pendingInvitations: z.number().int(),
    pendingJoinRequests: z.number().int(),
    issues: z.array(ReadinessIssueSchema),
  })
  .openapi('TeamEntryReadiness');

/**
 * CMP-02 (SPK-CAP-001/002, SPK-UX-002): who the workspace viewer is on the entry and what they may
 * do now. `actingAsCaptain` is true for the captain, and for a co-captain only when the rule set's
 * `roster.coCaptainMayActAsCaptain` says so; `availableActions` are action ids the kernel allows
 * the viewer on this entry in its current state.
 */
export const TeamEntryViewerSchema = z
  .object({
    roles: z.array(TeamRoleSchema),
    actingAsCaptain: z.boolean(),
    availableActions: z.array(z.string()),
  })
  .openapi('TeamEntryViewer');
export type TeamEntryViewer = z.infer<typeof TeamEntryViewerSchema>;

export const UpcomingFixtureSchema = z
  .object({
    fixture: FixtureSchema,
    side: z.enum(['home', 'away']),
    opponent: z.object({ entryId: z.uuid(), teamName: z.string() }).nullable(),
    availability: AvailabilitySummarySchema,
    myResponse: AvailabilityStateSchema.nullable(),
  })
  .openapi('UpcomingFixture');

export const TeamEntryWorkspaceSchema = z
  .object({
    entry: TeamEntrySchema,
    team: TeamSchema,
    season: z.object({
      id: z.uuid(),
      name: z.string(),
      status: SeasonStatusSchema,
      startsOn: DateOnly,
      endsOn: DateOnly,
    }),
    division: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    ruleSet: z.object({ id: z.uuid(), name: z.string(), version: z.number().int() }),
    roles: z.array(TeamRoleRecordSchema),
    roster: z.array(RosterMemberSchema),
    readiness: TeamEntryReadinessSchema,
    /** CMP-02: null when the viewer may not see them; [] when there are none. */
    pendingInvitations: z.array(TeamInvitationSchema).nullable(),
    /** CMP-02: null when the viewer may not see them; [] when there are none. */
    pendingJoinRequests: z.array(JoinRequestSchema).nullable(),
    upcomingFixtures: z.array(UpcomingFixtureSchema),
    viewer: TeamEntryViewerSchema,
  })
  .openapi('TeamEntryWorkspace');
export type TeamEntryWorkspace = z.infer<typeof TeamEntryWorkspaceSchema>;

// ---------------------------------------------------------------------------------------------
// Import commands (CMP-09, IF-40, §5.3, §5.4, SPK-AT-024): in-process only, never a route. The
// migration module passes the snapshot's content with the batch's import provenance.
// ---------------------------------------------------------------------------------------------
export const ImportSeasonInputSchema = z
  .object({
    competitionId: z.uuid(),
    name: Name,
    ruleSetId: z.uuid(),
    startsOn: DateOnly,
    endsOn: DateOnly,
    status: SeasonStatusSchema,
    registrationOfferingRef: z.string().trim().min(1).max(200).nullable().default(null),
    registrationOpensAt: Instant.nullable().default(null),
    registrationClosesAt: Instant.nullable().default(null),
  })
  .refine((b) => b.startsOn <= b.endsOn, { message: 'startsOn must not be after endsOn' });
export type ImportSeasonInput = z.input<typeof ImportSeasonInputSchema>;

export const ImportTeamInputSchema = z.object({
  name: Name,
  colors: TeamColorsSchema.default({}),
  status: TeamStatusSchema.default('active'),
});
export type ImportTeamInput = z.input<typeof ImportTeamInputSchema>;

/**
 * The entry's snapshot status: `applied` and `approved` entries are imported (an approved one
 * through the TeamEntryMachine's `approve`, with the snapshot's approval date); withdrawn and
 * rejected entries stay staged history and are refused.
 */
export const ImportTeamEntryInputSchema = z.object({
  seasonId: z.uuid(),
  teamId: z.uuid(),
  divisionId: z.uuid().nullable().default(null),
  status: TeamEntryStatusSchema,
  appliedAt: Instant,
  approvedAt: Instant.nullable().default(null),
  /** The captain role holder, when the snapshot names one (effective from `appliedAt`). */
  captainPersonId: z.uuid().nullable().default(null),
});
export type ImportTeamEntryInput = z.input<typeof ImportTeamEntryInputSchema>;

export const ImportRosterMembershipInputSchema = z
  .object({
    teamEntryId: z.uuid(),
    personId: z.uuid(),
    status: RosterPlayingStatusSchema,
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable().default(null),
    jerseyNumber: z.number().int().min(0).max(999).nullable().default(null),
  })
  .refine((b) => b.effectiveTo === null || new Date(b.effectiveFrom) <= new Date(b.effectiveTo), {
    message: 'effectiveTo must not be before effectiveFrom',
    path: ['effectiveTo'],
  });
export type ImportRosterMembershipInput = z.input<typeof ImportRosterMembershipInputSchema>;

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
      409: err(
        'Conflict (CAPACITY_UNAVAILABLE, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)',
      ),
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
  '/competitions',
  'Create a competition (SPK-COMP-001)',
  CreateCompetitionBody,
  CompetitionSchema,
);
query('/competitions', 'List competitions', ListCompetitionsQuery, z.array(CompetitionSchema));
query('/competitions/{id}', 'Read a competition', null, CompetitionSchema);
command(
  'patch',
  '/competitions/{id}',
  'Update a competition',
  UpdateCompetitionBody,
  CompetitionSchema,
  200,
);

command(
  'post',
  '/rule-sets',
  'Create a rule set or its next version (SPK-COMP-002)',
  CreateRuleSetBody,
  RuleSetSchema,
);
query('/rule-sets', 'List rule sets', ListRuleSetsQuery, z.array(RuleSetSchema));
query('/rule-sets/{id}', 'Read a rule set version', null, RuleSetSchema);

command('post', '/seasons', 'Create a season (SPK-COMP-001)', CreateSeasonBody, SeasonSchema);
query('/seasons', 'List seasons', ListSeasonsQuery, z.array(SeasonSchema));
query('/seasons/{id}', 'Read a season', null, SeasonSchema);
command(
  'patch',
  '/seasons/{id}',
  'Update a season or move its status',
  UpdateSeasonBody,
  SeasonSchema,
  200,
);
query(
  '/seasons/{id}/fixtures',
  'List the fixtures of a season with team names (CMP-01)',
  ListSeasonFixturesQuery,
  pageSchema(SeasonFixtureSchema),
);

command(
  'post',
  '/divisions',
  'Create a division with documented criteria (SPK-COMP-003)',
  CreateDivisionBody,
  DivisionSchema,
);
query('/divisions', 'List the divisions of a season', ListDivisionsQuery, z.array(DivisionSchema));
query('/divisions/{id}', 'Read a division', null, DivisionSchema);
command('patch', '/divisions/{id}', 'Update a division', UpdateDivisionBody, DivisionSchema, 200);

query('/teams/{id}', 'Read a continuing team identity', null, TeamSchema);
command('patch', '/teams/{id}', 'Update team details', UpdateTeamBody, TeamSchema, 200);

command(
  'post',
  '/team-entries',
  'Create or renew a season team entry (SPK-CAP-001/005)',
  CreateTeamEntryBody,
  TeamEntryCreatedSchema,
);
query(
  '/team-entries',
  'List the entries of a season (staff)',
  ListTeamEntriesQuery,
  z.array(TeamEntrySchema),
);
query(
  '/team-entries/{id}',
  'Captain workspace: readiness, roster, upcoming fixtures (SPK-CAP-001)',
  null,
  TeamEntryWorkspaceSchema,
);
command(
  'post',
  '/team-entries/{id}/approve',
  'Approve an entry and place it (SPK-COMP-004)',
  ApproveTeamEntryBody,
  TeamEntrySchema,
  200,
);
command(
  'post',
  '/team-entries/{id}/reject',
  'Reject an entry',
  RejectTeamEntryBody,
  TeamEntrySchema,
  200,
);
command(
  'post',
  '/team-entries/{id}/withdraw',
  'Withdraw an entry',
  WithdrawTeamEntryBody,
  TeamEntrySchema,
  200,
);
query(
  '/team-entries/{id}/roster',
  'Effective roster at an instant (SPK-COMP-005)',
  RosterQuery,
  RosterResponseSchema,
);
command(
  'post',
  '/team-entries/{id}/roster',
  'Add or remove players with effective dates (SPK-COMP-005, SPK-CAP-004)',
  ChangeRosterBody,
  RosterResponseSchema,
  200,
);
query(
  '/team-entries/{id}/eligibility',
  'Explain a player’s eligibility for this entry',
  EligibilityQuery,
  EligibilityEvaluationSchema,
);
command(
  'post',
  '/team-entries/{id}/invitations',
  'Invite a prospective team member (§4.8); the secret is returned once and a replay answers IDEMPOTENCY_SECRET_WITHHELD',
  CreateTeamInvitationBody,
  TeamInvitationIssuedSchema,
);
command(
  'post',
  '/team-invitations/{id}/accept',
  'Accept a team invitation',
  AcceptTeamInvitationBody,
  TeamInvitationAcceptedSchema,
  200,
);
command(
  'post',
  '/team-invitations/{id}/revoke',
  'Revoke a pending team invitation',
  RevokeTeamInvitationBody,
  TeamInvitationSchema,
  200,
);
query(
  '/me/team-invitations',
  'Team invitations addressed to me or to one of my verified contacts (CMP-03, SPK-CAP-001)',
  ListMyTeamInvitationsQuery,
  pageSchema(TeamInvitationViewSchema),
);
query(
  '/team-invitations/{id}',
  'Read a team invitation: recipient, captains, co-captains, league staff (CMP-03, §4.10)',
  null,
  TeamInvitationViewSchema,
);
command(
  'post',
  '/team-invitations/{id}/decline',
  'Decline a pending team invitation (CMP-03, SPK-CAP-001)',
  DeclineTeamInvitationBody,
  TeamInvitationViewSchema,
  200,
);
command(
  'post',
  '/team-entries/{id}/roles/handover',
  'Hand a captain or co-captain role to a roster member (CMP-13, SPK-COMP-005)',
  HandoverTeamRoleBody,
  TeamRoleHandoverSchema,
  200,
);
command(
  'post',
  '/team-entries/{id}/join-requests',
  'Request to join a team',
  CreateJoinRequestBody,
  JoinRequestSchema,
);
command(
  'post',
  '/join-requests/{id}/decide',
  'Approve or decline a join request',
  DecideJoinRequestBody,
  JoinRequestDecidedSchema,
  200,
);

command(
  'post',
  '/fixtures',
  'Create a fixture, optionally scheduling it through the scheduling module',
  CreateFixtureBody,
  FixtureCommandResultSchema,
);
query('/fixtures/{id}', 'Read a fixture with availability summaries', null, FixtureDetailSchema);
command(
  'patch',
  '/fixtures/{id}',
  'Schedule, reschedule, postpone, unschedule, cancel or edit a fixture',
  UpdateFixtureBody,
  FixtureCommandResultSchema,
  200,
);
command(
  'post',
  '/fixtures/{id}/availability',
  'Record an authorized RSVP before kickoff; expectedRevision is enforced (§4.8, SPK-CAP-003, CMP-04)',
  RecordAvailabilityBody,
  FixtureAvailabilityResponseSchema,
  200,
);
command(
  'post',
  '/fixtures/{id}/availability-requests',
  'Ask the roster players without an answer for their availability (CMP-14, SPK-CAP-001)',
  CreateAvailabilityRequestBody,
  AvailabilityRequestSchema,
);
query(
  '/fixtures/{id}/availability-requests',
  'Earlier availability requests of a fixture with their recipient counts (CMP-14)',
  ListAvailabilityRequestsQuery,
  z.array(AvailabilityRequestSchema),
);

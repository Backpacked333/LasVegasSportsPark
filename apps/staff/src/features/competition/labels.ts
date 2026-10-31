/**
 * Staff-visible status labels for the competition, placement and youth screens (SCR-S-08 to
 * SCR-S-13, SCR-S-16 to SCR-S-19). Staff labels use the machine state names of
 * docs/package-a/journeys.md section 3 (SPK-UX-010), and every label is shown through
 * `StatusBadge` with a glyph, never by colour alone (SPK-UX-009).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export interface Badge {
  tone: StatusTone;
  label: string;
}

type Labels<K extends string> = Record<K, Badge>;

export const COMPETITION_STATUS: Labels<Schema<'CompetitionStatus'>> = {
  draft: { tone: 'pending', label: 'draft' },
  active: { tone: 'success', label: 'active' },
  archived: { tone: 'neutral', label: 'archived' },
};

export const SEASON_STATUS: Labels<Schema<'SeasonStatus'>> = {
  draft: { tone: 'pending', label: 'draft' },
  open: { tone: 'info', label: 'open' },
  active: { tone: 'success', label: 'active' },
  completed: { tone: 'neutral', label: 'completed' },
  archived: { tone: 'neutral', label: 'archived' },
};

/** SeasonMachine transitions (§4.6): the API refuses any other with INVALID_TRANSITION. */
export const SEASON_TRANSITIONS: Record<
  Schema<'SeasonStatus'>,
  readonly { to: Schema<'SeasonStatus'>; label: string }[]
> = {
  draft: [
    { to: 'open', label: 'Open the season' },
    { to: 'archived', label: 'Archive' },
  ],
  open: [
    { to: 'active', label: 'Start the season' },
    { to: 'archived', label: 'Archive' },
  ],
  active: [
    { to: 'completed', label: 'Complete the season' },
    { to: 'archived', label: 'Archive' },
  ],
  completed: [{ to: 'archived', label: 'Archive' }],
  archived: [],
};

/**
 * Lifecycle moves that cannot be undone (`archived` is terminal; a completed season cannot reopen):
 * the screen asks for confirmation and a reason for the audit record before sending them.
 */
export const IRREVERSIBLE_MOVES: Readonly<Record<string, string>> = {
  archived:
    'Archiving cannot be undone. Fixtures, entries and results become read-only and stay in the history.',
  completed:
    'Completing the season cannot be undone. Results and standings stay; no new fixtures can be played.',
};

/** CompetitionMachine transitions (§4.6). */
export const COMPETITION_TRANSITIONS: Record<
  Schema<'CompetitionStatus'>,
  readonly { to: Schema<'CompetitionStatus'>; label: string }[]
> = {
  draft: [
    { to: 'active', label: 'Activate' },
    { to: 'archived', label: 'Archive' },
  ],
  active: [{ to: 'archived', label: 'Archive' }],
  archived: [],
};

export const COMPETITION_KIND: Record<Schema<'CompetitionKind'>, string> = {
  league: 'League',
  tournament: 'Tournament',
};

export const SPORT_FORMAT: Record<Schema<'SportFormat'>, string> = {
  outdoor: 'Outdoor soccer',
  indoor_boarded: 'Boarded indoor soccer',
  futsal: 'Futsal',
  small_sided_other: 'Other small-sided format',
};

export const FIXTURE_STATUS: Labels<Schema<'FixtureStatus'>> = {
  unscheduled: { tone: 'pending', label: 'unscheduled' },
  scheduled: { tone: 'info', label: 'scheduled' },
  postponed: { tone: 'warning', label: 'postponed' },
  played: { tone: 'success', label: 'played' },
  forfeit: { tone: 'warning', label: 'forfeit' },
  canceled: { tone: 'neutral', label: 'canceled' },
  abandoned: { tone: 'danger', label: 'abandoned' },
};

/**
 * Readiness (SPK-READY-002): "Ready", "Blocked", "Warning", "Unknown or stale evidence". The
 * readiness is derived by the API on every read; there is no editable ready flag (SPK-READY-004).
 */
export const READINESS_STATUS: Labels<Schema<'ReadinessStatus'>> = {
  ready: { tone: 'success', label: 'Ready' },
  blocked: { tone: 'danger', label: 'Blocked' },
  warning: { tone: 'warning', label: 'Warning' },
  unknown: { tone: 'pending', label: 'Unknown or stale evidence' },
};

export const ISSUE_SEVERITY: Labels<Schema<'EligibilitySeverity'>> = {
  blocking: { tone: 'danger', label: 'Blocking' },
  warning: { tone: 'warning', label: 'Warning' },
  info: { tone: 'info', label: 'Informational' },
  unknown: { tone: 'pending', label: 'Unknown or stale evidence' },
};

export const RESULT_STATUS: Labels<Schema<'ResultStatus'>> = {
  draft: { tone: 'pending', label: 'draft' },
  submitted: { tone: 'info', label: 'submitted' },
  official: { tone: 'success', label: 'official' },
  superseded: { tone: 'neutral', label: 'superseded' },
};

export const RESULT_CLASSIFICATION: Record<Schema<'ResultClassification'>, string> = {
  completed: 'Completed',
  forfeit: 'Forfeit',
  canceled: 'Canceled',
  abandoned: 'Abandoned',
  postponed: 'Postponed',
  disputed: 'Disputed',
};

/**
 * SPK-FIX-004 / SPK-AT-011: the four solver outcomes in honest words. "Feasible" never claims
 * optimality; "no proposal within the limit" never claims impossibility.
 */
export const SOLVER_OUTCOME: Record<Schema<'SolverOutcome'>, Badge & { explanation: string }> = {
  feasible: {
    tone: 'success',
    label: 'Feasible proposal',
    explanation:
      'Every hard constraint is met. This proposal is not proven optimal: a better one may exist.',
  },
  proven_optimal: {
    tone: 'success',
    label: 'Proven optimal proposal',
    explanation: 'The search established that no proposal scores better on the preferences.',
  },
  proven_infeasible: {
    tone: 'danger',
    label: 'Proven infeasible',
    explanation:
      'The search established that no schedule can meet every hard constraint. Change a hard constraint to continue.',
  },
  no_proposal_within_limit: {
    tone: 'warning',
    label: 'No feasible proposal found within the search limit',
    explanation:
      'This is not proof that a schedule is impossible. Raise the search limit or relax a constraint and run again.',
  },
};

export const SOLVER_STOPPED_BY: Record<Schema<'SolverExplanation'>['stoppedBy'], string> = {
  exhausted: 'every candidate was tried',
  candidate_limit: 'the candidate limit was reached',
  time_limit: 'the time limit was reached',
  proof: 'the search reached a proof',
};

export const COMPLETENESS_ISSUE: Record<Schema<'CompletenessIssue'>['code'], string> = {
  missing_fixture: 'Missing fixture',
  duplicate_fixture: 'Duplicate fixture',
  excess_games: 'Excess games',
  unscheduled_game: 'Unscheduled game',
  opponent_frequency: 'Incorrect opponent frequency',
  invalid_bye: 'Invalid bye',
  playoff_unfulfilled: 'Unfulfilled playoff requirement',
  games_per_team_mismatch: 'Games per team mismatch',
};

export const FAIRNESS_PREFERENCE: Record<Schema<'FairnessPreferenceKind'>, string> = {
  home_away_balance: 'Home and away balance',
  rest_distribution: 'Rest distribution',
  no_consecutive_games: 'No consecutive games',
  early_late_distribution: 'Early and late start distribution',
  no_repeated_opponents: 'No repeated opponents',
  preferred_availability: 'Preferred availability',
  approved_convenience: 'Approved coach or family convenience',
};

export const DISPUTE_STATUS: Labels<Schema<'DisputeStatus'>> = {
  submitted: { tone: 'info', label: 'submitted' },
  under_review: { tone: 'pending', label: 'under_review' },
  decided: { tone: 'success', label: 'decided' },
  withdrawn: { tone: 'neutral', label: 'withdrawn' },
};

export const PUBLICATION_CONSEQUENCE: Record<
  NonNullable<Schema<'PublicationConsequence'>>,
  string
> = {
  none: 'No publication consequence',
  result_stands: 'Result stands',
  correction_required: 'Correction required',
  replay_ordered: 'Replay ordered',
};

export const APPEAL_SUMMARY: Record<Schema<'AppealStatusSummary'>, string> = {
  none: 'No appeal',
  pending: 'Appeal pending',
  granted: 'Appeal granted',
  denied: 'Appeal denied',
};

/** AppealMachine states (§4.6); the appeal procedure itself is pending DEC-010. */
export const APPEAL_STATUS: Labels<Schema<'AppealStatus'>> = {
  submitted: { tone: 'info', label: 'submitted' },
  under_review: { tone: 'pending', label: 'under_review' },
  granted: { tone: 'success', label: 'granted' },
  denied: { tone: 'neutral', label: 'denied' },
  withdrawn: { tone: 'neutral', label: 'withdrawn' },
};

export const DECISION_STATUS: Labels<Schema<'DisciplinaryDecisionStatus'>> = {
  issued: { tone: 'warning', label: 'issued' },
  overturned: { tone: 'neutral', label: 'overturned' },
};

export const DECISION_KIND: Record<Schema<'DisciplinaryDecisionKind'>, string> = {
  no_action: 'No action',
  warning: 'Warning',
  suspension: 'Suspension',
  other: 'Other decision',
};

/** ProgressionRecommendation states (ENR-14): a draft is not visible to the family until shared. */
export const RECOMMENDATION_STATUS: Labels<Schema<'ProgressionRecommendation'>['status']> = {
  draft: { tone: 'pending', label: 'draft' },
  shared: { tone: 'success', label: 'shared' },
  withdrawn: { tone: 'neutral', label: 'withdrawn' },
};

export const INCIDENT_STATUS: Labels<Schema<'IncidentStatus'>> = {
  open: { tone: 'info', label: 'open' },
  under_review: { tone: 'pending', label: 'under_review' },
  closed: { tone: 'neutral', label: 'closed' },
};

export const INCIDENT_KIND: Record<Schema<'IncidentKind'>, string> = {
  card: 'Card',
  misconduct: 'Misconduct report',
  complaint: 'Complaint',
  operational: 'Operational incident',
  injury: 'Injury (operational record)',
};

export const SUSPENSION_STATUS: Labels<Schema<'SuspensionStatus'>> = {
  proposed: { tone: 'pending', label: 'proposed' },
  active: { tone: 'warning', label: 'active' },
  served: { tone: 'neutral', label: 'served' },
  overturned: { tone: 'neutral', label: 'overturned' },
};

export const SUSPENSION_SOURCE: Record<Schema<'Suspension'>['sourceKind'], string> = {
  manual: 'Manual decision',
  red_card: 'Proposed by the rule set from a red card',
  yellow_accumulation: 'Proposed by the rule set from yellow card accumulation',
};

export const TEAM_ENTRY_STATUS: Labels<Schema<'TeamEntryStatus'>> = {
  applied: { tone: 'info', label: 'applied' },
  approved: { tone: 'success', label: 'approved' },
  rejected: { tone: 'neutral', label: 'rejected' },
  withdrawn: { tone: 'neutral', label: 'withdrawn' },
};

export const ENTRY_ELIGIBILITY: Labels<Schema<'TeamEntryEligibilityStatus'>> = {
  pending: { tone: 'pending', label: 'Eligibility pending' },
  eligible: { tone: 'success', label: 'Eligible' },
  ineligible: { tone: 'danger', label: 'Ineligible' },
  review_required: { tone: 'warning', label: 'Eligibility review required' },
};

export const ROSTER_STATUS: Labels<Schema<'RosterMembershipStatus'>> = {
  active: { tone: 'success', label: 'active' },
  guest: { tone: 'info', label: 'guest' },
  substitute: { tone: 'info', label: 'substitute' },
  invited: { tone: 'pending', label: 'invited' },
  requested: { tone: 'pending', label: 'requested' },
  removed: { tone: 'neutral', label: 'removed' },
};

/** Roster eligibility indicator: "unknown" is never presented as eligible (SPK-READY-002). */
export const ROSTER_ELIGIBILITY: Labels<'eligible' | 'ineligible' | 'unknown'> = {
  eligible: { tone: 'success', label: 'Eligible' },
  ineligible: { tone: 'danger', label: 'Not eligible' },
  unknown: { tone: 'pending', label: 'Eligibility unknown' },
};

export const PLACEMENT_STATUS: Labels<Schema<'PlacementStatus'>> = {
  unassigned: { tone: 'pending', label: 'unassigned' },
  proposed: { tone: 'info', label: 'proposed' },
  assigned: { tone: 'success', label: 'assigned' },
  released: { tone: 'neutral', label: 'released' },
};

export const OPERATION_STATUS: Labels<
  'pending' | 'running' | 'succeeded' | 'failed' | 'recovery_required' | 'compensated'
> = {
  pending: { tone: 'pending', label: 'pending' },
  running: { tone: 'pending', label: 'running' },
  succeeded: { tone: 'success', label: 'succeeded' },
  failed: { tone: 'danger', label: 'failed' },
  recovery_required: { tone: 'danger', label: 'recovery_required' },
  compensated: { tone: 'warning', label: 'compensated' },
};

export const CAPACITY_CONSTRAINT: Record<Schema<'CapacityConstraintKind'>, string> = {
  commercial: 'Commercial limit',
  staffing: 'Staffing requirement',
  space: 'Space limit',
};

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function weekdayName(index: number): string {
  return WEEKDAYS[index] ?? `Day ${index}`;
}

/** Readable form of a machine code such as `missing_fixture` or `roster.minimum`. */
export function humanizeCode(code: string): string {
  const words = code.replace(/[._]+/g, ' ').trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

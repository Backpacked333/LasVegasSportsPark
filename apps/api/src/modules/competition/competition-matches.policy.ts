import type { CardKind, SearchSettings, StaffRole } from '@sportspark/contracts';

/**
 * Policy values part 2 leaves to operators (specification §6.6). Each is configuration with the
 * proposed default and the decision it waits for; nothing here is hard-coded into evaluation
 * beyond being the fallback the services read.
 */

/**
 * Fair-play penalty points per card used by the `fair_play` tiebreaker (SPK-RESULT-003). Proposed
 * default pending DEC-002 (competition rules); the rule set's `cards` section governs suspensions,
 * not this ranking weight.
 */
export const FAIR_PLAY_POINTS: Readonly<Record<CardKind, number>> = {
  yellow: 1,
  second_yellow: 3,
  red: 3,
};

/** Default search limits for the fixture generator (SPK-FIX-004); the request may override them. */
export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  maxCandidates: 40,
  timeLimitMs: 2_000,
  seed: 1,
};

/**
 * Operational exception raised when a correction would rewrite a published bracket or a game
 * already played (SPK-RESULT-004, SPK-AT-014). Owned by the league manager queue (SPK-UX-006).
 */
export const RESULT_CORRECTION_REVIEW: {
  category: string;
  ownerQueue: string;
  severity: 'high';
  /** Who decides the review (publishing the correction against the open task); DEC-065 pending. */
  reviewerRoles: readonly StaffRole[];
} = {
  category: 'competition.result_correction_review',
  ownerQueue: 'league_manager',
  severity: 'high',
  reviewerRoles: ['league_manager', 'general_manager'],
};

/** Proposed default (DEC-010 pending): a captain of a competing entry may dispute; staff as league administration. */
export const DISPUTE_CAPTAIN_ROLE = 'captain';

/** Name given to the scheduling draft a solver run opens when the request names none. */
export const solverDraftName = (specificationName: string, runNo: number): string =>
  `${specificationName} — proposal ${runNo}`;

/**
 * Staff who read and manage restricted discipline records (SPK-DISC-001/004). Proposed default:
 * league management (league manager, general manager); pending DEC-010 (discipline and appeals).
 */
export const DISCIPLINE_MANAGER_ROLES: readonly StaffRole[] = ['league_manager', 'general_manager'];

/**
 * Remaining-obligation deadline for fixtures left unscheduled by a publication (SPK-FIX-002
 * "owner and deadline"): this many days after the publication, never later than the season's
 * last day. Proposed default from the SPK-AT-010 acceptance fixture (example: 7 days); pending
 * the league manager's decision (DEC-002).
 */
export const UNSCHEDULED_FIXTURE_DEADLINE_DAYS = 7;

/**
 * Operational exception raised when a publication leaves fixtures of a season unscheduled
 * (SPK-AT-010 step 5, SPK-FIX-002). Owned by the league manager queue.
 */
export const INCOMPLETE_SEASON = {
  category: 'competition.incomplete_season',
  ownerQueue: 'league_manager',
  severity: 'warning',
} as const;

/**
 * The deadline of a remaining fixture obligation: UNSCHEDULED_FIXTURE_DEADLINE_DAYS after `now`,
 * capped at the start of the day after the season's last day (`seasonEndsBefore`, facility-local).
 */
export function unscheduledFixtureDeadline(now: Date, seasonEndsBefore: Date | null): Date {
  const proposed = new Date(now.getTime() + UNSCHEDULED_FIXTURE_DEADLINE_DAYS * 86_400_000);
  return seasonEndsBefore && seasonEndsBefore < proposed ? seasonEndsBefore : proposed;
}

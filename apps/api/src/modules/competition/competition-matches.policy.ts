import type { CardKind, SearchSettings } from '@sportspark/contracts';

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
export const RESULT_CORRECTION_REVIEW = {
  category: 'competition.result_correction_review',
  ownerQueue: 'league_manager',
  severity: 'high',
} as const;

/** Proposed default (DEC-010 pending): a captain of a competing entry may dispute; staff as league administration. */
export const DISPUTE_CAPTAIN_ROLE = 'captain';

/** Name given to the scheduling draft a solver run opens when the request names none. */
export const solverDraftName = (specificationName: string, runNo: number): string =>
  `${specificationName} — proposal ${runNo}`;

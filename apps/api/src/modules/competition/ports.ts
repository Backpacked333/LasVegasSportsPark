import type {
  EligibilityEvaluation,
  EligibilitySeverity,
  FixtureStatus,
  Principal,
  RosterPlayingStatus,
  TeamEntryStatus,
  TeamRoleValue,
} from '@sportspark/contracts';
import type { Trx } from '../../kernel';

/**
 * Ports other modules call (README "Ports"). Reads take the organization explicitly and an
 * optional transaction; without one they read through the caller's active transaction when
 * inside a command, else the root database. They return identifiers and readiness facts only;
 * names, dates of birth and contacts come from the identity module when authorized (§4.14).
 */

export interface TeamEntrySummary {
  id: string;
  organizationId: string;
  seasonId: string;
  competitionId: string;
  divisionId: string | null;
  teamId: string;
  teamName: string;
  status: TeamEntryStatus;
  financialStatusRef: string | null;
  eligibilityStatus: string;
  revision: number;
}

export interface PersonEntryMembership {
  teamEntryId: string;
  seasonId: string;
  membershipStatus: RosterPlayingStatus | null;
  roles: TeamRoleValue[];
}

export interface TeamEntryQueryPort {
  findTeamEntry(
    organizationId: string,
    teamEntryId: string,
    trx?: Trx,
  ): Promise<TeamEntrySummary | null>;
  listSeasonEntries(
    organizationId: string,
    seasonId: string,
    trx?: Trx,
  ): Promise<TeamEntrySummary[]>;
  /** Entries a person is effectively on (roster or role) at the instant. */
  entriesOfPerson(
    organizationId: string,
    personId: string,
    at: Date,
    trx?: Trx,
  ): Promise<PersonEntryMembership[]>;
  /**
   * CMP-01, IF-15: the season whose registration offering is `offeringId`, or null (the caller then
   * has no season: seasonId null).
   */
  seasonForOffering(
    organizationId: string,
    offeringId: string,
    trx?: Trx,
  ): Promise<{ seasonId: string; competitionId: string } | null>;
  /**
   * CMP-01, IF-15: the people holding any of `roles` on the entry at `at`, with or without a roster
   * row ([] means roster-only audiences).
   */
  roleHolders(
    organizationId: string,
    teamEntryId: string,
    roles: readonly TeamRoleValue[],
    at: Date,
    trx?: Trx,
  ): Promise<Array<{ personId: string; role: TeamRoleValue }>>;
}
export const TEAM_ENTRY_QUERY_PORT = Symbol('TEAM_ENTRY_QUERY_PORT');

export interface EffectiveRosterMember {
  membershipId: string;
  personId: string;
  status: RosterPlayingStatus;
  jerseyNumber: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  roles: TeamRoleValue[];
}

/** SPK-COMP-005: the roster as it was at an instant (a player removed today is still on last week's roster). */
export interface RosterPort {
  effectiveRoster(
    organizationId: string,
    teamEntryId: string,
    at: Date,
    trx?: Trx,
  ): Promise<EffectiveRosterMember[]>;
  /**
   * SPK-AT-002: places the player of a confirmed `join_team` registration on the roster inside the
   * caller's transaction, re-evaluating eligibility; throws a domain error when the rules refuse.
   */
  addRegisteredMember(
    trx: Trx,
    input: {
      organizationId: string;
      teamEntryId: string;
      personId: string;
      enrollmentId: string;
      correlationId: string | null;
    },
  ): Promise<{ membershipId: string; created: boolean }>;
}
export const ROSTER_PORT = Symbol('ROSTER_PORT');

export interface FixtureSummary {
  id: string;
  organizationId: string;
  seasonId: string;
  divisionId: string | null;
  round: number | null;
  homeEntryId: string;
  awayEntryId: string | null;
  schedulingEventId: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  status: FixtureStatus;
  revision: number;
}

export type FixtureOutcome = 'played' | 'forfeit' | 'abandoned';

export interface FixturePort {
  findFixture(organizationId: string, fixtureId: string, trx?: Trx): Promise<FixtureSummary | null>;
  listSeasonFixtures(
    organizationId: string,
    seasonId: string,
    trx?: Trx,
  ): Promise<FixtureSummary[]>;
  fixturesOfEntry(
    organizationId: string,
    teamEntryId: string,
    window?: { from?: Date; to?: Date },
    trx?: Trx,
  ): Promise<FixtureSummary[]>;
  /**
   * Results (part 2) move a fixture to played, forfeit or abandoned inside the caller's
   * transaction; the fixture machine guards the source state and an audit record is written.
   */
  recordOutcome(
    trx: Trx,
    principal: Principal,
    fixtureId: string,
    outcome: FixtureOutcome,
    reason: string,
    correlationId: string | null,
  ): Promise<FixtureSummary>;
}
export const FIXTURE_PORT = Symbol('FIXTURE_PORT');

export interface EvaluatePlayerOptions {
  /** The membership being considered (default active). Guests never bypass eligibility (SPK-CAP-004). */
  membershipStatus?: RosterPlayingStatus;
  /** Checks conflicting participation and the opposing roster for this fixture. */
  fixtureId?: string | null;
  /** Staff may satisfy "required approvals"; captains cannot. */
  actorIsStaff?: boolean;
  /** Evaluate a player who already is on the roster (readiness) rather than a new addition. */
  existingMembership?: boolean;
  /**
   * The reasons reach a caller who is not staff (a captain, co-captain, player or guardian): no
   * restricted record ids and no person-derived detail such as a computed age or other-team
   * counts (SPK-CAP-002, SPK-DISC-004). Codes, limits and reference dates stay.
   */
  restricted?: boolean;
}

/** SPK-CAP-004, SPK-COMP-005: explainable eligibility with reason, source, responsible role and action. */
export interface EligibilityPort {
  evaluatePlayer(
    organizationId: string,
    teamEntryId: string,
    personId: string,
    at: Date,
    options?: EvaluatePlayerOptions,
    trx?: Trx,
  ): Promise<EligibilityEvaluation>;
}
export const ELIGIBILITY_PORT = Symbol('ELIGIBILITY_PORT');

export interface ActiveSuspension {
  id: string;
  reason: string;
  /** e.g. 'competition', 'season', 'organization' */
  scope: string;
  until: string | null;
}

export interface SuspensionScope {
  competitionId: string;
  seasonId: string;
  teamEntryId: string;
}

/**
 * Suspension status (SPK-CAP-004, SPK-AT-013). The module's discipline records (part 2,
 * `DisciplineService`) answer by default; an implementation registered under
 * SUSPENSION_CHECK_IMPL elsewhere takes precedence. `noSuspensions` is a test convenience.
 */
export interface SuspensionCheckPort {
  activeSuspensions(
    organizationId: string,
    personId: string,
    at: Date,
    scope: SuspensionScope,
    trx?: Trx,
  ): Promise<ActiveSuspension[]>;
}
export const SUSPENSION_CHECK_PORT = Symbol('SUSPENSION_CHECK_PORT');
export const SUSPENSION_CHECK_IMPL = Symbol('SUSPENSION_CHECK_IMPL');
export const noSuspensions: SuspensionCheckPort = {
  activeSuspensions: async () => [],
};

export interface ReadinessIssue {
  code: string;
  severity: EligibilitySeverity;
  message: string;
  source: { type: string; id: string | null };
  responsibleRole: string;
  requiredAction: string;
  deadline: string | null;
}

export interface ReadinessCheckContext {
  organizationId: string;
  fixtureId: string;
  at: Date;
  trx?: Trx;
}

export type ReadinessCheck = (context: ReadinessCheckContext) => Promise<ReadinessIssue[]>;

/**
 * SPK-READY-001: workforce (officials), finance (financial conditions), facilities (field status)
 * and others register checks by stable name; the readiness evaluator (part 2) runs them all.
 */
export interface ReadinessCheckRegistry {
  registerCheck(name: string, check: ReadinessCheck): void;
  checks(): Array<{ name: string; check: ReadinessCheck }>;
}
export const READINESS_CHECK_REGISTRY = Symbol('READINESS_CHECK_REGISTRY');

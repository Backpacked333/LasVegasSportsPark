export * from './competition.module';
export * from './competition.actions';
export * from './competition.events';
export * from './competition.state-machines';
export * from './ports';
export * from './competition-matches.actions';
export * from './competition-matches.events';
export * from './competition-matches.ports';
export * from './competition-matches.state-machines';
export {
  proposedRuleSetContent,
  TEAM_INVITATION_DEFAULT_HOURS,
  WORKSPACE_UPCOMING_FIXTURES,
} from './competition.policy';
export {
  FAIR_PLAY_POINTS,
  DEFAULT_SEARCH_SETTINGS,
  RESULT_CORRECTION_REVIEW,
  INCOMPLETE_SEASON,
  DISCIPLINE_MANAGER_ROLES,
  UNSCHEDULED_FIXTURE_DEADLINE_DAYS,
  unscheduledFixtureDeadline,
} from './competition-matches.policy';
export {
  ageOn,
  referenceDateFor,
  isEffectiveAt,
  PLAYING_STATUSES,
  ROSTER_LIMIT_STATUSES,
} from './competition.shared';
export { CompetitionsService } from './services/competitions.service';
export { SeasonsService } from './services/seasons.service';
export { TeamsService } from './services/teams.service';
export { TeamEntriesService, indicatorOf } from './services/team-entries.service';
export { RosterService } from './services/roster.service';
export { EligibilityService } from './services/eligibility.service';
export { FixturesService } from './services/fixtures.service';
export { TeamAuthority } from './services/team-authority.service';
export { InMemoryReadinessCheckRegistry } from './services/readiness-check.registry';
export { ResultsService } from './services/results.service';
export { StandingsService } from './services/standings.service';
export { BracketsService, type CorrectionImpact } from './services/brackets.service';
export { DisciplineService } from './services/discipline.service';
export { DisputesService } from './services/disputes.service';
export {
  FixtureGenerationService,
  assertSpecificationConsistent,
} from './services/fixture-generation.service';
export {
  ReadinessService,
  WORKFORCE_CHECK_PREFIX,
  statusOf as readinessStatusOf,
} from './services/readiness.service';
export { FixtureObligationsService } from './services/fixture-obligations.service';
export {
  computeStandings,
  type OfficialResultInput,
  type StandingsEntry,
  type StandingsComputation,
} from './matches/standings.calculator';
export {
  generateFixtures,
  roundRobin,
  validateCompleteness,
  type GeneratorInput,
  type GeneratorResult,
} from './matches/fixture-generator';
export * from './testing/competition-fixtures';
export * from './testing/competition-matches-fixtures';

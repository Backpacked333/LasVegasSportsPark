import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry, TEAM_AUTHORITY_IMPL, lazyPort } from '../../kernel';
import { IdentityModule } from '../identity';
import { EventChanged, FIXTURE_OBLIGATION_IMPL, SchedulingModule } from '../scheduling';
import {
  ASSIGNMENT_CHECK_IMPL,
  ASSIGNMENT_CHECK_PORT,
  FINANCIAL_CONDITIONS_IMPL,
  FINANCIAL_CONDITIONS_PORT,
  FORMS_CHECK_IMPL,
  FORMS_CHECK_PORT,
  financialConditionsUnknown,
  formsUnknown,
  noAssignments,
  type AssignmentCheckPort,
  type FinancialConditionsPort,
  type FormsCheckPort,
} from './competition-matches.ports';
import { BracketsController } from './controllers/brackets.controller';
import { CompetitionsController } from './controllers/competitions.controller';
import { DisciplineController } from './controllers/discipline.controller';
import { DisputesController } from './controllers/disputes.controller';
import { FixtureGenerationController } from './controllers/fixture-generation.controller';
import { FixturesController } from './controllers/fixtures.controller';
import { ReadinessController } from './controllers/readiness.controller';
import { ResultsController } from './controllers/results.controller';
import { RosterController } from './controllers/roster.controller';
import { SeasonsController } from './controllers/seasons.controller';
import { TeamEntriesController } from './controllers/team-entries.controller';
import { TeamsController } from './controllers/teams.controller';
import {
  ELIGIBILITY_PORT,
  FIXTURE_PORT,
  READINESS_CHECK_REGISTRY,
  ROSTER_PORT,
  SUSPENSION_CHECK_IMPL,
  SUSPENSION_CHECK_PORT,
  TEAM_ENTRY_QUERY_PORT,
  noSuspensions,
  type SuspensionCheckPort,
} from './ports';
import { BracketsService } from './services/brackets.service';
import { CompetitionsService } from './services/competitions.service';
import { DisciplineService } from './services/discipline.service';
import { DisputesService } from './services/disputes.service';
import { EligibilityService } from './services/eligibility.service';
import { FixtureGenerationService } from './services/fixture-generation.service';
import { FixtureObligationsService } from './services/fixture-obligations.service';
import { FixturesService } from './services/fixtures.service';
import { InMemoryReadinessCheckRegistry } from './services/readiness-check.registry';
import { ReadinessService } from './services/readiness.service';
import { ResultsService } from './services/results.service';
import { RosterService } from './services/roster.service';
import { SeasonsService } from './services/seasons.service';
import { StandingsService } from './services/standings.service';
import { TeamAuthority } from './services/team-authority.service';
import { TeamEntriesService } from './services/team-entries.service';
import { TeamsService } from './services/teams.service';

const providers: Provider[] = [
  TeamAuthority,
  // Kernel registration: the authorization step "team role" reads effective team_roles rows.
  { provide: TEAM_AUTHORITY_IMPL, useExisting: TeamAuthority },
  // Discipline (part 2) is the suspension authority (SPK-CAP-004 "suspension status", SPK-AT-013).
  // The port stays lazy so the eligibility service and the discipline service have no cycle.
  {
    provide: SUSPENSION_CHECK_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): SuspensionCheckPort =>
      lazyPort<SuspensionCheckPort>(
        moduleRef,
        SUSPENSION_CHECK_IMPL,
        noSuspensions,
        'no SUSPENSION_CHECK_IMPL registered: eligibility evaluates without suspensions',
      ),
  },
  { provide: SUSPENSION_CHECK_IMPL, useExisting: DisciplineService },
  { provide: READINESS_CHECK_REGISTRY, useClass: InMemoryReadinessCheckRegistry },
  // Ports other modules fill in later (workforce assignments, catalog forms, finance conditions):
  // deterministic defaults report "unknown", never "ok" (SPK-READY-002).
  {
    provide: ASSIGNMENT_CHECK_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): AssignmentCheckPort =>
      lazyPort<AssignmentCheckPort>(
        moduleRef,
        ASSIGNMENT_CHECK_IMPL,
        noAssignments,
        'no ASSIGNMENT_CHECK_IMPL registered: only league administration may submit results',
      ),
  },
  {
    provide: FORMS_CHECK_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): FormsCheckPort =>
      lazyPort<FormsCheckPort>(
        moduleRef,
        FORMS_CHECK_IMPL,
        formsUnknown,
        'no FORMS_CHECK_IMPL registered: required forms are reported as unknown',
      ),
  },
  {
    provide: FINANCIAL_CONDITIONS_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): FinancialConditionsPort =>
      lazyPort<FinancialConditionsPort>(
        moduleRef,
        FINANCIAL_CONDITIONS_IMPL,
        financialConditionsUnknown,
        'no FINANCIAL_CONDITIONS_IMPL registered: financial conditions are reported as unknown',
      ),
  },
  CompetitionsService,
  SeasonsService,
  TeamsService,
  EligibilityService,
  TeamEntriesService,
  RosterService,
  FixturesService,
  StandingsService,
  BracketsService,
  DisciplineService,
  ResultsService,
  DisputesService,
  FixtureGenerationService,
  ReadinessService,
  FixtureObligationsService,
  // Scheduling publication step 4 (SPK-SCHED-006, SPK-FIX-002) resolves this lazily by token.
  { provide: FIXTURE_OBLIGATION_IMPL, useExisting: FixtureObligationsService },
  { provide: TEAM_ENTRY_QUERY_PORT, useExisting: TeamEntriesService },
  { provide: ROSTER_PORT, useExisting: RosterService },
  { provide: FIXTURE_PORT, useExisting: FixturesService },
  { provide: ELIGIBILITY_PORT, useExisting: EligibilityService },
];

/**
 * CompetitionModule (specification §3.4 SPK-COMP-001..005, §3.5 SPK-CAP-001..005, §3.8
 * SPK-FIX-001..005, §3.9 SPK-READY-001..004, §3.11 SPK-RESULT-001..005, §3.12 SPK-DISC-001..005,
 * §4.4 Competition, Matches and Discipline, SPK-STAFF-005, SPK-AT-002/003/010/011/013/014).
 * Part 1 owns the core model (competitions, rule-set versions, seasons, divisions, teams, entries,
 * roles, rosters, invitations, join requests, fixtures, RSVPs); part 2 adds result revisions,
 * standings, brackets, fixture specifications and solver runs, incidents, decisions, suspensions,
 * disputes, appeals and the readiness evaluator. Registers the kernel's team authority, the
 * scheduling module's fixture-obligation check and its own suspension authority; it never writes
 * identity or scheduling tables (§4.2).
 */
@Module({
  imports: [IdentityModule, SchedulingModule],
  providers,
  controllers: [
    CompetitionsController,
    SeasonsController,
    TeamsController,
    TeamEntriesController,
    RosterController,
    FixturesController,
    ResultsController,
    BracketsController,
    FixtureGenerationController,
    ReadinessController,
    DisputesController,
    DisciplineController,
  ],
  exports: [
    CompetitionsService,
    SeasonsService,
    TeamsService,
    EligibilityService,
    TeamEntriesService,
    RosterService,
    FixturesService,
    StandingsService,
    BracketsService,
    DisciplineService,
    ResultsService,
    DisputesService,
    FixtureGenerationService,
    ReadinessService,
    FixtureObligationsService,
    TeamAuthority,
    TEAM_AUTHORITY_IMPL,
    FIXTURE_OBLIGATION_IMPL,
    TEAM_ENTRY_QUERY_PORT,
    ROSTER_PORT,
    FIXTURE_PORT,
    ELIGIBILITY_PORT,
    SUSPENSION_CHECK_PORT,
    SUSPENSION_CHECK_IMPL,
    READINESS_CHECK_REGISTRY,
    ASSIGNMENT_CHECK_PORT,
    FORMS_CHECK_PORT,
    FINANCIAL_CONDITIONS_PORT,
  ],
})
export class CompetitionModule implements OnModuleInit {
  constructor(
    private readonly registry: EventHandlerRegistry,
    private readonly fixtures: FixturesService,
  ) {}

  onModuleInit(): void {
    // The scheduling module owns time and space; a fixture keeps a copy of its event's instants and
    // follows moves and cancellations made directly in scheduling (idempotent under replay).
    this.registry.on<EventPayload<typeof EventChanged>>(
      EventChanged.type,
      'competition.sync_fixture_schedule',
      async (event, ctx) => {
        await this.fixtures.onSchedulingEventChanged(event, ctx);
      },
    );
  }
}

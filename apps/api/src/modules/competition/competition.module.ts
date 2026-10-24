import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry, TEAM_AUTHORITY_IMPL, lazyPort } from '../../kernel';
import { IdentityModule } from '../identity';
import { EventChanged, SchedulingModule } from '../scheduling';
import { CompetitionsController } from './controllers/competitions.controller';
import { FixturesController } from './controllers/fixtures.controller';
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
import { CompetitionsService } from './services/competitions.service';
import { EligibilityService } from './services/eligibility.service';
import { FixturesService } from './services/fixtures.service';
import { InMemoryReadinessCheckRegistry } from './services/readiness-check.registry';
import { RosterService } from './services/roster.service';
import { SeasonsService } from './services/seasons.service';
import { TeamAuthority } from './services/team-authority.service';
import { TeamEntriesService } from './services/team-entries.service';
import { TeamsService } from './services/teams.service';

const providers: Provider[] = [
  TeamAuthority,
  // Kernel registration: the authorization step "team role" reads effective team_roles rows.
  { provide: TEAM_AUTHORITY_IMPL, useExisting: TeamAuthority },
  // Discipline (part 2) registers SUSPENSION_CHECK_IMPL; until then no suspensions exist
  // (SPK-CAP-004 "suspension status", SPK-AT-013). Resolved lazily so there is no import cycle.
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
  { provide: READINESS_CHECK_REGISTRY, useClass: InMemoryReadinessCheckRegistry },
  CompetitionsService,
  SeasonsService,
  TeamsService,
  EligibilityService,
  TeamEntriesService,
  RosterService,
  FixturesService,
  { provide: TEAM_ENTRY_QUERY_PORT, useExisting: TeamEntriesService },
  { provide: ROSTER_PORT, useExisting: RosterService },
  { provide: FIXTURE_PORT, useExisting: FixturesService },
  { provide: ELIGIBILITY_PORT, useExisting: EligibilityService },
];

/**
 * CompetitionModule, part 1: the core model (specification §3.4 SPK-COMP-001..005, §3.5
 * SPK-CAP-001..005, §4.4 Competition and Matches (Fixture), §4.5 "Team must separate continuing
 * identity from season entry", SPK-AT-002/003/013 roster parts). Owns competitions, rule-set
 * versions, seasons, divisions, teams, team entries, team roles, roster memberships, invitations,
 * join requests, fixtures and availability responses. Results, standings, brackets, discipline and
 * the readiness evaluator are part 2. Registers the kernel's team authority and exposes the ports
 * other modules call (README.md); it never writes identity or scheduling tables (§4.2).
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
  ],
  exports: [
    CompetitionsService,
    SeasonsService,
    TeamsService,
    EligibilityService,
    TeamEntriesService,
    RosterService,
    FixturesService,
    TeamAuthority,
    TEAM_AUTHORITY_IMPL,
    TEAM_ENTRY_QUERY_PORT,
    ROSTER_PORT,
    FIXTURE_PORT,
    ELIGIBILITY_PORT,
    SUSPENSION_CHECK_PORT,
    READINESS_CHECK_REGISTRY,
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

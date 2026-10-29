import { Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry, lazyPort } from '../../kernel';
import { CatalogEvents, CatalogModule } from '../catalog';
import {
  ASSIGNMENT_CHECK_IMPL,
  CompetitionEvents,
  CompetitionModule,
  READINESS_CHECK_REGISTRY,
  type ReadinessCheckRegistry,
} from '../competition';
import { IdentityModule } from '../identity';
import {
  ConflictDetector,
  EventChanged,
  PartyCommitmentSources,
  SchedulingModule,
} from '../scheduling';
import { AssignmentsController } from './controllers/assignments.controller';
import { AvailabilityController } from './controllers/availability.controller';
import { FeesController } from './controllers/fees.controller';
import { QualificationsController } from './controllers/qualifications.controller';
import { RequirementsController } from './controllers/requirements.controller';
import { WorkspaceController } from './controllers/workspace.controller';
import {
  ASSIGNMENT_COVERAGE_PORT,
  unavailableWorkforceStaffing,
  WORKFORCE_STAFFING_IMPL,
  WORKFORCE_STAFFING_PORT,
  type WorkforceStaffingPort,
} from './ports';
import { AssignmentsService } from './services/assignments.service';
import { AvailabilityService } from './services/availability.service';
import { CommitmentChecker } from './services/commitment-checker';
import { CoverageService } from './services/coverage.service';
import { FeesService } from './services/fees.service';
import { QualificationsService } from './services/qualifications.service';
import { ReplacementsService } from './services/replacements.service';
import { RequirementsService } from './services/requirements.service';
import { TargetResolver } from './services/target-resolver';
import { TemporaryAccessService } from './services/temporary-access.service';
import { WorkspaceService } from './services/workspace.service';
import {
  DEFAULT_WORKFORCE_POLICY,
  REQUIRED_OFFICIALS_CHECK,
  WORKFORCE_POLICY,
} from './workforce.policy';

const providers: Provider[] = [
  { provide: WORKFORCE_POLICY, useValue: DEFAULT_WORKFORCE_POLICY },
  // Scheduling's exported, dependency-free conflict detector: workforce reads scheduling's person
  // commitments only through scheduling's own code (§4.2).
  ConflictDetector,
  TargetResolver,
  CommitmentChecker,
  AvailabilityService,
  QualificationsService,
  CoverageService,
  RequirementsService,
  TemporaryAccessService,
  AssignmentsService,
  ReplacementsService,
  FeesService,
  WorkspaceService,
  // Competition resolves these lazily by token (results by accepted officials, SPK-STAFF-005).
  { provide: ASSIGNMENT_CHECK_IMPL, useExisting: CoverageService },
  { provide: ASSIGNMENT_COVERAGE_PORT, useExisting: CoverageService },
  // IF-32: declared by stage 3; WRK-02 registers WORKFORCE_STAFFING_IMPL.
  {
    provide: WORKFORCE_STAFFING_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): WorkforceStaffingPort =>
      lazyPort(
        moduleRef,
        WORKFORCE_STAFFING_IMPL,
        unavailableWorkforceStaffing,
        'no WORKFORCE_STAFFING_IMPL registered: booking staffing cannot be declared (WRK-02)',
      ),
  },
];

/**
 * WorkforceModule (specification §3.10 SPK-STAFF-001..006, §2.4 SPK-UX-007, §4.4 Workforce,
 * §4.6 Assignment machine, SPK-AT-012). Owns availability, qualifications, assignment
 * requirements, assignments, fee submissions, fee adjustments and fee export batches. Registers
 * the `workforce.required_officials` readiness check and competition's assignment check; follows
 * fixture, event and session changes through outbox handlers. It never writes identity,
 * scheduling, competition or catalog tables (§4.2): time-bounded access goes through identity's
 * StaffMembershipsService.
 */
@Module({
  imports: [IdentityModule, SchedulingModule, CompetitionModule, CatalogModule],
  providers,
  controllers: [
    AvailabilityController,
    QualificationsController,
    RequirementsController,
    AssignmentsController,
    FeesController,
    WorkspaceController,
  ],
  exports: [
    AvailabilityService,
    QualificationsService,
    CoverageService,
    RequirementsService,
    AssignmentsService,
    ReplacementsService,
    FeesService,
    WorkspaceService,
    WORKFORCE_POLICY,
    ASSIGNMENT_CHECK_IMPL,
    ASSIGNMENT_COVERAGE_PORT,
    WORKFORCE_STAFFING_PORT,
  ],
})
export class WorkforceModule implements OnModuleInit {
  constructor(
    private readonly registry: EventHandlerRegistry,
    @Inject(READINESS_CHECK_REGISTRY) private readonly readiness: ReadinessCheckRegistry,
    private readonly coverage: CoverageService,
    private readonly assignments: AssignmentsService,
    private readonly checker: CommitmentChecker,
    private readonly partySources: PartyCommitmentSources,
  ) {}

  onModuleInit(): void {
    // SPK-STAFF-003, SPK-SCHED-004: scheduling refuses to commit a person an accepted assignment
    // holds (official or assigned coach overlap), under the party lock both modules take.
    this.partySources.register({
      id: 'workforce.assignments',
      partyTypes: ['person'],
      held: (trx, organizationId, _partyType, personId, range, ignoreEventIds) =>
        this.checker.held(trx, organizationId, personId, range, ignoreEventIds),
    });
    // SPK-STAFF-002 / SPK-READY-001: required officials are satisfied only by accepted assignments.
    this.readiness.registerCheck(REQUIRED_OFFICIALS_CHECK, (context) =>
      this.coverage.readinessIssues(context),
    );
    // Assignments copy their target's time; they follow moves and cancellations (idempotent).
    this.registry.on<EventPayload<typeof CompetitionEvents.fixtureChanged>>(
      CompetitionEvents.fixtureChanged.type,
      'workforce.follow_fixture',
      async (event, ctx) => {
        await this.assignments.onFixtureChanged(event, ctx);
      },
      { failureOwner: 'league_manager' },
    );
    this.registry.on<EventPayload<typeof EventChanged>>(
      EventChanged.type,
      'workforce.follow_event',
      async (event, ctx) => {
        await this.assignments.onSchedulingEventChanged(event, ctx);
      },
      { failureOwner: 'scheduler' },
    );
    this.registry.on<EventPayload<typeof CatalogEvents.sessionCanceled>>(
      CatalogEvents.sessionCanceled.type,
      'workforce.follow_session',
      async (event, ctx) => {
        await this.assignments.onSessionCanceled(event, ctx);
      },
      { failureOwner: 'program_manager' },
    );
  }
}

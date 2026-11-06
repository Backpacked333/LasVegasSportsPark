import { Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry, lazyPort, MODULE_SETTINGS, moduleSettings } from '../../kernel';
import { CatalogEvents, CatalogModule } from '../catalog';
import { CommunicationsModule } from '../communications';
import {
  ASSIGNMENT_CHECK_IMPL,
  CompetitionEvents,
  CompetitionModule,
  READINESS_CHECK_REGISTRY,
  type ReadinessCheckRegistry,
} from '../competition';
import { IdentityEvents, IdentityModule } from '../identity';
import {
  ClosureImpactContributors,
  ConflictDetector,
  EventChanged,
  PartyCommitmentSources,
  SchedulingModule,
} from '../scheduling';
import { AssignedStaffController } from './controllers/assigned-staff.controller';
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
import { AssignmentNotices } from './services/assignment-notices';
import { AssignedStaffService } from './services/assigned-staff.service';
import { AssignmentsService } from './services/assignments.service';
import { AvailabilityService } from './services/availability.service';
import { CommitmentChecker } from './services/commitment-checker';
import { CoverageService } from './services/coverage.service';
import { FeesService } from './services/fees.service';
import { MergedPersons } from './services/merged-persons';
import { PersonMergeFollowUp } from './services/person-merge-follow-up';
import { QualificationsService } from './services/qualifications.service';
import { ReplacementsService } from './services/replacements.service';
import { RequirementsService } from './services/requirements.service';
import { StaffingService } from './services/staffing.service';
import { TargetResolver } from './services/target-resolver';
import { TemporaryAccessService } from './services/temporary-access.service';
import { WorkspaceService } from './services/workspace.service';
import { WorkforceEvents } from './workforce.events';
import {
  REQUIRED_OFFICIALS_CHECK,
  WORKFORCE_POLICY,
  workforcePolicyFromSettings,
} from './workforce.policy';
import { WorkforceSettings, type WorkforceSettingsValue } from './workforce.settings';

const providers: Provider[] = [
  // WRK-06 (DEC-011 / POL-033 pending): policy values are module settings with no default.
  moduleSettings(WorkforceSettings.module),
  {
    provide: WORKFORCE_POLICY,
    inject: [MODULE_SETTINGS(WorkforceSettings.module)],
    useFactory: (settings: WorkforceSettingsValue) => workforcePolicyFromSettings(settings),
  },
  MergedPersons,
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
  StaffingService,
  AssignedStaffService,
  AssignmentNotices,
  PersonMergeFollowUp,
  // Competition resolves these lazily by token (results by accepted officials, SPK-STAFF-005).
  { provide: ASSIGNMENT_CHECK_IMPL, useExisting: CoverageService },
  { provide: ASSIGNMENT_COVERAGE_PORT, useExisting: CoverageService },
  // IF-32 (WRK-02): booking staffing, resolved lazily by enrollment through the port.
  { provide: WORKFORCE_STAFFING_IMPL, useExisting: StaffingService },
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
 *
 * Stage 3: provides WORKFORCE_STAFFING_PORT (IF-32, WRK-02) for enrollment's booking events and
 * ASSIGNMENT_COVERAGE_PORT.isAcceptedOnOffering (IF-34, WRK-03); composes its own assignment
 * notices through communications' NotificationsService (IF-22, WRK-04); follows
 * identity.persons_merged (IF-21, WRK-05); reads its policy from module settings with no
 * defaults (IF-43, WRK-06).
 */
@Module({
  // Communications does not import workforce (IF-22), so workforce composes its own notices.
  imports: [
    IdentityModule,
    SchedulingModule,
    CompetitionModule,
    CatalogModule,
    CommunicationsModule,
  ],
  providers,
  controllers: [
    AvailabilityController,
    QualificationsController,
    RequirementsController,
    AssignmentsController,
    FeesController,
    WorkspaceController,
    AssignedStaffController,
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
    AssignedStaffService,
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
    private readonly notices: AssignmentNotices,
    private readonly mergeFollowUp: PersonMergeFollowUp,
    private readonly impactContributors: ClosureImpactContributors,
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
    // SPK-SCHED-009 / R3-TRACE-A-06: a closure preview names the staff whose live assignments
    // (proposed, offered or accepted) are on the affected events. Read through the preview's own
    // executor, so an applied closure reads inside its transaction. Always answers `staff` ([] for
    // none): returning it is what marks staff as identified.
    this.impactContributors.register(
      'workforce.staff_assignments',
      async (db, organizationId, events) => {
        if (events.length === 0) return { staff: [] };
        const rows = await db
          .selectFrom('assignments')
          .select(['id', 'person_id', 'scheduling_event_id', 'kind', 'role', 'status'])
          .where('organization_id', '=', organizationId)
          .where(
            'scheduling_event_id',
            'in',
            events.map((e) => e.eventId),
          )
          .where('status', 'in', ['proposed', 'offered', 'accepted'])
          .orderBy('id')
          .execute();
        return {
          staff: rows.map((r) => ({
            assignmentId: r.id,
            personId: r.person_id,
            eventId: r.scheduling_event_id as string,
            kind: r.kind,
            role: r.role,
            status: r.status,
          })),
        };
      },
    );
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
    // R2-JOURNEYS-03 (SPK-AT-009, SPK-STAFF-003): a session moved with its scheduling event moves
    // its live assignments, checked again at the new time.
    this.registry.on<EventPayload<typeof CatalogEvents.sessionRetimed>>(
      CatalogEvents.sessionRetimed.type,
      'workforce.follow_session_retimed',
      async (event, ctx) => {
        await this.assignments.onSessionRetimed(event, ctx);
      },
      { failureOwner: 'program_manager' },
    );
    // WRK-04, SPK-COMMS-002 (offer, schedule change, cancellation), SPK-COMMS-005, IF-22: this
    // module's own notices to assignees.
    this.registry.on<EventPayload<typeof WorkforceEvents.assignmentChanged>>(
      WorkforceEvents.assignmentChanged.type,
      'workforce.assignment_offer_notice',
      async (event, ctx) => {
        await this.notices.onAssignmentChanged(event, ctx);
      },
      { failureOwner: 'scheduler' },
    );
    // WRK-05, SPK-IAM-007, IF-21: a merge never rewrites workforce rows; overlaps are escalated.
    this.registry.on<EventPayload<typeof IdentityEvents.personsMerged>>(
      IdentityEvents.personsMerged.type,
      'workforce.follow_person_merge',
      async (event, ctx) => {
        await this.mergeFollowUp.onPersonsMerged(event, ctx);
      },
      { failureOwner: 'scheduler' },
    );
  }
}

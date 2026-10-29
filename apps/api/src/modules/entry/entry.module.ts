import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { APP_CONFIG, Inbox, lazyPort, type AppConfig } from '../../kernel';
import { CatalogModule } from '../catalog';
import { CompetitionModule } from '../competition';
import { EnrollmentModule } from '../enrollment';
import { ParticipationStandingService } from '../finance';
import { IdentityModule } from '../identity';
import { SchedulingModule } from '../scheduling';
import { WorkforceModule } from '../workforce';
import {
  AccessControlWebhooksController,
  AttendanceController,
  OccupancyController,
  OfflineSyncController,
  ReleasesController,
} from './controllers/attendance.controller';
import {
  DeparturesController,
  PassesController,
  SessionCheckinsController,
  VisitsController,
} from './controllers/arrival.controller';
import { DEFAULT_ENTRY_POLICY, ENTRY_POLICY } from './entry.policy';
import {
  ACCESS_DEVICE_PORT,
  ATTENDANCE_PORT,
  FINANCIAL_STANDING_IMPL,
  FINANCIAL_STANDING_PORT,
  unknownFinancialStanding,
  type AccessDevicePort,
  type FinancialStandingPort,
} from './entry.ports';
import {
  FAKE_ACCESS_CONTROL_PROVIDER,
  FakeAccessControlProvider,
} from './providers/fake-access-control.provider';
import { AccessEventsService } from './services/access-events.service';
import { ActivityResolver } from './services/activity-resolver';
import { ArrivalChecks } from './services/arrival-checks';
import { AttendanceService } from './services/attendance.service';
import { CheckinsService } from './services/checkins.service';
import { OccupancyService } from './services/occupancy.service';
import { OfflineSyncService } from './services/offline-sync.service';
import { PassesService } from './services/passes.service';
import { ReleasesService } from './services/releases.service';
import { StaffScope } from './services/staff-scope';
import { VisitsService } from './services/visits.service';

const providers: Provider[] = [
  // Policy values the specification leaves to operators (DEC-005, DEC-033, DEC-034, DEC-056,
  // DEC-075): the specification's proposed defaults, overridable per facility.
  { provide: ENTRY_POLICY, useValue: DEFAULT_ENTRY_POLICY },
  // SPK-ENTRY-004: the participant's standing comes from finance's ParticipationStandingService
  // when the finance module is part of the application (finance precedes entry in §4.2 order, so
  // entry looks it up; nothing here imports finance's module). An explicit FINANCIAL_STANDING_IMPL
  // takes precedence (tests script it); without either, every standing is `unknown` and never
  // blocks. Resolved lazily so module order does not matter at construction.
  {
    provide: FINANCIAL_STANDING_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): FinancialStandingPort =>
      lazyPort<FinancialStandingPort>(
        moduleRef,
        FINANCIAL_STANDING_IMPL,
        lazyPort<FinancialStandingPort>(
          moduleRef,
          ParticipationStandingService,
          unknownFinancialStanding,
          'no finance module is part of the application: arrival checks report the balance as unknown',
        ),
        null,
      ),
  },
  // Provider-selection gate (§5.2, DEC-023): the deterministic fake is the only hardware adapter.
  FakeAccessControlProvider,
  // IF-38 (declared by stage 3; ENT-05 uses it): device commands go to the fake, refused in
  // production like every fake adapter.
  {
    provide: ACCESS_DEVICE_PORT,
    inject: [APP_CONFIG, FakeAccessControlProvider],
    useFactory: (config: AppConfig, fake: FakeAccessControlProvider): AccessDevicePort => {
      if (config.NODE_ENV === 'production') {
        throw new Error(
          'No access hardware is selected (specification §5.2, DEC-023): implement the adapter behind AccessDevicePort before production.',
        );
      }
      return fake;
    },
  },
  ActivityResolver,
  ArrivalChecks,
  StaffScope,
  VisitsService,
  PassesService,
  CheckinsService,
  AttendanceService,
  ReleasesService,
  OfflineSyncService,
  OccupancyService,
  AccessEventsService,
  { provide: ATTENDANCE_PORT, useExisting: AttendanceService },
];

/**
 * EntryModule (specification §3.14 SPK-ENTRY-001..008, §4.4 Arrival, §4.5, §4.8
 * POST /v1/attendance-observations and POST /v1/releases, §4.15, SPK-COND-004, SPK-AT-015/016/018).
 * Owns passes, visits, session check-ins, attendance observations and corrections, departures,
 * release records, offline synchronization batches and occupancy snapshots. Reads people,
 * households and current authority from identity, sessions and forms from catalog, events from
 * scheduling, fixtures and rosters from competition, enrollments and bookings from enrollment and
 * assignments from workforce — always through their exported services and ports. See README.md.
 */
@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    SchedulingModule,
    CompetitionModule,
    EnrollmentModule,
    WorkforceModule,
  ],
  providers,
  controllers: [
    PassesController,
    VisitsController,
    DeparturesController,
    SessionCheckinsController,
    AttendanceController,
    ReleasesController,
    OfflineSyncController,
    OccupancyController,
    AccessControlWebhooksController,
  ],
  exports: [
    ENTRY_POLICY,
    FINANCIAL_STANDING_PORT,
    ATTENDANCE_PORT,
    ACCESS_DEVICE_PORT,
    FakeAccessControlProvider,
    VisitsService,
    PassesService,
    CheckinsService,
    AttendanceService,
    ReleasesService,
    OfflineSyncService,
    OccupancyService,
  ],
})
export class EntryModule implements OnModuleInit {
  constructor(
    private readonly inbox: Inbox,
    private readonly accessEvents: AccessEventsService,
  ) {}

  onModuleInit(): void {
    // SPK-COND-004: hardware access is recorded as a facility arrival and nothing else.
    this.inbox.on(FAKE_ACCESS_CONTROL_PROVIDER, 'entry.access_event', (event, ctx) =>
      this.accessEvents.handle(event, ctx.trx),
    );
  }
}

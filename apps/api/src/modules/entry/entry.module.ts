import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Inbox, lazyPort } from '../../kernel';
import { CatalogModule } from '../catalog';
import { CompetitionModule } from '../competition';
import { EnrollmentModule } from '../enrollment';
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
  ATTENDANCE_PORT,
  FINANCIAL_STANDING_IMPL,
  FINANCIAL_STANDING_PORT,
  unknownFinancialStanding,
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
  // Finance registers FINANCIAL_STANDING_IMPL; until then every standing is `unknown` and never
  // blocks (SPK-ENTRY-004). Resolved lazily so there is no import cycle.
  {
    provide: FINANCIAL_STANDING_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): FinancialStandingPort =>
      lazyPort<FinancialStandingPort>(
        moduleRef,
        FINANCIAL_STANDING_IMPL,
        unknownFinancialStanding,
        'no FINANCIAL_STANDING_IMPL registered: arrival checks report the balance as unknown',
      ),
  },
  // Provider-selection gate (§5.2, DEC-023): the deterministic fake is the only hardware adapter.
  FakeAccessControlProvider,
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

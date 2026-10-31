import { Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EventPayload } from '@sportspark/contracts';
import {
  APP_CONFIG,
  EventHandlerRegistry,
  Inbox,
  INTEGRATION_REGISTRY,
  lazyPort,
  moduleSettings,
  PeriodicJobRegistry,
  runWithTransaction,
  type AppConfig,
  type IntegrationRegistryPort,
} from '../../kernel';
import { CatalogEvents, CatalogModule } from '../catalog';
import { CompetitionModule } from '../competition';
import { EnrollmentModule } from '../enrollment';
import { ParticipationStandingService } from '../finance';
import { IdentityEvents, IdentityModule } from '../identity';
import { EventChanged, SchedulingModule } from '../scheduling';
import { WorkforceModule } from '../workforce';
import { DELIVER_DEVICE_COMMANDS_JOB, DETECT_DEVICE_OUTAGES_JOB } from './access-hardware.shared';
import {
  AccessDevicesController,
  AccessPoliciesController,
} from './controllers/access-hardware.controller';
import {
  AccessControlWebhooksController,
  AttendanceController,
  OccupancyController,
  OfflineSyncController,
  ReleasesController,
} from './controllers/attendance.controller';
import {
  DeparturesController,
  MePassesController,
  PassesController,
  SessionCheckinsController,
  VisitsController,
} from './controllers/arrival.controller';
import { EntryEvents } from './entry.events';
import { EntrySettings } from './entry.settings';
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
import { AccessDevicesService } from './services/access-devices.service';
import { AccessEventsService } from './services/access-events.service';
import { ActivityResolver } from './services/activity-resolver';
import { ArrivalChecks } from './services/arrival-checks';
import { AttendanceService } from './services/attendance.service';
import { CheckinsService } from './services/checkins.service';
import { DeviceCommandQueue } from './services/device-command-queue';
import { DeviceDeliveryService } from './services/device-delivery.service';
import { EntryFollowUps } from './services/entry-follow-ups.service';
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
  // ENT-03/04: reactions to other modules' facts.
  EntryFollowUps,
  // ENT-05: access hardware (capability access_hardware, DEC-016, DEC-080; vendor DEC-023).
  moduleSettings(EntrySettings.module),
  DeviceCommandQueue,
  AccessDevicesService,
  DeviceDeliveryService,
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
    MePassesController,
    PassesController,
    VisitsController,
    DeparturesController,
    SessionCheckinsController,
    AttendanceController,
    ReleasesController,
    OfflineSyncController,
    OccupancyController,
    AccessControlWebhooksController,
    AccessDevicesController,
    AccessPoliciesController,
  ],
  exports: [
    ENTRY_POLICY,
    AccessDevicesService,
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
    private readonly registry: EventHandlerRegistry,
    private readonly periodicJobs: PeriodicJobRegistry,
    @Inject(INTEGRATION_REGISTRY) private readonly integrations: IntegrationRegistryPort,
    private readonly accessEvents: AccessEventsService,
    private readonly delivery: DeviceDeliveryService,
    private readonly followUps: EntryFollowUps,
  ) {}

  onModuleInit(): void {
    // §5.1, §5.2 (ENT-01, K-09, IF-04, IF-38): the hardware gate is pending DEC-023; the
    // deterministic fake is the only adapter, refused in production; device outcomes are
    // reconciled by the facilities operator.
    this.integrations.register({
      id: 'entry.access_device',
      gate: 'hardware',
      port: 'ACCESS_DEVICE_PORT',
      adapter: { name: FAKE_ACCESS_CONTROL_PROVIDER, kind: 'fake' },
      productionAllowed: false,
      scenarios: ['success', 'failure', 'timeout_unknown', 'duplicate'],
      reconciliationOwner: 'facilities_operator',
    });
    // SPK-COND-004: hardware access is recorded as a facility arrival and nothing else.
    this.inbox.on(FAKE_ACCESS_CONTROL_PROVIDER, 'entry.access_event', (event, ctx) =>
      this.accessEvents.handle(event, ctx.trx),
    );
    // ENT-05 (IF-38): device heartbeats and command receipts.
    this.inbox.on(FAKE_ACCESS_CONTROL_PROVIDER, 'entry.access_device_signal', (event, ctx) =>
      this.delivery.handleSignal(event, ctx.trx),
    );
    // ENT-05 (§4.12, IF-24): delivery outside transactions and outage detection.
    this.periodicJobs.register({
      name: DELIVER_DEVICE_COMMANDS_JOB,
      intervalSeconds: 60,
      failureOwner: 'facilities_operator',
      run: (context) => this.delivery.deliverDue(context),
    });
    this.periodicJobs.register({
      name: DETECT_DEVICE_OUTAGES_JOB,
      intervalSeconds: 60,
      failureOwner: 'facilities_operator',
      run: (context) => this.delivery.detectOutages(context),
    });
    // ENT-05: a revoked pass is removed from every active device (never gated, DEC-016).
    this.registry.on<EventPayload<typeof EntryEvents.passRevoked>>(
      EntryEvents.passRevoked.type,
      'entry.queue_device_revocations',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () =>
          this.delivery.passRevoked(
            ctx.trx,
            event.organizationId,
            event.payload.passId,
            event.correlationId,
          ),
        ),
      { failureOwner: 'facilities_operator' },
    );
    // ENT-03 (§4.6, §4.12, SPK-AT-009): a canceled activity withdraws its live check-ins.
    this.registry.on<EventPayload<typeof CatalogEvents.sessionCanceled>>(
      CatalogEvents.sessionCanceled.type,
      'entry.withdraw_on_session_canceled',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () => this.followUps.sessionCanceled(ctx.trx, event)),
      { failureOwner: 'front_desk' },
    );
    this.registry.on<EventPayload<typeof EventChanged>>(
      EventChanged.type,
      'entry.withdraw_on_event_canceled',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () => this.followUps.eventChanged(ctx.trx, event)),
      { failureOwner: 'front_desk' },
    );
    // ENT-04 (SPK-IAM-007): a merge that leaves two active passes is raised to the front desk.
    this.registry.on<EventPayload<typeof IdentityEvents.personsMerged>>(
      IdentityEvents.personsMerged.type,
      'entry.follow_person_merge',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () => this.followUps.personsMerged(ctx.trx, event)),
      { failureOwner: 'front_desk' },
    );
  }
}

import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry, lazyPort, runWithTransaction } from '../../kernel';
import { CatalogEvents, CatalogModule } from '../catalog';
import { CompetitionModule, FORMS_CHECK_IMPL } from '../competition';
import { SESSION_AUDIENCE_IMPL } from '../communications';
import { IdentityModule } from '../identity';
import { ClosureImpactContributors, SchedulingModule } from '../scheduling';
import { ApplicationsController } from './controllers/applications.controller';
import { BasketsController } from './controllers/baskets.controller';
import { CapacityController } from './controllers/capacity.controller';
import { EnrollmentsController } from './controllers/enrollments.controller';
import { PlacementController } from './controllers/placement.controller';
import { SessionBookingsController } from './controllers/session-bookings.controller';
import { WaitlistController } from './controllers/waitlist.controller';
import { YouthController } from './controllers/youth.controller';
import {
  CapacityReleased,
  EnrollmentEvents,
  HoldExpiryDue,
  MakeupExpiryDue,
} from './enrollment.events';
import { DEFAULT_ENROLLMENT_POLICY, ENROLLMENT_POLICY } from './enrollment.policy';
import {
  BASKET_PORT,
  CAPACITY_PORT,
  ENROLLMENT_PORT,
  FINANCE_POLICY_IMPL,
  FINANCE_POLICY_PORT,
  WAITLIST_PORT,
  noFinancialConsequence,
  type FinancePolicyPort,
} from './enrollment.ports';
import { enrollmentSystem } from './enrollment.shared';
import { ApplicationsService } from './services/applications.service';
import { BasketsService } from './services/baskets.service';
import { CapacityService } from './services/capacity.service';
import { CatalogSessions } from './services/catalog-sessions';
import { CompetitionFormsCheck } from './services/competition-forms-check';
import { EnrollmentsService } from './services/enrollments.service';
import { FamilyCalendarService } from './services/family-calendar.service';
import { MakeupsService } from './services/makeups.service';
import { PlacementService } from './services/placement.service';
import { RegistrationEvaluator } from './services/registration-evaluator';
import { SessionBookingsService } from './services/session-bookings.service';
import { SessionParticipants } from './services/session-participants';
import { TrialsService } from './services/trials.service';
import { WaitlistService } from './services/waitlist.service';

const providers: Provider[] = [
  // Policy values the specification leaves to operators (DEC-006, DEC-026..029): proposed defaults.
  { provide: ENROLLMENT_POLICY, useValue: DEFAULT_ENROLLMENT_POLICY },
  // Finance registers FINANCE_POLICY_IMPL (refund, credit, charge on transfer/cancel, DEC-009);
  // until then no financial consequence is asserted. Resolved lazily so there is no import cycle.
  {
    provide: FINANCE_POLICY_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): FinancePolicyPort =>
      lazyPort<FinancePolicyPort>(
        moduleRef,
        FINANCE_POLICY_IMPL,
        noFinancialConsequence,
        'no FINANCE_POLICY_IMPL registered: transfers and cancellations carry no financial consequence',
      ),
  },
  RegistrationEvaluator,
  CatalogSessions,
  CapacityService,
  EnrollmentsService,
  ApplicationsService,
  BasketsService,
  SessionBookingsService,
  WaitlistService,
  MakeupsService,
  TrialsService,
  PlacementService,
  FamilyCalendarService,
  SessionParticipants,
  // SPK-AT-009: communications addresses session change notices to the sessions' participants.
  { provide: SESSION_AUDIENCE_IMPL, useExisting: SessionParticipants },
  { provide: ENROLLMENT_PORT, useExisting: EnrollmentsService },
  { provide: CAPACITY_PORT, useExisting: CapacityService },
  { provide: BASKET_PORT, useExisting: BasketsService },
  { provide: WAITLIST_PORT, useExisting: WaitlistService },
  // Fixture readiness "Required forms" (SPK-READY-001): the season's registration offering's
  // required forms, checked against catalog acknowledgments.
  CompetitionFormsCheck,
  { provide: FORMS_CHECK_IMPL, useExisting: CompetitionFormsCheck },
];

/**
 * EnrollmentModule (specification §3.3 SPK-REG-001..010, §3.6 SPK-PLACE-001..005, §3.13
 * SPK-YOUTH-001..007, §4.4 Participation + Capacity, §4.6 Application/Enrollment/Placement/Hold/
 * SessionBooking machines, §4.7 invariants 2, 3, 7). Owns applications, enrollments, baskets,
 * placement requests, session bookings, capacity pools, holds, allocations, waitlists and offers,
 * makeup entitlements and redemptions, and trial participations. Reads catalog through its
 * offering/policy/pricing ports and session service, competition through its team-entry,
 * eligibility and roster ports (roster additions through its roster command), and identity through
 * its person directory and relationship authority. Exposes the ports finance and entry consume.
 * See README.md.
 */
@Module({
  imports: [IdentityModule, CatalogModule, CompetitionModule, SchedulingModule],
  providers,
  controllers: [
    ApplicationsController,
    BasketsController,
    EnrollmentsController,
    WaitlistController,
    PlacementController,
    SessionBookingsController,
    YouthController,
    CapacityController,
  ],
  exports: [
    RegistrationEvaluator,
    CapacityService,
    EnrollmentsService,
    ApplicationsService,
    BasketsService,
    SessionBookingsService,
    WaitlistService,
    MakeupsService,
    TrialsService,
    PlacementService,
    FamilyCalendarService,
    ENROLLMENT_POLICY,
    FINANCE_POLICY_PORT,
    ENROLLMENT_PORT,
    CAPACITY_PORT,
    BASKET_PORT,
    WAITLIST_PORT,
  ],
})
export class EnrollmentModule implements OnModuleInit {
  constructor(
    private readonly registry: EventHandlerRegistry,
    private readonly capacity: CapacityService,
    private readonly baskets: BasketsService,
    private readonly waitlist: WaitlistService,
    private readonly bookings: SessionBookingsService,
    private readonly makeups: MakeupsService,
    private readonly sessionParticipants: SessionParticipants,
    private readonly impactContributors: ClosureImpactContributors,
  ) {}

  onModuleInit(): void {
    // SPK-SCHED-009, SPK-AT-009: a closure preview names the enrolled and booked participants of
    // the catalog sessions behind the affected events, and the orders they paid through.
    this.impactContributors.register(
      'enrollment.session_participants',
      (db, organizationId, events) =>
        this.sessionParticipants.closureImpact(db, organizationId, events),
    );
    // Handlers run in the dispatcher's transaction; binding it as the active transaction makes every
    // port read (identity authority, catalog lookups) go through it instead of a second connection.

    // SPK-REG-006: the server-owned hold expiry. One terminal outcome: an already committed or
    // released hold, or one extended to a later instant, is left alone (idempotent under replay).
    this.registry.on<EventPayload<typeof HoldExpiryDue>>(
      HoldExpiryDue.type,
      'enrollment.expire_hold',
      (event, ctx) =>
        runWithTransaction(ctx.trx, async () => {
          const organizationId = event.organizationId;
          const hold = await this.capacity.expireHoldIfDue(
            ctx.trx,
            organizationId,
            event.payload.holdId,
            event.correlationId,
          );
          if (!hold) return;
          const system = enrollmentSystem(organizationId, 'enrollment.expire_hold');
          switch (hold.owner_kind) {
            case 'basket':
              await this.baskets.onHoldExpired(ctx.trx, organizationId, hold, event.correlationId);
              break;
            case 'waitlist_offer':
              await this.waitlist.onOfferHoldExpired(
                ctx.trx,
                organizationId,
                hold,
                system,
                event.correlationId,
              );
              break;
            case 'session_booking':
              await this.bookings.onHoldExpired(
                ctx.trx,
                organizationId,
                hold,
                system,
                event.correlationId,
              );
              break;
            default:
              break; // placement and staff holds simply lapse
          }
        }),
      { failureOwner: 'program_manager' },
    );
    // SPK-REG-008: freed capacity is offered to the waitlist by priority, each offer holding its place.
    this.registry.on<EventPayload<typeof CapacityReleased>>(
      CapacityReleased.type,
      'enrollment.offer_waitlist',
      (event, ctx) =>
        runWithTransaction(ctx.trx, async () => {
          await this.waitlist.offerFromPool(
            ctx.trx,
            event.organizationId,
            event.payload.poolId,
            event.correlationId,
          );
        }),
      { failureOwner: 'program_manager' },
    );
    // SPK-REG-008: once a participant holds a confirmed place (registered directly, transferred,
    // or booked the session), their live waitlist entries for it leave the queue and any open
    // offer is declined, so freed places go to the next real waiter.
    const retire = 'enrollment.retire_redundant_waitlist_entries';
    this.registry.on<EventPayload<typeof EnrollmentEvents.enrollmentConfirmed>>(
      EnrollmentEvents.enrollmentConfirmed.type,
      retire,
      (event, ctx) =>
        runWithTransaction(ctx.trx, () =>
          this.waitlist.retireRedundantEntries(
            ctx.trx,
            event.organizationId,
            { enrollmentId: event.payload.enrollmentId },
            event.correlationId,
          ),
        ),
      { failureOwner: 'program_manager' },
    );
    this.registry.on<EventPayload<typeof EnrollmentEvents.enrollmentTransferred>>(
      EnrollmentEvents.enrollmentTransferred.type,
      retire,
      (event, ctx) =>
        runWithTransaction(ctx.trx, () =>
          this.waitlist.retireRedundantEntries(
            ctx.trx,
            event.organizationId,
            { enrollmentId: event.payload.toEnrollmentId },
            event.correlationId,
          ),
        ),
      { failureOwner: 'program_manager' },
    );
    for (const booked of [EnrollmentEvents.sessionBooked, EnrollmentEvents.sessionBookingChanged]) {
      this.registry.on<{ bookingId: string; status: string }>(
        booked.type,
        retire,
        async (event, ctx) => {
          if (event.payload.status !== 'confirmed') return;
          await runWithTransaction(ctx.trx, () =>
            this.waitlist.retireRedundantEntries(
              ctx.trx,
              event.organizationId,
              { sessionBookingId: event.payload.bookingId },
              event.correlationId,
            ),
          );
        },
        { failureOwner: 'program_manager' },
      );
    }
    // SPK-YOUTH-004: an unused makeup lapses at its expiry.
    this.registry.on<EventPayload<typeof MakeupExpiryDue>>(
      MakeupExpiryDue.type,
      'enrollment.expire_makeup',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () =>
          this.makeups.expireIfDue(
            ctx.trx,
            event.organizationId,
            event.payload.makeupEntitlementId,
            event.correlationId,
          ),
        ),
      { failureOwner: 'program_manager' },
    );
    // SPK-REG-005 / SPK-YOUTH-002: commercial pools follow the catalog limits; staffing pools keep
    // their staff count so a raised commercial limit never bypasses the staffing requirement.
    this.registry.on<EventPayload<typeof CatalogEvents.offeringUpdated>>(
      CatalogEvents.offeringUpdated.type,
      'enrollment.sync_capacity',
      (event, ctx) =>
        runWithTransaction(ctx.trx, async () => {
          const change = event.payload.capacityChange;
          if (!change) return;
          await this.capacity.syncFromCatalog(
            ctx.trx,
            event.organizationId,
            event.payload.offeringId,
            change.after,
            event.correlationId,
          );
        }),
      { failureOwner: 'program_manager' },
    );
  }
}

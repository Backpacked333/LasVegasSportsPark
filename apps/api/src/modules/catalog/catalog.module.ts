import { Module, type OnModuleInit } from '@nestjs/common';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry } from '../../kernel';
import { FacilitiesModule } from '../facilities';
import { IdentityModule } from '../identity';
import { EventChanged, SchedulingModule } from '../scheduling';
import { OFFERING_LOOKUP_PORT, POLICY_PORT, PRICING_PORT } from './catalog.ports';
import { DiscountsController } from './controllers/discounts.controller';
import { EntitlementDefinitionsController } from './controllers/entitlement-definitions.controller';
import { OfferingsController } from './controllers/offerings.controller';
import { PoliciesController } from './controllers/policies.controller';
import { ProgramsController } from './controllers/programs.controller';
import { PricingService } from './pricing/pricing.service';
import { AcknowledgmentsService } from './services/acknowledgments.service';
import { DiscountsService } from './services/discounts.service';
import { EntitlementDefinitionsService } from './services/entitlement-definitions.service';
import { OfferingsService } from './services/offerings.service';
import { PoliciesService } from './services/policies.service';
import { PriceRulesService } from './services/price-rules.service';
import { ProgramsService } from './services/programs.service';
import { SessionsService } from './services/sessions.service';

/**
 * CatalogModule (specification §3.2 SPK-CAT-001..004, §3.15 SPK-PAY-001..003 price rules and
 * discount definitions, §4.4 Catalog + Policies, SPK-REG-002, SPK-REG-009, SPK-YOUTH-001/002).
 * Owns programs, offerings, sessions, entitlement definitions, policy versions, approvals,
 * acknowledgments, price rules, discount definitions and redemption counters. Depends on identity
 * for person lookups and guardian authority. Consumes `scheduling.event_changed`: a canceled
 * scheduling event cancels the catalog sessions linked to it (SPK-AT-009). See README.md.
 */
@Module({
  // Scheduling and facilities are read through their exported services only: publication checks
  // that a rental or party definition names resources and equipment a booking can reserve
  // (SPK-COND-003).
  imports: [IdentityModule, SchedulingModule, FacilitiesModule],
  controllers: [
    ProgramsController,
    EntitlementDefinitionsController,
    PoliciesController,
    OfferingsController,
    DiscountsController,
  ],
  providers: [
    ProgramsService,
    EntitlementDefinitionsService,
    PoliciesService,
    AcknowledgmentsService,
    PriceRulesService,
    DiscountsService,
    OfferingsService,
    SessionsService,
    PricingService,
    { provide: OFFERING_LOOKUP_PORT, useExisting: OfferingsService },
    { provide: POLICY_PORT, useExisting: PoliciesService },
    { provide: PRICING_PORT, useExisting: PricingService },
  ],
  exports: [
    ProgramsService,
    EntitlementDefinitionsService,
    PoliciesService,
    AcknowledgmentsService,
    PriceRulesService,
    DiscountsService,
    OfferingsService,
    SessionsService,
    PricingService,
    OFFERING_LOOKUP_PORT,
    POLICY_PORT,
    PRICING_PORT,
  ],
})
export class CatalogModule implements OnModuleInit {
  constructor(
    private readonly registry: EventHandlerRegistry,
    private readonly sessions: SessionsService,
  ) {}

  onModuleInit(): void {
    // SPK-AT-009, SPK-SCHED-009: the catalog session follows the scheduling event that reserves
    // its space (scheduling is the authority for the event, catalog for the session).
    this.registry.on<EventPayload<typeof EventChanged>>(
      EventChanged.type,
      'catalog.follow_scheduling_event',
      async (event, ctx) => {
        await this.sessions.followSchedulingEvent(ctx.trx, event);
      },
      { failureOwner: 'program_manager' },
    );
  }
}

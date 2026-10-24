import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
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
 * for person lookups and guardian authority; consumes no domain events. See README.md.
 */
@Module({
  imports: [IdentityModule],
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
export class CatalogModule {}

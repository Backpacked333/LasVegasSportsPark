export * from './catalog.module';
export * from './catalog.actions';
export * from './catalog.events';
export * from './catalog.ports';
export * from './catalog.state-machines';
export {
  BOOKING_OFFERING_KINDS,
  OFFERING_KIND_CAPABILITY,
  POLICY_APPROVAL_ACTION,
  REQUIRED_ENTITLEMENT_KIND,
  requiredStaffFor,
  staffingIncreaseNeedsReason,
} from './catalog.policy';
export {
  evaluateDiscounts,
  roundBasisPoints,
  allocateAcrossLines,
  type EvaluableDiscount,
  type DiscountEvaluationInput,
} from './pricing/discount-evaluator';
export {
  equivalenceKey,
  periodKeyForDates,
  type EquivalenceDefinition,
  type EquivalenceContext,
} from './entitlements/equivalence-key';
export { PricingService } from './pricing/pricing.service';
export { ProgramsService, type CreateProgramOptions } from './services/programs.service';
export {
  EntitlementDefinitionsService,
  parseEntitlementScope,
} from './services/entitlement-definitions.service';
export { PoliciesService, parsePolicyContent } from './services/policies.service';
export { AcknowledgmentsService } from './services/acknowledgments.service';
export { PriceRulesService } from './services/price-rules.service';
export { DiscountsService } from './services/discounts.service';
export {
  OfferingsService,
  addDays,
  daysBetween,
  typedEntitlementDefinition,
} from './services/offerings.service';
export { SessionsService } from './services/sessions.service';
export * from './testing/catalog-fixtures';

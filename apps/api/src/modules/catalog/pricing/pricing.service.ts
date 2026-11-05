import { Injectable } from '@nestjs/common';
import type { DiscountEvaluation, PriceRule } from '@sportspark/contracts';
import type { Trx } from '../../../kernel';
import type {
  EvaluateDiscountsRequest,
  PricingPort,
  RedeemDiscountInput,
  RedemptionOutcome,
} from '../catalog.ports';
import { DiscountsService } from '../services/discounts.service';
import { PriceRulesService } from '../services/price-rules.service';

/** PRICING_PORT: the price basis and discount mechanics finance quotes against (SPK-PAY-001..003). */
@Injectable()
export class PricingService implements PricingPort {
  constructor(
    private readonly priceRules: PriceRulesService,
    private readonly discounts: DiscountsService,
  ) {}

  effectivePriceRule(
    organizationId: string,
    offeringId: string,
    at: Date,
    trx?: Trx,
  ): Promise<PriceRule | null> {
    return this.priceRules.effectivePriceRule(organizationId, offeringId, at, trx);
  }

  evaluateDiscounts(
    organizationId: string,
    input: EvaluateDiscountsRequest,
    trx?: Trx,
  ): Promise<DiscountEvaluation> {
    return this.discounts.evaluateForOrganization(organizationId, input, trx);
  }

  redeemDiscount(
    trx: Trx,
    organizationId: string,
    input: RedeemDiscountInput,
  ): Promise<RedemptionOutcome> {
    return this.discounts.redeem(trx, organizationId, input);
  }

  releaseDiscount(
    trx: Trx,
    organizationId: string,
    input: RedeemDiscountInput,
  ): Promise<RedemptionOutcome> {
    return this.discounts.release(trx, organizationId, input);
  }
}

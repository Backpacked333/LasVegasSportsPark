import {
  allocate,
  errors,
  money,
  type AppliedCharge,
  type AppliedCredit,
  type ChargeLine,
  type DiscountEvaluation,
  type FutureObligation,
  type LinePolicyReferences,
  type QuoteDiscountLine,
} from '@sportspark/contracts';

/**
 * Pure quote arithmetic (SPK-PAY-001/002/003). Every amount is an integer of minor units; prices
 * come from the catalog price rule effective now, never from the client. Discounts arrive already
 * evaluated (catalog's explainable evaluation: eligibility, stacking, caps, rounding, allocation
 * across lines). Approved taxes and fees apply per line to the net amount after discounts:
 *   - an exclusive charge is added on top (percentage rounded half up, DEC-007 engineering default);
 *   - an inclusive charge is already part of the base price and is shown for transparency only.
 * Credits reduce what is payable in the order given; an installment plan splits the payable
 * amount with the largest-remainder rule so no minor unit is lost or invented.
 */

export interface QuoteLineInput {
  basketLineId: string;
  participantPersonId: string;
  offeringId: string;
  description: string;
  quantity: number;
  priceRule: {
    id: string;
    basePriceMinor: number;
    currency: string;
    chargeLines: ChargeLine[];
  } | null;
  policies: LinePolicyReferences;
  equivalenceKey: string | null;
  enrollmentId: string | null;
}

export interface CreditInput {
  creditId: string;
  remainingMinor: number;
}

export type PlanInput =
  { kind: 'full' } | { kind: 'installments'; count: number; intervalDays: number };

export interface ComputedQuoteLine extends QuoteLineInput {
  sequence: number;
  unitPriceMinor: number;
  baseAmountMinor: number;
  discountMinor: number;
  taxMinor: number;
  feeMinor: number;
  includedTaxMinor: number;
  totalMinor: number;
  discounts: QuoteDiscountLine[];
  charges: AppliedCharge[];
}

export interface ComputedQuote {
  currency: string;
  lines: ComputedQuoteLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  feeMinor: number;
  includedTaxMinor: number;
  totalMinor: number;
  creditsAppliedMinor: number;
  appliedCredits: AppliedCredit[];
  dueNowMinor: number;
  futureMinor: number;
  futureObligations: FutureObligation[];
  installmentAmounts: number[];
  discounts: QuoteDiscountLine[];
}

/** Half-up rounding of `numerator / denominator` for non-negative integers. */
export function roundHalfUp(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new Error('denominator must be positive');
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function applyCharges(
  netMinor: number,
  quantity: number,
  chargeLines: readonly ChargeLine[],
): { charges: AppliedCharge[]; taxMinor: number; feeMinor: number; includedMinor: number } {
  const charges: AppliedCharge[] = [];
  let taxMinor = 0;
  let feeMinor = 0;
  let includedMinor = 0;
  for (const line of chargeLines) {
    let amount: number;
    if (line.basisPoints !== undefined) {
      amount = line.inclusive
        ? roundHalfUp(netMinor * line.basisPoints, 10_000 + line.basisPoints)
        : roundHalfUp(netMinor * line.basisPoints, 10_000);
    } else {
      amount = (line.amountMinor ?? 0) * quantity;
    }
    charges.push({
      code: line.code,
      label: line.label,
      kind: line.kind,
      inclusive: line.inclusive ?? false,
      basisPoints: line.basisPoints ?? null,
      amountMinor: amount,
    });
    if (line.inclusive) includedMinor += amount;
    else if (line.kind === 'tax') taxMinor += amount;
    else feeMinor += amount;
  }
  return { charges, taxMinor, feeMinor, includedMinor };
}

export function computeQuote(input: {
  currency: string;
  lines: readonly QuoteLineInput[];
  discountEvaluation: DiscountEvaluation | null;
  credits: readonly CreditInput[];
  plan: PlanInput;
  now: Date;
}): ComputedQuote {
  if (input.lines.length === 0) throw errors.validation('There is nothing to quote.');
  const discountByLine = new Map<string, number>();
  const discountLinesByLine = new Map<string, QuoteDiscountLine[]>();
  const applied: QuoteDiscountLine[] = [];
  if (input.discountEvaluation) {
    if (input.discountEvaluation.currency !== input.currency) {
      throw errors.validation('Discount evaluation currency does not match the quote.');
    }
    for (const line of input.discountEvaluation.lines) {
      discountByLine.set(line.lineId, line.discountMinor);
    }
    for (const discount of input.discountEvaluation.discounts) {
      if (!discount.applied) continue;
      applied.push({
        discountDefinitionId: discount.discountDefinitionId,
        code: discount.code,
        name: discount.name,
        amountMinor: discount.amountMinor,
        explanation: discount.explanation,
      });
      for (const allocation of discount.allocations) {
        const list = discountLinesByLine.get(allocation.lineId) ?? [];
        list.push({
          discountDefinitionId: discount.discountDefinitionId,
          code: discount.code,
          name: discount.name,
          amountMinor: allocation.amountMinor,
          explanation: discount.explanation,
        });
        discountLinesByLine.set(allocation.lineId, list);
      }
    }
  }

  const lines: ComputedQuoteLine[] = input.lines.map((line, index) => {
    const unitPriceMinor = line.priceRule?.basePriceMinor ?? 0;
    if (line.priceRule && line.priceRule.currency !== input.currency) {
      throw errors.validation('Every line of a quote must be priced in the same currency.', {
        basketLineId: line.basketLineId,
      });
    }
    money(unitPriceMinor, input.currency);
    const baseAmountMinor = unitPriceMinor * line.quantity;
    const discountMinor = Math.min(discountByLine.get(line.basketLineId) ?? 0, baseAmountMinor);
    const net = baseAmountMinor - discountMinor;
    const charges = applyCharges(net, line.quantity, line.priceRule?.chargeLines ?? []);
    return {
      ...line,
      sequence: index + 1,
      unitPriceMinor,
      baseAmountMinor,
      discountMinor,
      taxMinor: charges.taxMinor,
      feeMinor: charges.feeMinor,
      includedTaxMinor: charges.includedMinor,
      totalMinor: net + charges.taxMinor + charges.feeMinor,
      discounts: discountLinesByLine.get(line.basketLineId) ?? [],
      charges: charges.charges,
    };
  });

  const sumOf = (pick: (l: ComputedQuoteLine) => number) =>
    lines.reduce((acc, line) => acc + pick(line), 0);
  const subtotalMinor = sumOf((l) => l.baseAmountMinor);
  const discountMinor = sumOf((l) => l.discountMinor);
  const taxMinor = sumOf((l) => l.taxMinor);
  const feeMinor = sumOf((l) => l.feeMinor);
  const includedTaxMinor = sumOf((l) => l.includedTaxMinor);
  const totalMinor = subtotalMinor - discountMinor + taxMinor + feeMinor;

  let remaining = totalMinor;
  const appliedCredits: AppliedCredit[] = [];
  for (const credit of input.credits) {
    if (remaining === 0) break;
    const amount = Math.min(credit.remainingMinor, remaining);
    if (amount <= 0) continue;
    appliedCredits.push({ creditId: credit.creditId, amountMinor: amount });
    remaining -= amount;
  }
  const creditsAppliedMinor = totalMinor - remaining;

  let installmentAmounts: number[] = [remaining];
  const futureObligations: FutureObligation[] = [];
  if (input.plan.kind === 'installments') {
    if (remaining < input.plan.count) {
      throw errors.validation('The payable amount is too small for the requested installments.', {
        payableMinor: remaining,
        count: input.plan.count,
      });
    }
    installmentAmounts = allocate(
      money(remaining, input.currency),
      Array.from({ length: input.plan.count }, () => 1),
    ).map((m) => m.amountMinor);
    installmentAmounts.forEach((amount, index) => {
      if (index === 0) return;
      futureObligations.push({
        sequence: index + 1,
        dueAt: new Date(
          input.now.getTime() +
            index * (input.plan as { intervalDays: number }).intervalDays * 86_400_000,
        ).toISOString(),
        amountMinor: amount,
      });
    });
  }
  const dueNowMinor = installmentAmounts[0] ?? 0;
  return {
    currency: input.currency,
    lines,
    subtotalMinor,
    discountMinor,
    taxMinor,
    feeMinor,
    includedTaxMinor,
    totalMinor,
    creditsAppliedMinor,
    appliedCredits,
    dueNowMinor,
    futureMinor: remaining - dueNowMinor,
    futureObligations,
    installmentAmounts,
    discounts: applied,
  };
}

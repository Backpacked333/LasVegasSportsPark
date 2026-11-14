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
  type MemberPriceReason,
  type QuoteDiscountLine,
  type QuoteLinePriceBasis,
} from '@sportspark/contracts';

/**
 * Pure quote arithmetic (SPK-PAY-001/002/003). Every amount is an integer of minor units; prices
 * come from the catalog price rule effective now, never from the client. Discounts arrive already
 * evaluated (catalog's explainable evaluation: eligibility, stacking, caps, rounding, allocation
 * across lines). Approved taxes and fees apply per line to the net amount after discounts:
 *   - an exclusive charge is added on top (percentage rounded half up, DEC-007 engineering default);
 *   - an inclusive charge is already part of the base price and is shown for transparency only;
 *     several inclusive rates are extracted together (R3-TIME-MONEY-09, inclusivePercentageParts).
 * Credits reduce what is payable in the order given; an installment plan splits the payable
 * amount with the largest-remainder rule so no minor unit is lost or invented.
 *
 * Proposed amendments PA-02 and PA-04 (SPK-PAY-013, SPK-PAY-015): a line may carry pricing facts
 * gathered before the calculation (the sessions still to attend, the participant's membership
 * standing). The unit price then follows a fixed order: the member price is chosen first, then a
 * per-session price is multiplied by the sessions counted. `quantity` stays the basket quantity
 * and base = unit x quantity holds as before; the result is explained by a stored price basis
 * from which the unit price can be worked out again (`unitPriceFromBasis`, SPK-PAY-002).
 */

/**
 * The facts a line's unit price depends on beyond the rule's base price, read at the quote
 * instant (never supplied by a client). Absent or null on a line means a plain term price.
 */
export interface LinePricingFacts {
  pricingBasis: 'term' | 'per_session';
  /** The rule's member price and the participant's standing; null when none was evaluated. */
  member: {
    priceMinor: number;
    entitlementDefinitionId: string;
    entitlementName: string;
    holds: boolean;
    reason: MemberPriceReason;
    membershipEnrollmentId: string | null;
    /** ISO instant the membership was checked at (the quote instant). */
    checkedAt: string;
  } | null;
  /** Required for `per_session`: the sessions counted and the instant they were counted at. */
  sessions: { sessionIds: string[]; countedAt: string } | null;
}

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
  /** SPK-PAY-013, SPK-PAY-015: see `LinePricingFacts`; omitted for a plain term price. */
  pricing?: LinePricingFacts | null;
  policies: LinePolicyReferences;
  equivalenceKey: string | null;
  enrollmentId: string | null;
}

/**
 * The price basis of a line (SPK-PAY-013, SPK-PAY-015), in the fixed order: member price, then
 * per-session multiplication. A member price applies only when the participant holds the
 * membership (`member.holds`); a per-session price is multiplied by the number of sessions
 * counted, and a line with no session left has no price (the caller refuses it with a reason
 * before it gets here).
 */
export function priceBasisOf(
  standardPriceMinor: number,
  facts: LinePricingFacts,
): QuoteLinePriceBasis {
  const memberApplies = facts.member?.holds === true;
  const appliedPriceMinor = memberApplies
    ? (facts.member as { priceMinor: number }).priceMinor
    : standardPriceMinor;
  let unitPriceMinor = appliedPriceMinor;
  let sessions: QuoteLinePriceBasis['sessions'] = null;
  if (facts.pricingBasis === 'per_session') {
    if (!facts.sessions) throw new Error('a per-session price needs the sessions counted');
    const count = facts.sessions.sessionIds.length;
    if (count < 1) {
      throw errors.validation('No session of this offering can still be attended.', {
        code: 'NO_SESSIONS_REMAINING',
      });
    }
    unitPriceMinor = appliedPriceMinor * count;
    sessions = {
      count,
      sessionIds: [...facts.sessions.sessionIds],
      countedAt: facts.sessions.countedAt,
    };
  }
  if (!Number.isSafeInteger(unitPriceMinor)) {
    throw errors.validation('The price of this line is too large to be represented.');
  }
  return {
    pricingBasis: facts.pricingBasis,
    standardPriceMinor,
    appliedPrice: memberApplies ? 'member' : 'standard',
    appliedPriceMinor,
    member: facts.member
      ? {
          priceMinor: facts.member.priceMinor,
          entitlementDefinitionId: facts.member.entitlementDefinitionId,
          entitlementName: facts.member.entitlementName,
          applied: memberApplies,
          reason: facts.member.reason,
          membershipEnrollmentId: facts.member.membershipEnrollmentId,
          checkedAt: facts.member.checkedAt,
        }
      : null,
    sessions,
    unitPriceMinor,
  };
}

/**
 * SPK-PAY-002: the unit price worked out again from a stored basis alone, without reading the
 * price rule, the sessions or the membership as they are now. Equal to the basis' own
 * `unitPriceMinor` for every basis `priceBasisOf` produced.
 */
export function unitPriceFromBasis(basis: QuoteLinePriceBasis): number {
  const applied =
    basis.appliedPrice === 'member' && basis.member
      ? basis.member.priceMinor
      : basis.standardPriceMinor;
  return basis.pricingBasis === 'per_session' ? applied * (basis.sessions?.count ?? 0) : applied;
}

export interface CreditInput {
  creditId: string;
  remainingMinor: number;
}

export type PlanInput =
  { kind: 'full' } | { kind: 'installments'; count: number; intervalDays: number };

export interface ComputedQuoteLine extends QuoteLineInput {
  sequence: number;
  /** SPK-PAY-013, SPK-PAY-015: how the unit price was worked out; null for a plain term price. */
  priceBasis: QuoteLinePriceBasis | null;
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

/**
 * R3-TIME-MONEY-09 (SPK-PAY-002, SPK-PAY-001): the parts of `netMinor` that inclusive percentage
 * charges account for, extracted together. A price that includes several rates is
 * base * (10000 + sum of rates) / 10000, so the included total is
 * net * sum / (10000 + sum) (rounded half up, as a single rate always was) and it is shared among
 * the rates in proportion to their basis points by the largest-remainder rule (ties to the earlier
 * line), so the parts add up to the included total exactly. Extracting each rate on its own
 * (net * rate / (10000 + rate)) divides by too little and overstates every part (a price of
 * 10800 that includes 5% and 3% contains 500 and 300, not 514 and 315). BigInt keeps the
 * products exact for any amount.
 */
function inclusivePercentageParts(netMinor: number, basisPoints: readonly number[]): number[] {
  const totalBasisPoints = basisPoints.reduce((sum, bp) => sum + bp, 0);
  if (netMinor <= 0 || totalBasisPoints === 0) return basisPoints.map(() => 0);
  const net = BigInt(netMinor);
  const total = BigInt(totalBasisPoints);
  const denominator = 10_000n + total;
  const included = (2n * net * total + denominator) / (2n * denominator);
  const parts = basisPoints.map((bp) => (included * BigInt(bp)) / total);
  let left = included - parts.reduce((sum, part) => sum + part, 0n);
  const order = basisPoints
    .map((bp, index) => ({ index, remainder: (included * BigInt(bp)) % total }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of order) {
    if (left <= 0n) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return parts.map((part) => Number(part));
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
  const inclusiveRates = chargeLines.flatMap((line, index) =>
    line.inclusive && line.basisPoints !== undefined ? [{ index, bp: line.basisPoints }] : [],
  );
  const inclusiveParts = new Map<number, number>();
  inclusivePercentageParts(
    netMinor,
    inclusiveRates.map((r) => r.bp),
  ).forEach((part, i) => inclusiveParts.set(inclusiveRates[i]?.index as number, part));
  for (const [index, line] of chargeLines.entries()) {
    let amount: number;
    if (line.basisPoints !== undefined) {
      amount = line.inclusive
        ? (inclusiveParts.get(index) ?? 0)
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
    // SPK-PAY-013, SPK-PAY-015: member price first, then per-session multiplication; a line
    // without pricing facts is priced at the rule's base price exactly as before.
    const priceBasis =
      line.priceRule && line.pricing
        ? priceBasisOf(line.priceRule.basePriceMinor, line.pricing)
        : null;
    const unitPriceMinor = priceBasis?.unitPriceMinor ?? line.priceRule?.basePriceMinor ?? 0;
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
      priceBasis,
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

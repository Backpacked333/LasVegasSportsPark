import {
  allocate,
  money,
  type AllocationMethod,
  type DiscountEvaluation,
  type DiscountEvaluationLine,
  type DiscountLine,
  type DiscountEligibilityRules,
  type RoundingMode,
} from '@sportspark/contracts';

/**
 * Pure discount evaluation (SPK-PAY-003: eligibility, stacking, caps, redemption limits, rounding,
 * allocation across lines, effective dates). No database, no clock: the caller supplies the
 * instant and the definitions with their current redemption counts. Deterministic for a given
 * input, so quotes can be re-explained later (SPK-PAY-002).
 */

export interface EvaluableDiscount {
  id: string;
  code: string | null;
  name: string;
  kind: 'promo_code' | 'automatic';
  amountKind: 'percentage' | 'fixed';
  amountValue: number;
  currency: string | null;
  eligibilityRules: DiscountEligibilityRules;
  stackingRule: 'exclusive' | 'stackable';
  stackingPriority: number;
  capMinor: number | null;
  redemptionLimit: number | null;
  perPersonLimit: number | null;
  rounding: RoundingMode;
  allocationMethod: AllocationMethod;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'draft' | 'active' | 'retired';
  redeemedCount: number;
  /** Redemptions already consumed per participant (for perPersonLimit). */
  redeemedByPerson?: Record<string, number>;
}

export interface DiscountEvaluationInput {
  currency: string;
  at: Date;
  lines: readonly DiscountEvaluationLine[];
  codes: readonly string[];
  definitions: readonly EvaluableDiscount[];
}

/** Integer rounding of (amount * basisPoints / 10000) under the configured mode; amounts are non-negative. */
export function roundBasisPoints(
  amountMinor: number,
  basisPoints: number,
  mode: RoundingMode,
): number {
  const numerator = BigInt(amountMinor) * BigInt(basisPoints);
  const denominator = 10_000n;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  let result = quotient;
  switch (mode) {
    case 'down':
      break;
    case 'up':
      if (remainder > 0n) result += 1n;
      break;
    case 'half_up':
      if (remainder * 2n >= denominator) result += 1n;
      break;
    case 'half_even':
      if (
        remainder * 2n > denominator ||
        (remainder * 2n === denominator && quotient % 2n === 1n)
      ) {
        result += 1n;
      }
      break;
  }
  return Number(result);
}

/**
 * Distributes `amount` across lines without exceeding any line's remaining amount. Returns the
 * allocation in input order. The sum equals `amount` whenever the lines can absorb it.
 */
export function allocateAcrossLines(
  amount: number,
  lines: readonly { lineId: string; remaining: number }[],
  method: AllocationMethod,
  currency: string,
): Array<{ lineId: string; amountMinor: number }> {
  const result = new Map<string, number>(lines.map((l) => [l.lineId, 0]));
  const headroom = new Map<string, number>(lines.map((l) => [l.lineId, l.remaining]));
  let left = amount;

  const fill = (order: readonly { lineId: string }[]) => {
    for (const { lineId } of order) {
      if (left <= 0) break;
      const room = headroom.get(lineId) ?? 0;
      const take = Math.min(room, left);
      if (take <= 0) continue;
      result.set(lineId, (result.get(lineId) ?? 0) + take);
      headroom.set(lineId, room - take);
      left -= take;
    }
  };

  if (method === 'largest_first') {
    fill([...lines].sort((a, b) => b.remaining - a.remaining || a.lineId.localeCompare(b.lineId)));
  } else if (method === 'first_line') {
    fill(lines);
  } else {
    // proportional (weights = remaining) or even (weights = 1), largest-remainder, then clamp and
    // hand any overflow to the lines that still have room (deterministic: largest remaining first).
    const weighted = lines.filter((l) => l.remaining > 0);
    if (weighted.length > 0 && amount > 0) {
      const weights = weighted.map((l) => (method === 'even' ? 1 : l.remaining));
      const shares = allocate(money(amount, currency), weights);
      weighted.forEach((line, i) => {
        const share = shares[i]?.amountMinor ?? 0;
        const room = headroom.get(line.lineId) ?? 0;
        const take = Math.min(share, room);
        result.set(line.lineId, take);
        headroom.set(line.lineId, room - take);
        left -= take;
      });
      if (left > 0) {
        fill(
          [...weighted].sort(
            (a, b) =>
              (headroom.get(b.lineId) ?? 0) - (headroom.get(a.lineId) ?? 0) ||
              a.lineId.localeCompare(b.lineId),
          ),
        );
      }
    }
  }
  return lines.map((l) => ({ lineId: l.lineId, amountMinor: result.get(l.lineId) ?? 0 }));
}

function isEffective(d: EvaluableDiscount, at: Date): boolean {
  const from = new Date(d.effectiveFrom).getTime();
  const to = d.effectiveTo === null ? Number.POSITIVE_INFINITY : new Date(d.effectiveTo).getTime();
  return from <= at.getTime() && at.getTime() < to;
}

function eligibleLines(
  d: EvaluableDiscount,
  lines: readonly DiscountEvaluationLine[],
  at: Date,
  explanation: string[],
): DiscountEvaluationLine[] {
  const rules = d.eligibilityRules;
  if (rules.registrationBefore && at.getTime() >= new Date(rules.registrationBefore).getTime()) {
    explanation.push(`not eligible: registration after ${rules.registrationBefore}`);
    return [];
  }
  let eligible = [...lines];
  if (rules.offeringKinds && rules.offeringKinds.length > 0) {
    const kinds = new Set<string>(rules.offeringKinds);
    eligible = eligible.filter((l) => kinds.has(l.offeringKind));
    explanation.push(`limited to offering kinds ${rules.offeringKinds.join(', ')}`);
  }
  if (rules.offeringIds && rules.offeringIds.length > 0) {
    const ids = new Set(rules.offeringIds);
    eligible = eligible.filter((l) => ids.has(l.offeringId));
    explanation.push(`limited to ${rules.offeringIds.length} named offering(s)`);
  }
  if (rules.programIds && rules.programIds.length > 0) {
    const ids = new Set(rules.programIds);
    eligible = eligible.filter((l) => l.programId !== null && ids.has(l.programId));
    explanation.push(`limited to ${rules.programIds.length} named program(s)`);
  }
  if (rules.minLineAmountMinor !== undefined) {
    eligible = eligible.filter((l) => l.baseAmountMinor >= rules.minLineAmountMinor!);
    explanation.push(`lines under ${rules.minLineAmountMinor} minor units excluded`);
  }
  if (d.perPersonLimit !== null) {
    const used = d.redeemedByPerson ?? {};
    eligible = eligible.filter(
      (l) =>
        l.participantPersonId === null || (used[l.participantPersonId] ?? 0) < d.perPersonLimit!,
    );
    explanation.push(`per-participant limit ${d.perPersonLimit}`);
  }
  if (rules.minLines !== undefined && eligible.length < rules.minLines) {
    explanation.push(
      `not eligible: needs at least ${rules.minLines} eligible lines, found ${eligible.length}`,
    );
    return [];
  }
  return eligible;
}

export function evaluateDiscounts(input: DiscountEvaluationInput): DiscountEvaluation {
  const at = input.at;
  const codes = new Set(input.codes.map((c) => c.toLowerCase()));
  const knownCodes = new Set(
    input.definitions.filter((d) => d.code !== null).map((d) => d.code!.toLowerCase()),
  );
  const unknownCodes = input.codes.filter((c) => !knownCodes.has(c.toLowerCase()));

  const candidates = input.definitions
    .filter(
      (d) =>
        d.status === 'active' &&
        isEffective(d, at) &&
        (d.kind === 'automatic' || (d.code !== null && codes.has(d.code.toLowerCase()))),
    )
    .sort(
      (a, b) =>
        a.stackingPriority - b.stackingPriority ||
        (a.stackingRule === b.stackingRule ? 0 : a.stackingRule === 'exclusive' ? -1 : 1) ||
        a.id.localeCompare(b.id),
    );

  const remaining = new Map(input.lines.map((l) => [l.lineId, l.baseAmountMinor]));
  const discounts: DiscountLine[] = [];
  const applied: DiscountLine[] = [];
  let appliedExclusive = false;

  for (const d of candidates) {
    const explanation: string[] = [];
    const notApplied = (reason: string): DiscountLine => {
      explanation.push(reason);
      return {
        discountDefinitionId: d.id,
        code: d.code,
        name: d.name,
        applied: false,
        amountMinor: 0,
        allocations: [],
        explanation,
      };
    };

    if (d.amountKind === 'fixed' && d.currency !== input.currency) {
      discounts.push(
        notApplied(`not applied: currency ${d.currency} differs from ${input.currency}`),
      );
      continue;
    }
    if (d.redemptionLimit !== null && d.redeemedCount >= d.redemptionLimit) {
      discounts.push(
        notApplied(
          `not applied: redemption limit ${d.redemptionLimit} reached (${d.redeemedCount} redeemed)`,
        ),
      );
      continue;
    }
    if (appliedExclusive) {
      discounts.push(
        notApplied(`not applied: cannot stack with exclusive discount ${applied[0]?.name ?? ''}`),
      );
      continue;
    }
    if (d.stackingRule === 'exclusive' && applied.length > 0) {
      discounts.push(
        notApplied(
          `not applied: exclusive discount cannot be combined with ${applied.map((a) => a.name).join(', ')}`,
        ),
      );
      continue;
    }
    const eligible = eligibleLines(d, input.lines, at, explanation);
    if (eligible.length === 0) {
      discounts.push(notApplied('not applied: no eligible lines'));
      continue;
    }
    const base = eligible.map((l) => ({
      lineId: l.lineId,
      remaining: remaining.get(l.lineId) ?? 0,
    }));
    const subtotal = base.reduce((sum, l) => sum + l.remaining, 0);
    if (subtotal <= 0) {
      discounts.push(notApplied('not applied: eligible lines already fully discounted'));
      continue;
    }
    let amount: number;
    if (d.amountKind === 'percentage') {
      amount = roundBasisPoints(subtotal, d.amountValue, d.rounding);
      explanation.push(
        `${d.amountValue / 100}% of ${subtotal} minor units = ${amount} (rounding ${d.rounding})`,
      );
    } else {
      amount = Math.min(d.amountValue, subtotal);
      explanation.push(
        `fixed ${d.amountValue} minor units${amount < d.amountValue ? ` limited to the eligible subtotal ${subtotal}` : ''}`,
      );
    }
    if (d.capMinor !== null && amount > d.capMinor) {
      explanation.push(`capped at ${d.capMinor} minor units`);
      amount = d.capMinor;
    }
    if (amount <= 0) {
      discounts.push(notApplied('not applied: amount rounds to zero'));
      continue;
    }
    const allocations = allocateAcrossLines(amount, base, d.allocationMethod, input.currency);
    for (const a of allocations) {
      remaining.set(a.lineId, (remaining.get(a.lineId) ?? 0) - a.amountMinor);
    }
    const allocated = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    explanation.push(
      `allocated ${d.allocationMethod} across ${allocations.filter((a) => a.amountMinor > 0).length} line(s)`,
    );
    explanation.push(
      d.stackingRule === 'exclusive' ? 'exclusive: no further discounts apply' : 'stackable',
    );
    const line: DiscountLine = {
      discountDefinitionId: d.id,
      code: d.code,
      name: d.name,
      applied: true,
      amountMinor: allocated,
      allocations: allocations.filter((a) => a.amountMinor > 0),
      explanation,
    };
    discounts.push(line);
    applied.push(line);
    if (d.stackingRule === 'exclusive') appliedExclusive = true;
  }

  const lines = input.lines.map((l) => {
    const net = remaining.get(l.lineId) ?? l.baseAmountMinor;
    return {
      lineId: l.lineId,
      baseAmountMinor: l.baseAmountMinor,
      discountMinor: l.baseAmountMinor - net,
      netAmountMinor: net,
    };
  });
  const totalBaseMinor = lines.reduce((s, l) => s + l.baseAmountMinor, 0);
  const totalNetMinor = lines.reduce((s, l) => s + l.netAmountMinor, 0);
  return {
    currency: input.currency,
    evaluatedAt: at.toISOString(),
    lines,
    discounts,
    totalBaseMinor,
    totalDiscountMinor: totalBaseMinor - totalNetMinor,
    totalNetMinor,
    unknownCodes,
  };
}

import { allocate, money, z } from '@sportspark/contracts';
import type { PosLineChargeRecord } from '@sportspark/db';

/**
 * Approved taxes and fees of a point-of-sale line (FIN-06, SPK-PAY-002, DEC-057, DEC-007). The
 * content of a catalog `tax_fee` policy version (CAT-02) is a rate in basis points or a fixed
 * amount with its currency, exactly one of them, and the rounding the version approves. Nothing
 * here supplies a rate, an amount or a rounding rule: a version that is missing, not approved or
 * malformed refuses the sale (CHARGE_POLICY_NOT_APPROVED / CHARGE_POLICY_INVALID).
 *
 * Proposed reading of the content (pending DEC-057): a charge is added on top of the line's base
 * amount (POS prices are shown without the charge); a rate applies to the line's base amount and
 * is rounded once per line as the version says; a fixed amount applies per unit sold.
 */
export const TaxFeeContent = z
  .strictObject({
    code: z.string().trim().min(1).max(50),
    label: z.string().trim().min(1).max(200),
    kind: z.enum(['tax', 'fee']),
    rateBasisPoints: z.number().int().min(0).max(100_000).optional(),
    amountMinor: z.number().int().min(0).safe().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    rounding: z.enum(['half_up', 'half_even', 'down']),
  })
  .refine(
    (v) =>
      v.rateBasisPoints !== undefined
        ? v.amountMinor === undefined && v.currency === undefined
        : v.amountMinor !== undefined && v.currency !== undefined,
    { message: 'provide exactly one of rateBasisPoints or amountMinor with its currency' },
  );
export type TaxFeeContentValue = z.infer<typeof TaxFeeContent>;

export type Rounding = TaxFeeContentValue['rounding'];

/** `base * basisPoints / 10000` rounded as the approved version says, in exact integer arithmetic. */
export function applyRate(baseMinor: number, basisPoints: number, rounding: Rounding): number {
  const numerator = BigInt(baseMinor) * BigInt(basisPoints);
  const denominator = 10_000n;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  let result = quotient;
  if (rounding === 'half_up') {
    if (remainder * 2n >= denominator) result += 1n;
  } else if (rounding === 'half_even') {
    if (remainder * 2n > denominator) result += 1n;
    else if (remainder * 2n === denominator && quotient % 2n === 1n) result += 1n;
  }
  const value = Number(result);
  if (!Number.isSafeInteger(value)) throw new RangeError('charge exceeds the safe integer range');
  return value;
}

/** One approved version's charge on a line of `quantity` units with `baseMinor` before charges. */
export function chargeFor(
  content: TaxFeeContentValue,
  policyVersionId: string,
  baseMinor: number,
  quantity: number,
): PosLineChargeRecord {
  const amountMinor =
    content.rateBasisPoints !== undefined
      ? applyRate(baseMinor, content.rateBasisPoints, content.rounding)
      : (content.amountMinor as number) * quantity;
  return {
    policyVersionId,
    code: content.code,
    label: content.label,
    kind: content.kind,
    amountMinor,
  };
}

/**
 * The amounts of `quantity` units of a sold line returned after `alreadyReturned` units: every
 * amount of the line (its base and each charge) is split over its units by largest remainder
 * (`allocate`), so returning every unit returns exactly what was paid and no minor unit is
 * invented or lost (SPK-PAY-003 allocation rule, reused).
 */
export function returnedShare(
  line: { quantity: number; baseMinor: number; charges: PosLineChargeRecord[]; currency: string },
  alreadyReturned: number,
  quantity: number,
): {
  baseMinor: number;
  charges: Array<{ code: string; kind: 'tax' | 'fee'; amountMinor: number }>;
} {
  const units = Array.from({ length: line.quantity }, () => 1);
  const slice = (total: number): number =>
    allocate(money(total, line.currency), units)
      .slice(alreadyReturned, alreadyReturned + quantity)
      .reduce((sum, part) => sum + part.amountMinor, 0);
  return {
    baseMinor: slice(line.baseMinor),
    charges: line.charges.map((c) => ({
      code: c.code,
      kind: c.kind,
      amountMinor: slice(c.amountMinor),
    })),
  };
}

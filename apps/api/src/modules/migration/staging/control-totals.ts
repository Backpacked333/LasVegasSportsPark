import type { ControlTotals, ImportEntityTypeValue } from '@sportspark/contracts';

/**
 * §5.5 level 1 "control totals": the totals the source declared for the snapshot against what
 * was actually staged. Every count and every (entity type, currency) amount is compared on its
 * own and reported on its own — a surplus in one category never offsets a shortfall in another,
 * and amounts in different currencies are never added together (§5.5 "do not net unrelated
 * discrepancies to make totals appear correct").
 */
export interface ControlTotalDiscrepancy {
  kind: 'count' | 'amount';
  entityType: ImportEntityTypeValue;
  currency: string | null;
  /** Declared by the source; null when the source declared nothing for this line. */
  expected: number | null;
  actual: number;
  /** actual - expected (actual when nothing was declared). */
  difference: number;
  code: 'count_mismatch' | 'amount_mismatch' | 'undeclared_total' | 'declared_not_staged';
}

export interface ControlTotalComparison {
  checked: number;
  discrepancies: ControlTotalDiscrepancy[];
}

const AMOUNT_FIELD: Partial<Record<ImportEntityTypeValue, string>> = {
  open_obligation: 'amountMinor',
  credit: 'amountMinor',
  refund: 'amountMinor',
  order: 'totalMinor',
};

function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export interface StagedForTotals {
  entityType: ImportEntityTypeValue;
  payload: Record<string, unknown>;
}

/** Staged amount of a row for its control total, or null when the row carries none. */
export function stagedAmount(
  row: StagedForTotals,
): { currency: string; amountMinor: number } | null {
  const field = AMOUNT_FIELD[row.entityType];
  if (!field) return null;
  const amount = integer(row.payload[field]);
  const currency = row.payload['currency'];
  if (amount === null || typeof currency !== 'string') return null;
  return { currency: currency.trim().toUpperCase(), amountMinor: amount };
}

export function compareControlTotals(
  declared: ControlTotals,
  rows: readonly StagedForTotals[],
): ControlTotalComparison {
  const counts = new Map<ImportEntityTypeValue, number>();
  const amounts = new Map<
    string,
    { entityType: ImportEntityTypeValue; currency: string; total: number }
  >();
  for (const row of rows) {
    counts.set(row.entityType, (counts.get(row.entityType) ?? 0) + 1);
    const amount = stagedAmount(row);
    if (!amount) continue;
    const key = `${row.entityType}|${amount.currency}`;
    const entry = amounts.get(key) ?? {
      entityType: row.entityType,
      currency: amount.currency,
      total: 0,
    };
    entry.total += amount.amountMinor;
    amounts.set(key, entry);
  }
  const discrepancies: ControlTotalDiscrepancy[] = [];
  let checked = 0;
  const declaredCounts = declared.counts as Partial<Record<ImportEntityTypeValue, number>>;
  const countTypes = new Set<ImportEntityTypeValue>([
    ...(Object.keys(declaredCounts) as ImportEntityTypeValue[]),
    ...counts.keys(),
  ]);
  for (const entityType of [...countTypes].sort()) {
    checked += 1;
    const expected = declaredCounts[entityType];
    const actual = counts.get(entityType) ?? 0;
    if (expected === undefined) {
      discrepancies.push({
        kind: 'count',
        entityType,
        currency: null,
        expected: null,
        actual,
        difference: actual,
        code: 'undeclared_total',
      });
    } else if (expected !== actual) {
      discrepancies.push({
        kind: 'count',
        entityType,
        currency: null,
        expected,
        actual,
        difference: actual - expected,
        code: expected > 0 && actual === 0 ? 'declared_not_staged' : 'count_mismatch',
      });
    }
  }
  const declaredAmounts = new Map<string, ControlTotals['amounts'][number]>(
    declared.amounts.map((a) => [`${a.entityType}|${a.currency}`, a]),
  );
  const amountKeys = new Set<string>([...declaredAmounts.keys(), ...amounts.keys()]);
  for (const key of [...amountKeys].sort()) {
    checked += 1;
    const expected = declaredAmounts.get(key);
    const actual = amounts.get(key);
    const [entityType, currency] = key.split('|') as [ImportEntityTypeValue, string];
    const actualTotal = actual?.total ?? 0;
    if (!expected) {
      discrepancies.push({
        kind: 'amount',
        entityType,
        currency,
        expected: null,
        actual: actualTotal,
        difference: actualTotal,
        code: 'undeclared_total',
      });
    } else if (expected.totalMinor !== actualTotal) {
      discrepancies.push({
        kind: 'amount',
        entityType,
        currency,
        expected: expected.totalMinor,
        actual: actualTotal,
        difference: actualTotal - expected.totalMinor,
        code: actual ? 'amount_mismatch' : 'declared_not_staged',
      });
    }
  }
  return { checked, discrepancies };
}

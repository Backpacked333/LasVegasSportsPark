/**
 * Capacity-first program summaries for the programs list (SCR-S-14, SPK-CAT-001, SPK-REG-008):
 * derived only from what the API returns, the staff offering list (`GET /v1/offerings?view=staff`)
 * and the offering capacity pools (`GET /v1/capacity-pools?scopeType=offering`: capacity,
 * committed, held). Nothing is estimated: a program whose offerings have no pool shows no meter.
 */
import type { Schema } from '@sportspark/api-client';

export type ListedOffering = Schema<'OfferingListItem'>;
export type Pool = Schema<'CapacityPool'>;
export type Sport = 'soccer' | 'basketball' | 'futsal' | 'camp' | 'other';

export interface CapacityTotal {
  unit: Pool['unit'];
  capacity: number;
  committed: number;
  held: number;
}

export interface ProgramSummary {
  offerings: ListedOffering[];
  /** The unit with the most places across the program's offering pools, summed. */
  capacity: CapacityTotal | null;
  /** Further units the program's pools count in (not added into `capacity`). */
  otherUnits: number;
  minPrice: { minor: number; currency: string } | null;
  openCount: number;
}

/** Colour family of a program card: camps first, then the sport the activity type names. */
export function sportOf(
  program: { activityType: string; format?: string | null },
  offerings: readonly { kind: string }[],
): Sport {
  const text = `${program.activityType} ${program.format ?? ''}`.toLowerCase();
  if (offerings.some((o) => o.kind === 'camp') || text.includes('camp')) return 'camp';
  if (text.includes('basket') || text.includes('hoop')) return 'basketball';
  if (text.includes('futsal')) return 'futsal';
  if (text.includes('soccer') || text.includes('football')) return 'soccer';
  return 'other';
}

export const SPORT_ICON = {
  soccer: 'sports_soccer',
  futsal: 'sports_soccer',
  basketball: 'sports_basketball',
  camp: 'wb_sunny',
  other: 'school',
} as const;

/** Offering-scoped pools of one offering. */
export function poolsOf(offeringId: string, pools: readonly Pool[]): Pool[] {
  return pools.filter((p) => p.offeringId === offeringId && p.scopeType === 'offering');
}

/** Sum pools per unit; the unit with the largest capacity leads. */
export function capacityOf(pools: readonly Pool[]): {
  capacity: CapacityTotal | null;
  otherUnits: number;
} {
  const byUnit = new Map<Pool['unit'], CapacityTotal>();
  for (const pool of pools) {
    const total = byUnit.get(pool.unit) ?? {
      unit: pool.unit,
      capacity: 0,
      committed: 0,
      held: 0,
    };
    total.capacity += pool.capacity;
    total.committed += pool.committed;
    total.held += pool.held;
    byUnit.set(pool.unit, total);
  }
  const totals = [...byUnit.values()].sort((a, b) => b.capacity - a.capacity);
  return { capacity: totals[0] ?? null, otherUnits: Math.max(0, totals.length - 1) };
}

export function summarize(
  programId: string,
  offerings: readonly ListedOffering[],
  pools: readonly Pool[],
): ProgramSummary {
  const mine = offerings
    .filter((o) => o.programId === programId)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const ids = new Set(mine.map((o) => o.id));
  const { capacity, otherUnits } = capacityOf(
    pools.filter(
      (p) => p.offeringId !== null && ids.has(p.offeringId) && p.scopeType === 'offering',
    ),
  );
  let minPrice: ProgramSummary['minPrice'] = null;
  for (const o of mine) {
    if (!o.price) continue;
    if (minPrice && minPrice.currency !== o.price.currency) continue;
    if (!minPrice || o.price.basePriceMinor < minPrice.minor) {
      minPrice = { minor: o.price.basePriceMinor, currency: o.price.currency };
    }
  }
  return {
    offerings: mine,
    capacity,
    otherUnits,
    minPrice,
    openCount: mine.filter((o) => o.publicationState === 'registration_open').length,
  };
}

/** Staff planned against what the pools' participants-per-staff ratio needs at full capacity. */
export function staffing(pools: readonly Pool[]): {
  planned: number;
  needed: number;
  ratios: number[];
} | null {
  const rated = pools.filter((p) => p.participantsPerStaff !== null && p.participantsPerStaff > 0);
  if (rated.length === 0) return null;
  let planned = 0;
  let needed = 0;
  for (const p of rated) {
    planned += p.staffCount ?? 0;
    needed += Math.ceil(p.capacity / (p.participantsPerStaff as number));
  }
  const ratios = [...new Set(rated.map((p) => p.participantsPerStaff as number))].sort(
    (a, b) => a - b,
  );
  return { planned, needed, ratios };
}

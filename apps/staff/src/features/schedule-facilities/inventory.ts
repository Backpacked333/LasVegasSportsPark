/**
 * Physical relationships between resources as the API derives them (SPK-SCHED-001, SPK-SCHED-002):
 * a whole pitch occupies the conflict units of all its subdivisions and a subdivision only its own,
 * so two resources overlap physically exactly when they share a conflict unit. The client only
 * reads this for display; the database exclusion constraint is the guarantee (§4.7 invariant 4).
 */
import type { Schema } from '@sportspark/api-client';

type Resource = Schema<'Resource'>;

export function sharesSpace(a: Resource, b: Resource): boolean {
  if (a.id === b.id) return false;
  return a.conflictUnitIds.some((u) => b.conflictUnitIds.includes(u));
}

/** Spaces ordered as a tree: each top-level space followed by its subdivisions. */
export function orderedInventory<
  T extends { id: string; name: string; parentResourceId: string | null },
>(resources: readonly T[]): { resource: T; depth: number }[] {
  const byName = (x: T, y: T) => x.name.localeCompare(y.name);
  const ids = new Set(resources.map((r) => r.id));
  const roots = resources
    .filter((r) => r.parentResourceId === null || !ids.has(r.parentResourceId))
    .sort(byName);
  const out: { resource: T; depth: number }[] = [];
  const visit = (r: T, depth: number) => {
    out.push({ resource: r, depth });
    for (const child of resources.filter((c) => c.parentResourceId === r.id).sort(byName)) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return out;
}

export function resourceNames(resources: readonly Resource[]): Map<string, string> {
  return new Map(resources.map((r) => [r.id, r.name]));
}

export function namesOf(ids: readonly string[], names: ReadonlyMap<string, string>): string {
  if (ids.length === 0) return 'no space';
  return ids.map((id) => names.get(id) ?? 'a space not in the inventory').join(', ');
}

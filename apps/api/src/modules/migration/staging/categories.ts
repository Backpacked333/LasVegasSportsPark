import type { ImportEntityTypeValue, ReconciliationAreaValue } from '@sportspark/contracts';
import type { MappedEntityType } from '@sportspark/db';

/**
 * How each §5.3 inventory line is handled by this module.
 *   - `applied`: created or updated through the owning module's public service and mapped.
 *   - `history`: retained as staged history with its provenance; never executed (orders, refunds,
 *     attendance and results are past facts; credentials are never imported).
 *   - `not_supported`: an operational record whose owning module exposes no import command; the
 *     row is skipped with that reason and every active one is reported by reconciliation level 4
 *     so nothing disappears silently (§5.5). Since MIG-02 every operational category has an
 *     import command, so no category uses it; it stays for a category added to §5.3 later.
 */
export type CategoryClass = 'applied' | 'history' | 'not_supported';

export interface CategoryRule {
  class: CategoryClass;
  area: ReconciliationAreaValue;
  /** Reason recorded on skipped rows of this category. */
  skip?: { code: string; message: string };
}

export const CATEGORY_RULES: Readonly<Record<ImportEntityTypeValue, CategoryRule>> = {
  person: { class: 'applied', area: 'identity' },
  household: { class: 'applied', area: 'identity' },
  relationship_evidence: { class: 'applied', area: 'identity' },
  program: { class: 'applied', area: 'participation' },
  open_obligation: { class: 'applied', area: 'finance' },
  credit: { class: 'applied', area: 'finance' },
  account: {
    class: 'history',
    area: 'identity',
    skip: {
      code: 'credentials_never_imported',
      message:
        'Legacy logins are never imported; the person claims access through the identity provider (DEC-018).',
    },
  },
  attendance_history: {
    class: 'history',
    area: 'participation',
    skip: {
      code: 'retained_as_history',
      message: 'Attendance history is retained with its provenance in the staged batch.',
    },
  },
  result: {
    class: 'history',
    area: 'participation',
    skip: {
      code: 'retained_as_history',
      message:
        'Historical results are retained as staged history; an official result needs publication authority (§4.7 invariant 8).',
    },
  },
  order: {
    class: 'history',
    area: 'finance',
    skip: {
      code: 'retained_as_history',
      message:
        'Historical orders are retained as staged history; imports never execute charges (§5.4).',
    },
  },
  refund: {
    class: 'history',
    area: 'finance',
    skip: {
      code: 'retained_as_history',
      message:
        'Settled refunds are retained as staged history; imports never execute refunds (§5.4).',
    },
  },
  document: {
    class: 'history',
    area: 'identity',
    skip: {
      code: 'retained_as_history',
      message:
        'Documents are retained by reference only; restricted object storage is not provisioned (§4.1).',
    },
  },
  // MIG-02 (IF-40): created through the owning modules' import commands, as the records their
  // owners approve as active participation (§5.5) and the schedule (future events are drafts that
  // hold no space until a schedule draft publishes them under SportsPark's authority, §5.6).
  season: { class: 'applied', area: 'participation' },
  team: { class: 'applied', area: 'participation' },
  roster: { class: 'applied', area: 'participation' },
  future_schedule: { class: 'applied', area: 'schedule' },
  communication_preference: { class: 'applied', area: 'identity' },
};

/** Rows are evaluated so that every reference is resolved before it is needed. */
export const DEPENDENCY_ORDER: readonly ImportEntityTypeValue[] = [
  'person',
  'program',
  'household',
  'relationship_evidence',
  'open_obligation',
  'credit',
  'season',
  // teams before their entries (inDependencyOrder), entries before rosters
  'team',
  'roster',
  'future_schedule',
  'communication_preference',
  'account',
  'attendance_history',
  'result',
  'order',
  'refund',
  'document',
];

export function isMappedEntityType(type: ImportEntityTypeValue): type is MappedEntityType {
  return CATEGORY_RULES[type].class === 'applied';
}

/** Reconciliation areas whose approval a batch needs, from the categories it contains. */
export function areasFor(types: Iterable<ImportEntityTypeValue>): ReconciliationAreaValue[] {
  const order: ReconciliationAreaValue[] = ['identity', 'participation', 'schedule', 'finance'];
  const present = new Set<ReconciliationAreaValue>();
  for (const type of types) present.add(CATEGORY_RULES[type].area);
  return order.filter((area) => present.has(area));
}

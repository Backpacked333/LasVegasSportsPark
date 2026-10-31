import { NAVIGATION_AREA_IDS, type ActionId, type NavigationAreaId } from '@sportspark/contracts';

/**
 * The fourteen SPK-UX-005 staff areas and which actions live in each (K-05). **Proposed** UX
 * mapping: an area is visible to a principal when one of its actions is allowed outright by a held
 * staff role. Explicit entries come first; the rest follow the owning module's prefix. `null`
 * means the action is a supporting read or desk step used inside other areas' screens, so it never
 * makes an area visible on its own (for example the front desk's checkout and tender actions
 * belong to registrations and arrival, not to the finance operator's area).
 */
export const NAVIGATION_AREAS: readonly NavigationAreaId[] = NAVIGATION_AREA_IDS;

const EXPLICIT: Readonly<Record<string, NavigationAreaId | null>> = {
  // Staff memberships are administered with the staff roster.
  'identity.manage_staff_membership': 'staff',
  // Desk money steps of a registration or an arrival (SPK-PAY-*, SCR-S-14/24).
  'finance.create_quote': 'registrations',
  'finance.read_quote': 'registrations',
  'finance.checkout': 'registrations',
  'finance.read_checkout': 'registrations',
  'finance.recover_checkout': 'registrations',
  'finance.record_tender': 'registrations',
  'finance.redeem_credit': 'registrations',
  'finance.read_credit': 'registrations',
  'finance.read_obligation': 'registrations',
  'finance.pay_obligation': 'registrations',
  'finance.pay_contribution': 'registrations',
  'finance.request_contribution': 'teams',
  // Catalog reads and acknowledgments used by desk and registration screens.
  'catalog.evaluate_discounts': 'registrations',
  'catalog.record_acknowledgment': 'registrations',
  'catalog.withdraw_acknowledgment': 'registrations',
  'catalog.read_acknowledgments': 'registrations',
  // Outcomes and recovery.
  'operations.read': 'today',
  'operations.resume_after_recovery': 'admin',
  // The assistant answers inside Today; reviewing and applying recommendations is administration.
  'automation.ask': 'today',
  'automation.read_request': 'today',
  // Where a record is authoritative is shown inside the owning screens.
  'migration.read_authority': null,
  'reporting.read_metric_definitions': 'reports',
};

const TEAM_ACTION = /team_entr|team_invitation|invite_player|roster|join|manage_team|availability/;

const PREFIXES: ReadonlyArray<[string, NavigationAreaId]> = [
  ['identity.', 'people'],
  ['catalog.', 'programs'],
  ['scheduling.', 'schedule'],
  ['enrollment.', 'registrations'],
  ['finance.', 'finance'],
  ['workforce.', 'staff'],
  ['entry.', 'arrival'],
  ['facilities.', 'facilities'],
  ['communications.', 'communications'],
  ['support.', 'today'],
  ['exceptions.', 'today'],
  ['reporting.', 'reports'],
  ['migration.', 'admin'],
  ['automation.', 'admin'],
  ['core.', 'admin'],
];

/** The area an action lives in, or null when it never makes an area visible on its own. */
export function areaOfAction(actionId: ActionId | string): NavigationAreaId | null {
  if (actionId in EXPLICIT) return EXPLICIT[actionId] ?? null;
  if (actionId.startsWith('competition.')) {
    return TEAM_ACTION.test(actionId.slice('competition.'.length)) ? 'teams' : 'leagues';
  }
  for (const [prefix, area] of PREFIXES) {
    if (actionId.startsWith(prefix)) return area;
  }
  return null;
}

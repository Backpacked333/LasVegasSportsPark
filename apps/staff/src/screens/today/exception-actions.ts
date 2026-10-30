/**
 * The exception workflow verbs the API permits right now (SPK-UX-006 "next permitted action").
 * Each `nextActions` entry carries its `verb` (SUP-01): `acknowledge`, `resolve` and `close` are
 * the exception lifecycle, whichever action authorizes them (the kernel's `exceptions.manage`, or
 * `exceptions.manage_own_queue` for a viewer holding the role the queue is named after, K-10);
 * `open` and `view` address the underlying record in its owning module. The client offers exactly
 * what the API lists, never more, and never parses `href` to find the verb.
 */
import type { Schema } from '@sportspark/api-client';

export type ExceptionVerb = 'acknowledge' | 'resolve' | 'close';
type NextAction = Schema<'NextAction'>;

const LIFECYCLE_VERBS: ReadonlySet<string> = new Set<ExceptionVerb>([
  'acknowledge',
  'resolve',
  'close',
]);

function lifecycleVerbOf(action: NextAction): ExceptionVerb | null {
  return LIFECYCLE_VERBS.has(action.verb) ? (action.verb as ExceptionVerb) : null;
}

export function permittedVerbs(actions: readonly NextAction[]): Set<ExceptionVerb> {
  const out = new Set<ExceptionVerb>();
  for (const action of actions) {
    const verb = lifecycleVerbOf(action);
    if (verb) out.add(verb);
  }
  return out;
}

/** Next actions that address the underlying problem (`open` or `view`, owned by another module). */
export function domainActions(actions: readonly NextAction[]): NextAction[] {
  return actions.filter((a) => lifecycleVerbOf(a) === null);
}

/**
 * The staff screen that carries out a domain next action, from the owning module's API path the
 * API gives in `href` (the command or read). Null when no staff screen serves it; the action is
 * then named as text. Only record ids travel in these paths, never personal data.
 */
const STAFF_SCREENS: readonly [pattern: RegExp, screen: (id: string) => string][] = [
  [/^\/v1\/payments\/([^/]+)(?:\/reconcile)?$/, (id) => `/finance/payments/${id}`],
  [/^\/v1\/registration-checkouts\/([^/]+)(?:\/recover)?$/, (id) => `/finance/checkouts/${id}`],
  [/^\/v1\/assignments\/([^/]+)(?:\/replacements)?$/, (id) => `/staff/assignments/${id}`],
  [/^\/v1\/assignments()$/, () => '/staff'],
  [
    /^\/v1\/notifications\/([^/]+)(?:\/deliveries)?$/,
    (id) => `/communications/notifications/${id}`,
  ],
  [/^\/v1\/maintenance-tasks\/([^/]+)$/, (id) => `/facilities/maintenance/tasks/${id}`],
  [
    /^\/v1\/maintenance-restrictions\/([^/]+)(?:\/(?:release|approve))?$/,
    (id) => `/facilities/restrictions/${id}`,
  ],
  [/^\/v1\/fixtures\/([^/]+)(?:\/readiness)?$/, (id) => `/leagues/fixtures/${id}`],
];

export function staffScreenFor(action: NextAction): string | null {
  if (!action.href) return null;
  const path = action.href.split('?')[0] ?? '';
  for (const [pattern, screen] of STAFF_SCREENS) {
    const match = pattern.exec(path);
    if (match) return screen(encodeURIComponent(match[1] ?? ''));
  }
  return null;
}

/**
 * Financial exceptions that mean money moved but fulfilment did not complete (checkout
 * `recovery_required`, failed compensation): pinned first on Today with their owner (SCR-S-01).
 */
export const RECOVERY_CATEGORIES: ReadonlySet<string> = new Set([
  'finance.fulfillment_incomplete',
  'finance.compensation_failed',
]);

/** Staff labels use the machine state names (journeys.md section 3, rule 4). */
export const EXCEPTION_STATUS_TONE = {
  open: 'warning',
  acknowledged: 'info',
  resolved: 'success',
  closed: 'neutral',
  unresolved: 'warning',
} as const;

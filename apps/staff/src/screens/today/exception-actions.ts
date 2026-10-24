/**
 * The exception workflow verbs the API permits right now (SPK-UX-006 "next permitted action").
 * The API lists each permitted lifecycle step as a `nextActions` entry of the kernel action
 * `exceptions.manage` whose href ends in the verb; the client offers exactly those, never more.
 */
import type { Schema } from '@sportspark/api-client';

export type ExceptionVerb = 'acknowledge' | 'resolve' | 'close';
type NextAction = Schema<'NextAction'>;

const LIFECYCLE_HREF = /\/exceptions\/[^/]+\/(acknowledge|resolve|close)$/;
export const EXCEPTION_MANAGE_ACTION = 'exceptions.manage';

function verbOf(action: NextAction): ExceptionVerb | null {
  if (action.action !== EXCEPTION_MANAGE_ACTION || action.method !== 'POST' || !action.href) {
    return null;
  }
  const match = LIFECYCLE_HREF.exec(action.href);
  return match ? (match[1] as ExceptionVerb) : null;
}

export function permittedVerbs(actions: readonly NextAction[]): Set<ExceptionVerb> {
  const out = new Set<ExceptionVerb>();
  for (const action of actions) {
    const verb = verbOf(action);
    if (verb) out.add(verb);
  }
  return out;
}

/** Next actions that address the underlying problem (owned by another module). */
export function domainActions(actions: readonly NextAction[]): NextAction[] {
  return actions.filter((a) => verbOf(a) === null);
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

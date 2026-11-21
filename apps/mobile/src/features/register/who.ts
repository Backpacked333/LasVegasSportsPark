/**
 * Who can be registered, in the words of the Who step and the activity page (redesign handoff 1e
 * row 1, 3d "Maya qualifies · Leo is too young"; SPK-REG-002, SPK-IAM-003). Pure: the eligibility
 * is the API's answer (`GET /v1/offerings/{id}/registration-options`), worded by
 * `eligibility-words.ts`; nothing here decides it.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { ageFromMessage, customerEligibilityLines } from '../registration/eligibility-words';
import type { RegistrationIntent } from '../registration/format';
import {
  blockingEligibilityReasons,
  eligibilityOf,
  mayRegister,
  type EligibilityResult,
  type RegistrationOptions,
} from '../registration/options';

type Enrollment = Schema<'Enrollment'>;

/** Reasons settled on Review (forms and waivers), never shown as why someone cannot join. */
const LATER_CODES: ReadonlySet<string> = new Set([
  'acknowledgment_missing',
  'waiver_missing',
  'waiver_lapsed',
]);

export type WhoState =
  'can_join' | 'forms_first' | 'unknown' | 'blocked' | 'already_in' | 'not_allowed';

export interface WhoRow {
  personId: string;
  name: string;
  state: WhoState;
  /** May be ticked: can join, or can join once forms are signed. */
  tickable: boolean;
  /** "✓ Age 8 · can join", "✓ Already in": the pill of a row that has one. */
  badge: StatusBadgeProps | null;
  /** "Ages 7 to 9. Leo is 5." for a row that cannot be ticked. */
  reason: string | null;
  /** An activity the API suggests instead ("Try Little Kickers"). */
  alternativeOfferingId: string | null;
}

/** Enrollment states that hold a place (anything but canceled, transferred, completed). */
export function holdsPlace(enrollment: Pick<Enrollment, 'status'>): boolean {
  return enrollment.status === 'pending' || enrollment.status === 'confirmed';
}

/** The age the API's age reason states, if any ("Maya is 8"). */
function statedAge(result: EligibilityResult): number | null {
  for (const reason of result.reasons) {
    const parsed = ageFromMessage(reason.message);
    if (parsed) return parsed.age;
  }
  return null;
}

export function whoRow(input: {
  personId: string;
  name: string;
  /** The person's age when known (date of birth), for "Age 8 · can join". */
  age: number | null;
  options: RegistrationOptions | undefined;
  intent: RegistrationIntent | null;
  alreadyIn: boolean;
}): WhoRow {
  const { personId, name, options, intent } = input;
  const base = { personId, name, alternativeOfferingId: null };
  if (input.alreadyIn) {
    return {
      ...base,
      state: 'already_in',
      tickable: false,
      badge: { tone: 'success', label: 'Already in' },
      reason: null,
    };
  }
  if (!options || !intent) {
    return { ...base, state: 'unknown', tickable: false, badge: null, reason: null };
  }
  if (!mayRegister(options, personId)) {
    return {
      ...base,
      state: 'not_allowed',
      tickable: false,
      badge: null,
      reason: 'Not available to register from your account.',
    };
  }
  const result = eligibilityOf(options, personId, intent);
  if (!result) {
    return { ...base, state: 'unknown', tickable: false, badge: null, reason: null };
  }
  const lines = customerEligibilityLines(result, { name });
  const blocked = blockingEligibilityReasons(result).length > 0;
  const alternative =
    result.alternatives.find((a) => a.kind === 'other_offering' && a.offeringId)?.offeringId ??
    null;
  if (blocked) {
    // Only what stops the registration ("Ages 7 to 9. Leo is 5."): forms are signed later.
    const blocking = result.reasons.filter(
      (r) => r.severity === 'blocking' && !LATER_CODES.has(r.code),
    );
    const words = customerEligibilityLines({ ...result, reasons: blocking }, { name }).reasons;
    return {
      ...base,
      alternativeOfferingId: alternative,
      state: 'blocked',
      tickable: false,
      badge: null,
      reason: (words.length > 0 ? words : lines.reasons).join(' '),
    };
  }
  const unknown = result.reasons.some((r) => r.severity === 'unknown') && !result.overridden;
  if (unknown) {
    return {
      ...base,
      state: 'unknown',
      tickable: false,
      badge: { tone: 'warning', label: "Can't check yet" },
      reason: lines.reasons.join(' '),
    };
  }
  const age = input.age ?? statedAge(result);
  const forms = result.reasons.some((r) => r.code === 'acknowledgment_missing');
  return {
    ...base,
    state: forms ? 'forms_first' : 'can_join',
    tickable: true,
    badge: {
      tone: 'success',
      label: age !== null ? `Age ${age} · can join` : 'Can join',
    },
    reason: forms ? 'A form to sign before paying.' : null,
  };
}

/**
 * "Maya qualifies · Leo is too young": one short clause per child, from the rows (3d "Ages" row).
 */
export function qualifiesLine(
  rows: readonly WhoRow[],
  results: (personId: string) => EligibilityResult | null,
): string | null {
  const parts = rows.map((row) => {
    if (row.state === 'already_in') return `${row.name} is already in`;
    if (row.tickable) return `${row.name} qualifies`;
    if (row.state === 'blocked') {
      const codes = results(row.personId)?.reasons.map((r) => r.code) ?? [];
      if (codes.includes('below_minimum_age')) return `${row.name} is too young`;
      if (codes.includes('above_maximum_age')) return `${row.name} is too old`;
      return `${row.name} can't join`;
    }
    return null;
  });
  const shown = parts.filter((p): p is string => p !== null);
  return shown.length > 0 ? shown.join(' · ') : null;
}

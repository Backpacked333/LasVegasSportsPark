/**
 * Eligibility in customer words (SPK-REG-002; PA-11 SPK-UX-011 **Proposed**).
 *
 * The API's eligibility result carries, per reason, a stable `code`, a severity and a `message`
 * written for staff ("The participant is 31 on 2026-11-23; this offering requires at least 5 and at
 * most 12."), and permitted alternatives by `kind`. Customers read one plain sentence per reason,
 * chosen by its code ("Ages 5 to 12. Dev is 31."), and the alternatives they can act on. The
 * staff-only alternative ("Staff with program authority may override eligibility…") is not shown
 * to customers. The API's own words stay available in "Details for support" (§4.10).
 *
 * A code this list does not know reads as a plain sentence for its severity, never as the API's
 * text, so a new reason never puts staff wording on a customer screen.
 *
 * Nothing here decides eligibility: the status and whether someone may be chosen are the API's
 * answer (`options.ts`).
 */
import type { Schema } from '@sportspark/api-client';
import type { SupportLine } from '../../ui/SupportDetails';

type EligibilityResult = NonNullable<Schema<'EligibilityResult'>>;
type Reason = EligibilityResult['reasons'][number];
type Alternative = EligibilityResult['alternatives'][number];

/** Who the sentences are about: the person's name ("Ben"; "Dev" for "You (Dev)"). */
export interface EligibilitySubject {
  name: string;
}

/** "You (Dev)" → "Dev"; "Ben" → "Ben"; an empty name → "This person". */
export function subjectOf(displayName: string): EligibilitySubject {
  const inner = /\(([^)]+)\)/.exec(displayName)?.[1]?.trim();
  const name = inner || displayName.trim();
  return { name: name.length > 0 ? name : 'This person' };
}

/** "Dev is 31." */
function isAge(subject: EligibilitySubject, age: number): string {
  return `${subject.name} is ${age}.`;
}

/** The age band and the person's age from the API's age message; null if it does not read so. */
export function ageFromMessage(
  message: string,
): { age: number; min: number | null; max: number | null } | null {
  const age = /\bis (\d+)\b/.exec(message);
  if (!age) return null;
  const min = /at least (\d+)/.exec(message);
  const max = /at most (\d+)/.exec(message);
  return {
    age: Number(age[1]),
    min: min ? Number(min[1]) : null,
    max: max ? Number(max[1]) : null,
  };
}

/** "Ages 5 to 12", "Ages 18 and up", "Ages 12 and under". */
function bandPhrase(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return `Ages ${min} to ${max}.`;
  if (min !== null) return `Ages ${min} and up.`;
  if (max !== null) return `Ages ${max} and under.`;
  return null;
}

/** The quoted title in an API message (`"Medical form" must be…` → Medical form). */
function quotedTitle(message: string): string | null {
  const match = /["“]([^"”]+)["”]/.exec(message);
  return match?.[1]?.trim() || null;
}

/** For a reason whose code is not listed: a plain sentence for its severity. */
export const UNKNOWN_REASON_SENTENCES: Readonly<Record<Reason['severity'], string>> = {
  blocking: "This activity isn't open to this person. The front desk can tell you why.",
  unknown: "We can't confirm this yet. The front desk can check for you.",
  warning: 'There is something to sort out first. The front desk can help.',
  info: 'The front desk has a note about this registration.',
};

/** One reason in customer words. */
export function customerReason(reason: Reason, subject: EligibilitySubject): string {
  switch (reason.code) {
    case 'below_minimum_age':
    case 'above_maximum_age': {
      const parsed = ageFromMessage(reason.message);
      const band = parsed ? bandPhrase(parsed.min, parsed.max) : null;
      if (parsed && band) return `${band} ${isAge(subject, parsed.age)}`;
      return reason.code === 'below_minimum_age'
        ? 'Too young for this activity.'
        : 'Too old for this activity.';
    }
    case 'date_of_birth_unknown':
      return 'We need a date of birth to check the ages. The front desk can add it.';
    case 'youth_requires_child':
      return 'This registration type is for children.';
    case 'participant_kind_not_permitted': {
      const kinds = /accepts (.+) participants only/.exec(reason.message)?.[1] ?? '';
      const adult = /\badult\b/.test(kinds);
      const child = /\bchild\b/.test(kinds);
      if (adult && !child) return 'This activity is for adults only.';
      if (child && !adult) return 'This activity is for children only.';
      return "This activity isn't open to this person.";
    }
    case 'participant_inactive':
      return "This person's profile isn't active. The front desk can help.";
    case 'registration_closed':
      return /paused/i.test(reason.message)
        ? 'Registration for this activity is paused.'
        : "Registration for this activity isn't open.";
    case 'intent_offering_mismatch':
      return "This registration type doesn't fit this activity.";
    case 'eligibility_policy_missing':
    case 'eligibility_policy_not_approved':
      return "The facility hasn't confirmed who can join yet. The front desk can check for you.";
    case 'team_entry_missing':
      return 'Choose the team to join.';
    case 'team_entry_waiting':
      return 'The team is waiting for a place in the season. You can register once it has one.';
    case 'team_entry_not_open':
      return "This team isn't taking players right now.";
    case 'session_missing':
      return 'Choose a session first.';
    case 'session_not_bookable':
      return 'This session is no longer available.';
    case 'acknowledgment_missing': {
      const title = quotedTitle(reason.message);
      return title ? `Sign “${title}” before registering.` : 'Sign the required forms first.';
    }
    case 'waiver_missing':
    case 'waiver_lapsed': {
      const title = quotedTitle(reason.message) ?? 'the waiver';
      if (/override/i.test(reason.message)) {
        return `The front desk has approved this registration without “${title}”.`;
      }
      return reason.code === 'waiver_lapsed'
        ? `“${title}” has expired. Accept it again before registering.`
        : `Accept “${title}” before registering.`;
    }
    default:
      return UNKNOWN_REASON_SENTENCES[reason.severity] ?? UNKNOWN_REASON_SENTENCES.blocking;
  }
}

/** One alternative in customer words; null for one only staff can act on. */
export function customerAlternative(alternative: Alternative): string | null {
  switch (alternative.kind) {
    case 'other_offering':
      return 'Look for another activity that fits.';
    case 'join_waitlist':
      return 'You can join the waiting list.';
    case 'trial':
      return 'You can book a trial session first.';
    case 'request_placement':
      return 'You can ask to be placed on another team.';
    case 'complete_acknowledgment':
      return /waiver/i.test(alternative.message)
        ? 'Accept the waiver to continue.'
        : 'Sign the required forms to continue.';
    case 'contact_staff':
      // "Staff with program authority may override eligibility…" is the staff's own option.
      return /override/i.test(alternative.message) ? null : 'The front desk can help.';
    default:
      return null;
  }
}

/**
 * Every line a customer reads for one result: the reasons, then the alternatives (a passing
 * result keeps only "sign the forms"), each once.
 */
export function customerEligibilityLines(
  result: EligibilityResult,
  subject: EligibilitySubject,
): { reasons: string[]; alternatives: string[] } {
  const passes = result.eligible || result.overridden;
  const reasons = [...new Set(result.reasons.map((r) => customerReason(r, subject)))];
  const alternatives = [
    ...new Set(
      result.alternatives
        .filter((a) => !passes || a.kind === 'complete_acknowledgment')
        .map(customerAlternative)
        .filter((a): a is string => a !== null && !reasons.includes(a)),
    ),
  ];
  return { reasons, alternatives };
}

/** The API's own words for "Details for support": one line per reason and alternative. */
export function eligibilitySupportLines(result: EligibilityResult, who: string): SupportLine[] {
  return [
    ...result.reasons.map((r) => ({ label: `${who}, ${r.code}`, value: r.message })),
    ...result.alternatives.map((a, i) => ({
      label: `${who}, option ${i + 1} (${a.kind})`,
      value: a.message,
    })),
  ];
}

/**
 * The registrations triage's pure model (handoff S 1c, S 3f, S 2c; SPK-REG-002, SPK-REG-003,
 * SPK-REG-007, SPK-REG-008): eligibility reasons as plain sentences with glyph badges, ages,
 * the "same reason" grouping that allows a bulk decision, waiting times, the decline reasons with
 * their prefilled messages, and the waitlist offer's time left and "running out" state. Nothing
 * here decides eligibility: the API's evaluation is only worded for people.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

type Application = Schema<'Application'>;
type Reason = Schema<'RegistrationEligibilityReason'>;

export const DAY_MS = 86_400_000;

const SHORT_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});
const LONG_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const utc = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

/** "Mar 2" for a local date. */
export function shortDate(date: string): string {
  return SHORT_DATE.format(new Date(utc(date)));
}

/** "May 2, 2021" for a local date. */
export function longDate(date: string): string {
  return LONG_DATE.format(new Date(utc(date)));
}

/** The date a person born on `dob` turns `years` (Feb 29 birthdays use Mar 1). */
export function birthdayAt(dob: string, years: number): string {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y + years, m - 1, d));
  return at.toISOString().slice(0, 10);
}

/** "5 y 10 m" (an adult over 18: "34 y"); null without a date of birth. */
export function ageLabel(dob: string | null | undefined, today: string): string | null {
  if (!dob) return null;
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  if (months < 0) return null;
  const years = Math.floor(months / 12);
  return years >= 18 ? `${years} y` : `${years} y ${months % 12} m`;
}

/** "2 d", "5 h", "12 m" since a moment. */
export function waitingLabel(since: string | null, now: Date): string {
  if (!since) return '—';
  const ms = now.getTime() - Date.parse(since);
  if (ms < 60 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} m`;
  if (ms < DAY_MS) return `${Math.round(ms / (60 * 60_000))} h`;
  return `${Math.floor(ms / DAY_MS)} d`;
}

export interface ReasonChip {
  /** The reason code the chip stands for (the grouping key of a bulk decision). */
  code: string;
  tone: StatusTone;
  text: string;
  /** The detail rail's heading ("Below the age band") and its plain sentence. */
  title: string;
  sentence: string;
}

function bandNumbers(message: string): { min: number | null; max: number | null } {
  const min = /at least (\d+)/.exec(message);
  const max = /at most (\d+)/.exec(message);
  return { min: min ? Number(min[1]) : null, max: max ? Number(max[1]) : null };
}

/**
 * One reason in plain words for the staff queue. Age reasons are written from the date of birth
 * ("Turns 5 on Mar 2"); other codes keep the API's own sentence.
 */
export function reasonChip(
  reason: Reason,
  person: { givenName: string; dateOfBirth: string | null } | null,
  referenceDate: string | null,
  offeringName: string | null,
): ReasonChip {
  const name = person?.givenName ?? 'The participant';
  const what = offeringName ?? 'This activity';
  switch (reason.code) {
    case 'below_minimum_age': {
      const { min, max } = bandNumbers(reason.message);
      const dob = person?.dateOfBirth ?? null;
      if (min !== null && dob) {
        const turns = birthdayAt(dob, min);
        const short = referenceDate ? Math.round((utc(turns) - utc(referenceDate)) / DAY_MS) : null;
        const band = max !== null ? `ages ${min} to ${max}` : `ages ${min} and up`;
        return {
          code: reason.code,
          tone: 'warning',
          text: `Turns ${min} on ${shortDate(turns)}`,
          title: 'Below the age band',
          sentence:
            `${what} is for ${band}${referenceDate ? ` on ${shortDate(referenceDate)}` : ''}. ` +
            `${name} turns ${min} on ${shortDate(turns)}` +
            (short !== null && short > 0
              ? `, so is ${short} day${short === 1 ? '' : 's'} short.`
              : '.'),
        };
      }
      return {
        code: reason.code,
        tone: 'warning',
        text: 'Below the age band',
        title: 'Below the age band',
        sentence: reason.message,
      };
    }
    case 'above_maximum_age': {
      const { max } = bandNumbers(reason.message);
      const dob = person?.dateOfBirth ?? null;
      if (max !== null && dob) {
        const turned = birthdayAt(dob, max + 1);
        return {
          code: reason.code,
          tone: 'warning',
          text: `Turned ${max + 1} on ${shortDate(turned)}`,
          title: 'Above the age band',
          sentence: `${what} is for ages up to ${max}. ${name} turned ${max + 1} on ${shortDate(turned)}.`,
        };
      }
      return {
        code: reason.code,
        tone: 'warning',
        text: 'Above the age band',
        title: 'Above the age band',
        sentence: reason.message,
      };
    }
    case 'date_of_birth_unknown':
      return {
        code: reason.code,
        tone: 'pending',
        text: 'Date of birth needed',
        title: 'No date of birth on record',
        sentence: `${name}'s age can't be checked without a date of birth. Add it to the record, then decide.`,
      };
    case 'acknowledgment_missing':
      return {
        code: reason.code,
        tone: 'warning',
        text: 'Form not signed',
        title: 'A required form is not signed',
        sentence: reason.message,
      };
    case 'registration_closed':
      return {
        code: reason.code,
        tone: 'neutral',
        text: 'Registration closed',
        title: 'Registration is closed',
        sentence: reason.message,
      };
    case 'MEMBERSHIP_REQUIRED':
      return {
        code: reason.code,
        tone: 'info',
        text: 'Membership needed',
        title: 'Membership needed',
        sentence: reason.message,
      };
    default:
      if (/waiver|form|acknowledg/i.test(reason.code) || /waiver|form/i.test(reason.message)) {
        return {
          code: 'form_missing',
          tone: 'warning',
          text: 'Waiver not signed',
          title: 'A required form is not signed',
          sentence: `${name}'s family hasn't signed a form this activity needs. They can sign it in the app or at the desk.`,
        };
      }
      return {
        code: reason.code,
        tone:
          reason.severity === 'info'
            ? 'info'
            : reason.severity === 'unknown'
              ? 'pending'
              : 'warning',
        text: reason.message.length > 34 ? `${reason.message.slice(0, 32)}…` : reason.message,
        title: reason.message,
        sentence: reason.message,
      };
  }
}

/** What the queue says about an eligible application that still needs a person to decide. */
export const REVIEW_CHIP: ReasonChip = {
  code: 'review',
  tone: 'pending',
  text: 'Needs approval',
  title: 'Approval required',
  sentence:
    'This activity takes players after a person reviews each application. Eligibility is met.',
};

/** The chips of one application: its failing reasons, or "Needs approval" when it is eligible. */
export function chipsOf(
  application: Application,
  person: { givenName: string; dateOfBirth: string | null } | null,
  offeringName: string | null,
): ReasonChip[] {
  const result = application.override ? null : application.eligibility;
  const reasons = (result?.reasons ?? []).filter((r) => r.severity !== 'info' || !result?.eligible);
  if (reasons.length === 0) return [REVIEW_CHIP];
  return reasons.map((r) => reasonChip(r, person, result?.referenceDate ?? null, offeringName));
}

/** Whether approving needs an eligibility override first (a failed evaluation, no override). */
export function needsOverride(application: Application): boolean {
  return (
    application.status === 'submitted' &&
    application.eligibility !== null &&
    !application.eligibility.eligible &&
    application.override === null
  );
}

/**
 * The reason a set of selected rows shares (the bulk bar of S 1c), or null when they differ. A
 * bulk decision is one decision for one reason, each application still audited on its own.
 */
export function sharedReason(chips: readonly ReasonChip[][]): ReasonChip | null {
  if (chips.length === 0) return null;
  const first = chips[0]?.[0];
  if (!first) return null;
  return chips.every((c) => c[0]?.code === first.code) ? first : null;
}

/** Words for the shared reason in the bulk bar ("same reason: below the age band"). */
export function sharedWords(chip: ReasonChip): string {
  return chip.title.charAt(0).toLowerCase() + chip.title.slice(1);
}

// ------------------------------------------------------------------------------------------------
// Decline with a reason (S 3f)
// ------------------------------------------------------------------------------------------------

export type DeclineReason = 'level' | 'age' | 'full' | 'other';

export const DECLINE_REASONS: readonly { id: DeclineReason; label: string }[] = [
  { id: 'level', label: 'Not the right level yet' },
  { id: 'age', label: 'Outside the age range' },
  { id: 'full', label: 'Team is full' },
  { id: 'other', label: 'Another reason' },
];

/** The message prefilled for the family per reason; staff edit it before sending. */
export function declineMessage(
  reason: DeclineReason,
  name: string,
  alternative: string | null,
): string {
  const next = alternative ? ` We recommend ${alternative} this season` : '';
  switch (reason) {
    case 'level':
      return `${name} showed great effort.${next ? `${next} and another tryout next term.` : ' We hope to see them at the next tryout.'}`;
    case 'age':
      return `${name} is outside the age range for this activity.${next ? `${next}, which fits their age.` : ' We hope to see them next season.'}`;
    case 'full':
      return `This team is full, so we can't offer ${name} a place.${next ? `${next}, which still has places.` : ' We can add them to the waitlist.'}`;
    case 'other':
      return alternative ? `${next.trim()}.` : '';
  }
}

/** "Decline and offer U12 Dev" / "Decline": the button follows the choices. */
export function declineButton(offerAlternative: boolean, alternative: string | null): string {
  if (!offerAlternative || !alternative) return 'Decline';
  const short = alternative.replace(/\bDevelopment\b/, 'Dev');
  return `Decline and offer ${short}`;
}

// ------------------------------------------------------------------------------------------------
// Waitlist offers (S 2c)
// ------------------------------------------------------------------------------------------------

/** Two hours: an offer with less time left is "running out" and suggests a call. */
export const RUNNING_OUT_MS = 2 * 60 * 60_000;

/** "23 h 41 m", "1 h 12 m", "12 m"; "Ran out" once past. */
export function timeLeftLabel(expiresAt: string, now: Date): string {
  const ms = Date.parse(expiresAt) - now.getTime();
  if (ms <= 0) return 'Ran out';
  const minutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours >= 48) return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  return hours > 0 ? `${hours} h ${mins} m` : `${mins} m`;
}

/** The share of the offer window left (0 to 1), for the bar. */
export function shareLeft(offeredAt: string, expiresAt: string, now: Date): number {
  const total = Date.parse(expiresAt) - Date.parse(offeredAt);
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (Date.parse(expiresAt) - now.getTime()) / total));
}

export function runningOut(expiresAt: string, now: Date): boolean {
  const ms = Date.parse(expiresAt) - now.getTime();
  return ms > 0 && ms < RUNNING_OUT_MS;
}

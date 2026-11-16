import {
  WaiverContentSchema,
  type WaiverAcceptance,
  type WaiverContent,
  type WaiverStatus,
  type WaiverVersionRef,
} from '@sportspark/contracts';

/**
 * The renewal rule of a liability waiver (SPK-REG-011, proposed amendment PA-01, ADR-004). One
 * pure judgement decides `current`, `lapsed` or `missing` for one person and one waiver family at
 * one instant, from the version in force and the person's acceptances. Every caller (registration,
 * rosters, check-in, rental rosters) reads this answer through the catalog policy port; none of
 * them re-implements the rule. The rule itself is the content of the version in force
 * (`WaiverContentSchema`): nothing here assumes a value DEC-095 leaves open.
 */

/** The approved waiver version in force at the instant, with its parsed rule. */
export interface WaiverVersionInForce {
  ref: WaiverVersionRef;
  content: WaiverContent;
}

/** Parses the content of a waiver version; null when it does not state a complete rule. */
export function parseWaiverContent(content: unknown): WaiverContent | null {
  const parsed = WaiverContentSchema.safeParse(content);
  return parsed.success ? parsed.data : null;
}

/**
 * The instant the renewal rule counts from: a paper acceptance counts from the date written on the
 * paper (midnight UTC of that date), a digital one from its signing time.
 */
export function acceptedInstant(input: {
  method: 'digital' | 'paper';
  signedAt: string;
  paperDatedOn: string | null;
}): Date {
  return input.method === 'paper' && input.paperDatedOn
    ? new Date(`${input.paperDatedOn}T00:00:00.000Z`)
    : new Date(input.signedAt);
}

/** Calendar months later in UTC; a day that does not exist becomes the month's last day. */
export function addMonthsUtc(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(from.getUTCDate(), lastDay),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

export interface JudgeWaiverInput {
  policyKey: string;
  at: Date;
  /** Null when the family has no approved version in force (or its content states no rule). */
  inForce: WaiverVersionInForce | null;
  /** The person's acceptances of any version of the family (withdrawn ones are ignored). */
  acceptances: readonly WaiverAcceptance[];
}

export function judgeWaiver(input: JudgeWaiverInput): WaiverStatus {
  const { policyKey, at, inForce } = input;
  const counting = input.acceptances
    .filter((a) => a.status === 'active' && new Date(a.signedAt).getTime() <= at.getTime())
    .sort(
      (a, b) =>
        new Date(b.acceptedAt).getTime() - new Date(a.acceptedAt).getTime() ||
        new Date(b.signedAt).getTime() - new Date(a.signedAt).getTime() ||
        (a.acknowledgmentId < b.acknowledgmentId ? 1 : -1),
    );
  const base = {
    policyKey,
    currentVersion: inForce?.ref ?? null,
    validUntil: null,
    lapsedAt: null,
    evaluatedAt: at.toISOString(),
  };
  if (!inForce) {
    // Nothing states a rule, so nothing can be judged current: unknown evidence is never a pass.
    return {
      ...base,
      status: 'missing',
      reason: 'no_version_in_force',
      acceptance: counting[0] ?? null,
      rule: null,
    };
  }
  const rule = {
    reacceptOnNewVersion: inForce.content.renewal.reacceptOnNewVersion,
    renewEveryMonths: inForce.content.renewal.renewEveryMonths,
    enforcement: inForce.content.enforcement,
  };
  if (counting.length === 0) {
    return { ...base, status: 'missing', reason: 'never_accepted', acceptance: null, rule };
  }
  const candidates = rule.reacceptOnNewVersion
    ? counting.filter((a) => a.policyVersionId === inForce.ref.policyVersionId)
    : counting;
  const latest = candidates[0];
  if (!latest) {
    return {
      ...base,
      status: 'lapsed',
      reason: 'new_version',
      acceptance: counting[0] ?? null,
      lapsedAt: inForce.ref.effectiveFrom,
      rule,
    };
  }
  if (rule.renewEveryMonths !== null) {
    const until = addMonthsUtc(new Date(latest.acceptedAt), rule.renewEveryMonths);
    if (at.getTime() >= until.getTime()) {
      return {
        ...base,
        status: 'lapsed',
        reason: 'renewal_due',
        acceptance: latest,
        lapsedAt: until.toISOString(),
        rule,
      };
    }
    return {
      ...base,
      status: 'current',
      reason: null,
      acceptance: latest,
      validUntil: until.toISOString(),
      rule,
    };
  }
  return { ...base, status: 'current', reason: null, acceptance: latest, rule };
}

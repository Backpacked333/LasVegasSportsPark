/**
 * Typed readers for the Package G entitlement definitions catalog exposes (SCR-S-51 to SCR-S-54;
 * CAT-02; `GET /v1/entitlement-definitions/{id}`, `scope` is a record in the contract). The
 * shapes mirror packages/contracts/src/api/catalog.ts (MembershipBenefitScope,
 * PackageCreditsScope, RentalResourceScope, PartyPackageScope). A scope that does not match is
 * reported as unreadable: nothing is assumed, defaulted or filled in (SPK-COND-001 "never
 * unlimited unless it says so", SPK-COND-002 "expiry is a choice", POL-038 to POL-040).
 */

export interface AppliesTo {
  offeringIds: string[];
  programIds: string[];
}

export type Attendance =
  | { mode: 'none' }
  | {
      mode: 'included_sessions';
      appliesTo: AppliesTo;
      limit: {
        count: number;
        period: 'week' | 'month' | 'membership_term';
        weekStartsOn: number | null;
      };
    }
  | { mode: 'unlimited'; appliesTo: AppliesTo };

export interface MembershipBenefit {
  attendance: Attendance;
  term: { kind: 'offering_dates' } | { kind: 'from_confirmation'; lengthDays: number };
  renewalNoticeLeadDays: number | null;
}

export type PackageExpiry =
  | { kind: 'none' }
  | { kind: 'days_after_issue'; days: number }
  | { kind: 'fixed_date'; date: string };

export interface PackageCredits {
  credits: number;
  appliesTo: AppliesTo;
  expiry: PackageExpiry;
}

export interface StaffingRequirement {
  kind: 'supervisor' | 'organizer';
  role: string;
  count: number;
  qualifications: string[];
}

export interface ResourceRequirement {
  resourceIds: string[];
  count: number;
}

export interface RentalResource {
  resources: ResourceRequirement;
  staffing: StaffingRequirement[];
}

export interface PartyPackage extends RentalResource {
  durationMinutes: number;
  guestLimit: number;
  equipmentAssetIds: string[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;

function appliesTo(v: unknown): AppliesTo | null {
  if (!isObject(v)) return null;
  const offeringIds = v.offeringIds === undefined ? [] : strings(v.offeringIds);
  const programIds = v.programIds === undefined ? [] : strings(v.programIds);
  if (!offeringIds || !programIds || offeringIds.length + programIds.length === 0) return null;
  return { offeringIds, programIds };
}

function attendance(v: unknown): Attendance | null {
  if (!isObject(v)) return null;
  if (v.mode === 'none') return { mode: 'none' };
  const scope = appliesTo(v.appliesTo);
  if (!scope) return null;
  if (v.mode === 'unlimited') return { mode: 'unlimited', appliesTo: scope };
  if (v.mode !== 'included_sessions' || !isObject(v.limit)) return null;
  const { count, period, weekStartsOn } = v.limit;
  if (!isInt(count) || (period !== 'week' && period !== 'month' && period !== 'membership_term')) {
    return null;
  }
  if (period === 'week' && !isInt(weekStartsOn)) return null;
  return {
    mode: 'included_sessions',
    appliesTo: scope,
    limit: { count, period, weekStartsOn: isInt(weekStartsOn) ? weekStartsOn : null },
  };
}

export function membershipBenefit(scope: unknown): MembershipBenefit | null {
  if (!isObject(scope)) return null;
  const a = attendance(scope.attendance);
  if (!a || !isObject(scope.term) || !isObject(scope.renewal)) return null;
  let term: MembershipBenefit['term'];
  if (scope.term.kind === 'offering_dates') term = { kind: 'offering_dates' };
  else if (scope.term.kind === 'from_confirmation' && isInt(scope.term.lengthDays)) {
    term = { kind: 'from_confirmation', lengthDays: scope.term.lengthDays };
  } else return null;
  const lead = scope.renewal.noticeLeadDays;
  if (lead !== null && !isInt(lead)) return null;
  return { attendance: a, term, renewalNoticeLeadDays: lead };
}

export function packageCredits(scope: unknown): PackageCredits | null {
  if (!isObject(scope) || !isInt(scope.credits) || !isObject(scope.expiry)) return null;
  const scopeOf = appliesTo(scope.appliesTo);
  if (!scopeOf) return null;
  const e = scope.expiry;
  let expiry: PackageExpiry;
  if (e.kind === 'none') expiry = { kind: 'none' };
  else if (e.kind === 'days_after_issue' && isInt(e.days)) {
    expiry = { kind: 'days_after_issue', days: e.days };
  } else if (e.kind === 'fixed_date' && typeof e.date === 'string') {
    expiry = { kind: 'fixed_date', date: e.date };
  } else return null;
  return { credits: scope.credits, appliesTo: scopeOf, expiry };
}

function staffing(v: unknown): StaffingRequirement[] | null {
  if (!Array.isArray(v)) return null;
  const out: StaffingRequirement[] = [];
  for (const s of v) {
    if (!isObject(s)) return null;
    const qualifications = strings(s.qualifications);
    if (
      (s.kind !== 'supervisor' && s.kind !== 'organizer') ||
      typeof s.role !== 'string' ||
      !isInt(s.count) ||
      !qualifications
    ) {
      return null;
    }
    out.push({ kind: s.kind, role: s.role, count: s.count, qualifications });
  }
  return out;
}

function resources(v: unknown): ResourceRequirement | null {
  if (!isObject(v)) return null;
  const ids = strings(v.resourceIds);
  if (!ids || ids.length === 0 || !isInt(v.count)) return null;
  return { resourceIds: ids, count: v.count };
}

export function rentalResource(scope: unknown): RentalResource | null {
  if (!isObject(scope)) return null;
  const r = resources(scope.resources);
  const s = staffing(scope.staffing);
  return r && s ? { resources: r, staffing: s } : null;
}

export function partyPackage(scope: unknown): PartyPackage | null {
  if (!isObject(scope)) return null;
  const base = rentalResource(scope);
  const equipment = strings(scope.equipmentAssetIds);
  if (!base || !equipment || !isInt(scope.durationMinutes) || !isInt(scope.guestLimit)) return null;
  return {
    ...base,
    durationMinutes: scope.durationMinutes,
    guestLimit: scope.guestLimit,
    equipmentAssetIds: equipment,
  };
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "3 sessions per week (weeks start Monday)", from the definition's own limit. */
export function includedSessionsText(limit: {
  count: number;
  period: 'week' | 'month' | 'membership_term';
  weekStartsOn: number | null;
}): string {
  const sessions = `${limit.count} ${limit.count === 1 ? 'session' : 'sessions'}`;
  switch (limit.period) {
    case 'week': {
      // Catalog weeks are ISO weekdays (1 = Monday ... 7 = Sunday).
      const day = limit.weekStartsOn !== null ? WEEKDAYS[limit.weekStartsOn - 1] : undefined;
      return `${sessions} per week${day ? ` (weeks start ${day})` : ''}`;
    }
    case 'month':
      return `${sessions} per calendar month`;
    case 'membership_term':
      return `${sessions} per membership term`;
  }
}

/** "Supervisor: 1 host (qualifications: first_aid)". */
export function staffingText(s: StaffingRequirement): string {
  const who = `${s.count} ${s.role.replaceAll('_', ' ')}`;
  const quals =
    s.qualifications.length > 0
      ? ` (qualifications: ${s.qualifications.map((q) => q.replaceAll('_', ' ')).join(', ')})`
      : '';
  return `${s.kind === 'supervisor' ? 'Supervisor' : 'Organizer'}: ${who}${quals}`;
}

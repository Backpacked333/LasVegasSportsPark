/**
 * Shared vocabulary for the People and families screens (SCR-S-20 to SCR-S-23; SPK-IAM-001,
 * SPK-IAM-003): grant permissions are listed one by one and none implies another; relationship
 * kinds and review states use the API's machine names (journeys.md section 3, rule 4).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export type GrantPermission = Schema<'GrantPermission'>;
export type RelationshipKind = Schema<'RelationshipKind'>;
export type GrantStatus = Schema<'GrantStatus'>;
export type InvitationStatus = Schema<'InvitationView'>['status'];

/** A grant's state at the API's clock (ID-04); the glyph agrees with the text (SPK-UX-009). */
export const GRANT_STATUS_TONE: Readonly<Record<GrantStatus, StatusTone>> = {
  effective: 'success',
  scheduled: 'pending',
  suspended: 'warning',
  revoked: 'neutral',
  ended: 'neutral',
};

export const INVITATION_STATUS_TONE: Readonly<Record<InvitationStatus, StatusTone>> = {
  pending: 'pending',
  accepted: 'success',
  declined: 'neutral',
  revoked: 'neutral',
  expired: 'neutral',
};

export const INVITATION_STATUSES: readonly InvitationStatus[] = [
  'pending',
  'accepted',
  'declined',
  'revoked',
  'expired',
];

/** Each permission independently (SPK-IAM-003): machine name, then what it allows. */
export const GRANT_PERMISSIONS: readonly { value: GrantPermission; label: string }[] = [
  { value: 'view', label: 'view: see the person’s schedule and records' },
  { value: 'register', label: 'register: register the person' },
  { value: 'pay', label: 'pay: pay for the person' },
  { value: 'receive_messages', label: 'receive_messages: receive operational messages' },
  { value: 'complete_forms', label: 'complete_forms: complete applicable forms' },
  { value: 'collect', label: 'collect: collect the child at pickup' },
];

export const RELATIONSHIP_KINDS: readonly { value: RelationshipKind; label: string }[] = [
  { value: 'guardian', label: 'guardian' },
  { value: 'delegate', label: 'delegate (for example a pickup delegate)' },
  { value: 'caregiver', label: 'caregiver' },
  { value: 'self_managed', label: 'self_managed' },
];

export function personName(person: { givenName: string; familyName: string }): string {
  return `${person.givenName} ${person.familyName}`.trim();
}

/** What a staff screen shows instead of a child's minimized details (§4.14). */
export const KEPT_NOT_SHOWN = 'Kept on the record, not shown here';

/**
 * A person's name as staff screens show it (§4.14 child data minimized): a child by given name
 * only; an adult by full name.
 */
export function displayName(person: {
  givenName: string;
  familyName: string;
  kind: 'adult' | 'child';
}): string {
  return person.kind === 'child' ? person.givenName : personName(person);
}

/** Minor units in the currency's own exponent (SPK-PAY-001), e.g. 2500 USD is "$25.00". */
export function formatMoney(amountMinor: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amountMinor / 10 ** digits);
  } catch {
    return `${amountMinor} ${currency} (minor units)`;
  }
}

/**
 * Shared vocabulary for the People and families screens (SCR-S-20 to SCR-S-23; SPK-IAM-001,
 * SPK-IAM-003): grant permissions are listed one by one and none implies another; relationship
 * kinds and review states use the API's machine names (journeys.md section 3, rule 4).
 */
import type { Schema } from '@sportspark/api-client';

export type GrantPermission = Schema<'GrantPermission'>;
export type RelationshipKind = Schema<'RelationshipKind'>;

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

/**
 * SCR-C-31 grant wording (SPK-IAM-003, SPK-IAM-005 "Under review", SPK-IAM-006): the state of one
 * of the six permissions for one person, worked out only from what the API states, `GET /v1/me`
 * authorities (in effect now) and `GET /v1/me/access-grants` (each grant with its status, dates,
 * source and whether a disputed-access review restricts it). Nothing is inferred from household
 * membership (§4.5).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';
import { formatDateTime, type GrantPermission } from '../account/components/account-data';

export type GrantView = Schema<'GrantView'>;

/** Stable key of a grant in a page (GrantView has `grantId`, not `id`). */
export function grantKey(grant: GrantView): string {
  return grant.grantId;
}

export interface PermissionState {
  /** "Allowed", "Under review", "Starts Oct 30, 2026, 9:00 AM UTC", "Not allowed". */
  label: string;
  tone: StatusTone;
  glyph: string;
  /** Extra words after the permission's own description, or null. */
  note: string | null;
}

const SOURCES: Record<GrantView['source'], string> = {
  staff: 'recorded by the front desk',
  self_service: 'recorded in the app',
  invitation: 'from an invitation',
  claim: 'from a claim code',
  review: 'from an access review',
  import: 'from the previous system',
};

export function sourceText(source: GrantView['source']): string {
  return SOURCES[source];
}

/**
 * The state of `permission` for one person. `allowed` is the API's statement that it is in effect
 * now (`GET /v1/me` authorities); `grants` are this account's grants over that person, or
 * `undefined` while they are not loaded (then only allowed or not allowed is shown).
 */
export function permissionState(
  permission: GrantPermission,
  allowed: boolean,
  grants: readonly GrantView[] | undefined,
): PermissionState {
  const mine = (grants ?? []).filter((g) => g.permission === permission);
  if (allowed) {
    const effective = mine.find((g) => g.status === 'effective');
    const note = effective
      ? `Since ${formatDateTime(effective.effectiveFrom)}${
          effective.effectiveTo ? `, until ${formatDateTime(effective.effectiveTo)}` : ''
        }, ${sourceText(effective.source)}`
      : null;
    return { label: 'Allowed', tone: 'success', glyph: '✓', note };
  }
  if (mine.some((g) => g.underReview)) {
    return {
      label: 'Under review',
      tone: 'pending',
      glyph: '◷',
      note: 'Paused while the facility reviews a question about access',
    };
  }
  if (mine.some((g) => g.status === 'suspended')) {
    return { label: 'Suspended', tone: 'pending', glyph: '◷', note: null };
  }
  const scheduled = mine
    .filter((g) => g.status === 'scheduled')
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  if (scheduled) {
    return {
      label: `Starts ${formatDateTime(scheduled.effectiveFrom)}`,
      tone: 'info',
      glyph: 'ℹ',
      note: null,
    };
  }
  return { label: 'Not allowed', tone: 'neutral', glyph: '–', note: null };
}

/** journeys.md-style words for a grant's status, for lists of grants (who can act for you). */
export function grantStatusLabel(grant: GrantView): { tone: StatusTone; label: string } {
  if (grant.underReview) return { tone: 'pending', label: 'Under review' };
  switch (grant.status) {
    case 'effective':
      return { tone: 'success', label: 'Allowed' };
    case 'scheduled':
      return { tone: 'info', label: `Starts ${formatDateTime(grant.effectiveFrom)}` };
    case 'suspended':
      return { tone: 'pending', label: 'Suspended' };
    case 'revoked':
      return { tone: 'neutral', label: 'Withdrawn' };
    case 'ended':
      return { tone: 'neutral', label: 'Ended' };
  }
}

/** Grants that still matter on screen: in effect, starting later, or paused. */
export function isCurrentGrant(grant: GrantView): boolean {
  return (
    grant.status === 'effective' || grant.status === 'scheduled' || grant.status === 'suspended'
  );
}

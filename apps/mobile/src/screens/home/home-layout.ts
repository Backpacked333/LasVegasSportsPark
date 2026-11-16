/**
 * Pure decisions behind the SCR-C-03 Home layout (SPK-UX-003; PA-11 SPK-UX-011 **Proposed** plain
 * words; ADR-008): which person blocks Home shows and in which order, the one verb on each "Needs
 * you" row, and how many rows that card shows. No clock, no state, no reads: the screen passes what
 * the API answered.
 */
import type { Schema } from '@sportspark/api-client';

type InboxItem = Schema<'InboxItem'>;
type PendingReason = NonNullable<Schema<'Enrollment'>['pendingReason']>;

/** A person block on Home: "Family this week" (a parent) or "My team" (a player). */
export type HomeBlock = 'family' | 'team';

/** What `homeLayout` needs to know about each block; null when the person has none. */
export interface HomeLayoutInput {
  /** Family members other than the viewer, with the start of the soonest activity among them. */
  family: { soonest: string | null } | null;
  /** Teams the viewer plays on, with the start of the soonest game among them. */
  team: { soonest: string | null } | null;
}

function instant(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * The person blocks in the order Home shows them:
 * - a parent (family members, no team of their own) sees "Family this week";
 * - a player (on a team, no family members) sees "My team";
 * - someone who is both sees whichever has the sooner activity first. Nothing scheduled counts as
 *   later than anything scheduled, and a tie keeps the family first.
 */
export function homeLayout({ family, team }: HomeLayoutInput): HomeBlock[] {
  if (family && team) {
    return instant(team.soonest) < instant(family.soonest)
      ? ['team', 'family']
      : ['family', 'team'];
  }
  if (family) return ['family'];
  if (team) return ['team'];
  return [];
}

/** How many rows the "Needs you" card shows before "See all". */
export const NEEDS_YOU_ROWS = 3;

/** The one verb a "Needs you" row shows for a notice, by its kind. */
export function noticeVerb(item: Pick<InboxItem, 'kind'>): string {
  switch (item.kind) {
    case 'payment_attention':
      return 'Pay';
    case 'availability_request':
      return 'Answer';
    case 'team_invitation':
    case 'waitlist_offer':
      return 'Accept';
    default:
      return 'View';
  }
}

/** The one verb a "Needs you" row shows for a registration waiting on the customer. */
export function registrationVerb(reason: PendingReason | null | undefined): string {
  switch (reason) {
    case 'payment':
      return 'Pay';
    case 'forms':
      return 'Sign form';
    default:
      return 'View';
  }
}

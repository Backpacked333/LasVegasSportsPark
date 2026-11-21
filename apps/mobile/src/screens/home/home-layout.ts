/**
 * Pure decisions behind the SCR-C-03 Home rows (SPK-UX-003; PA-11 SPK-UX-011 **Proposed** plain
 * words; ADR-008): the one verb on each notice and registration row of Home's "To do" card. No
 * clock, no state, no reads: the screen passes what the API answered. (The redesign's "This week"
 * strip replaced the "Family this week" and "My team" blocks this file used to order.)
 */
import type { Schema } from '@sportspark/api-client';

type InboxItem = Schema<'InboxItem'>;
type PendingReason = NonNullable<Schema<'Enrollment'>['pendingReason']>;

/** The one verb a notice row shows, by its kind. */
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

/** The one verb a registration row shows while it waits on the customer. */
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

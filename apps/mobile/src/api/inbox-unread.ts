/**
 * The inbox badge (SCR-C-06, SPK-UX-003, SPK-COMMS-004/005): how many in-app notices the signed-in
 * person has not read, from `GET /v1/me/inbox/unread-count`. The API stops counting past `cap`:
 * `capped` then says there are more than `cap`, and the badge reads "<cap>+". Read only while signed in, refreshed on
 * return to the app; reading or acknowledging a notice reads it again (`UNREAD_COUNT_KEY`).
 */
import type { Schema } from '@sportspark/api-client';
import { useApp } from '../providers/AppProviders';
import { useApiQuery } from './useApiQuery';

export type InboxUnreadCount = Schema<'InboxUnreadCount'>;

/** Query key prefix of the unread count, for invalidation after a read or an acknowledgment. */
export const UNREAD_COUNT_KEY = ['api', '/me/inbox/unread-count'] as const;

/** The badge's text: "3", "99+"; null when there is nothing unread. */
export function unreadBadgeText(count: InboxUnreadCount): string | null {
  if (count.unread <= 0) return null;
  return count.capped ? `${count.cap}+` : String(count.unread);
}

/**
 * The inbox button's accessible name: "Notification inbox, 3 unread" (SPK-UX-009: the count is
 * in the words, not only in the red dot). Without a count (loading, failed, signed out) it is
 * the plain name, never a guess.
 */
export function inboxButtonLabel(count: InboxUnreadCount | undefined): string {
  if (!count || count.unread <= 0) return 'Notification inbox';
  const n = count.capped ? `more than ${count.cap}` : String(count.unread);
  return `Notification inbox, ${n} unread`;
}

export function useInboxUnreadCount() {
  const { session } = useApp();
  return useApiQuery({
    path: '/me/inbox/unread-count',
    enabled: session.status === 'signed_in',
    staleTime: 30_000,
  });
}

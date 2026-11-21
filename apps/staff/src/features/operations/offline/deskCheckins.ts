/**
 * Offline check-ins at the arrival desk (staff S 3d, §4.15, SPK-AT-018). With the connection down,
 * a desk check-in is queued as the observations §4.15 allows a staff device to queue: the
 * facility arrival (when the person is not on site yet) and the attendance observation "present"
 * for the session, both against the scan's roster snapshot. They go up in queue order with the
 * rest of the device's queue (`POST /v1/offline-sync`) once the connection is back; the session
 * check-in record itself (its eligibility evaluation) is made online only.
 *
 * `useQueuedCheckinCount` is the count the navigation shows on the Arrival area: the desk
 * check-ins of the signed-in account still waiting on this device.
 */
import { useOfflineQueue } from './OfflineQueueProvider';
import type { QueuedItem, ReviewItem } from './queue';

export function isDeskCheckin(q: QueuedItem): boolean {
  return q.purpose === 'desk_checkin' && q.item.kind === 'attendance';
}

/** The desk check-ins of this account waiting on this device, oldest first. */
export function useQueuedCheckins(): QueuedItem[] {
  return useOfflineQueue().mine.filter(isDeskCheckin);
}

/** Desk check-ins the API kept for review after synchronising (a refused or rejected one). */
export function useCheckinsForReview(): ReviewItem[] {
  return useOfflineQueue().state.review.filter((r) => isDeskCheckin(r.queued));
}

/** The navigation's Arrival badge: queued desk check-ins of the signed-in account. */
export function useQueuedCheckinCount(): number {
  return useQueuedCheckins().length;
}

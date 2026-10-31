/**
 * In-app notices as the today screens use them (SPK-UX-003 Home order, SPK-COMMS-005 old and new
 * practical details, SPK-COMMS-007 essential versus promotional).
 *
 * The inbox is the API's list of in-app delivery attempts for the signed-in person
 * (`GET /v1/me/inbox`); protected notices the person may no longer see are already left out by
 * the API (SPK-IAM-006). Nothing here decides who may see what.
 */
import type { Schema } from '@sportspark/api-client';

type InboxItem = Schema<'InboxItem'>;

/** Home sections fed by notices, in the SPK-UX-003 order (next activity comes from the calendar). */
export type NoticeSection = 'urgent' | 'actions' | 'invitations' | 'results' | 'renewals';

/** Practical details carried by schedule notices (scheduling `EventDetails`). */
export interface EventDetailsView {
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  /** The facility's IANA time zone (SPK-SCHED-008). */
  timezone: string;
  resources: { id: string; name: string }[];
  status: string;
}

const SCHEDULE_KINDS = new Set(['schedule_changed', 'cancellation', 'schedule_published']);

/**
 * Which Home section a notice belongs to, or null when it stays in the inbox only. Promotional
 * messages never appear on Home (marketing must not obscure today's activity, SPK-UX-003); a
 * notice replaced by a newer one gives way to it (SPK-COMMS-005); an acknowledged notice is done.
 */
export function noticeSection(item: InboxItem, now: Date): NoticeSection | null {
  if (item.category !== 'operational') return null;
  if (item.supersededByNotificationId) return null;
  if (item.acknowledgedAt) return null;
  switch (item.kind) {
    case 'schedule_changed':
    case 'cancellation': {
      // A change to something already over is no longer urgent.
      const change = scheduleChangeOf(item);
      const end = change?.after?.scheduledEnd ?? change?.before?.scheduledEnd ?? null;
      if (end && new Date(end).getTime() <= now.getTime()) return null;
      return 'urgent';
    }
    case 'payment_attention':
    case 'registration_outcome':
      return 'actions';
    case 'availability_request': {
      // COM-06: a captain asked the roster for answers before a fixture (SPK-CAP-001); once the
      // fixture has started the request is over.
      const start = availabilityRequestOf(item)?.scheduledStart ?? null;
      if (start && new Date(start).getTime() <= now.getTime()) return null;
      return 'actions';
    }
    case 'team_invitation':
    case 'waitlist_offer':
    case 'placement':
      return 'invitations';
    case 'result_published':
    case 'youth_feedback':
      return 'results';
    case 'renewal_opportunity':
      return 'renewals';
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates `detailsBefore` / `detailsAfter`; anything malformed is treated as absent. */
export function parseEventDetails(value: unknown): EventDetailsView | null {
  if (!isRecord(value)) return null;
  const { title, scheduledStart, scheduledEnd, timezone, resources, status } = value;
  if (
    typeof title !== 'string' ||
    typeof scheduledStart !== 'string' ||
    typeof scheduledEnd !== 'string' ||
    typeof timezone !== 'string' ||
    typeof status !== 'string'
  ) {
    return null;
  }
  const list = Array.isArray(resources)
    ? resources.flatMap((r) =>
        isRecord(r) && typeof r.id === 'string' && typeof r.name === 'string'
          ? [{ id: r.id, name: r.name }]
          : [],
      )
    : [];
  return { title, scheduledStart, scheduledEnd, timezone, resources: list, status };
}

export interface ScheduleChange {
  kind: 'changed' | 'canceled' | 'published';
  before: EventDetailsView | null;
  after: EventDetailsView | null;
}

/** The old and new details of a schedule notice (SPK-COMMS-005), or null for other notices. */
export function scheduleChangeOf(item: InboxItem): ScheduleChange | null {
  if (!SCHEDULE_KINDS.has(item.kind)) return null;
  const before = parseEventDetails(item.detailsBefore);
  const after = parseEventDetails(item.detailsAfter);
  if (!before && !after) return null;
  const kind =
    item.kind === 'cancellation'
      ? 'canceled'
      : item.kind === 'schedule_published'
        ? 'published'
        : 'changed';
  return { kind, before, after };
}

/**
 * The newest notice about a scheduling event that has not been replaced: what a screen shows as
 * the event's current practical details (§6.2 "Notification opened after its event changes").
 */
export function latestChangeForEvent(
  items: readonly InboxItem[],
  eventId: string | null | undefined,
): { item: InboxItem; change: ScheduleChange } | null {
  if (!eventId) return null;
  for (const item of items) {
    if (item.supersededByNotificationId) continue;
    if (item.subject?.type !== 'event' || item.subject.id !== eventId) continue;
    const change = scheduleChangeOf(item);
    if (change) return { item, change };
  }
  return null;
}

/**
 * The fixture an availability request notice asks about (COM-06: subject `fixture`, details with
 * the fixture start in the facility's zone), or null for other notices.
 */
export function availabilityRequestOf(
  item: InboxItem,
): { fixtureId: string; scheduledStart: string | null } | null {
  if (item.kind !== 'availability_request') return null;
  const details = isRecord(item.detailsAfter) ? item.detailsAfter : null;
  const fixtureId =
    item.subject?.type === 'fixture'
      ? item.subject.id
      : typeof details?.fixtureId === 'string'
        ? details.fixtureId
        : null;
  if (!fixtureId) return null;
  const scheduledStart =
    typeof details?.scheduledStart === 'string' ? details.scheduledStart : null;
  return { fixtureId, scheduledStart };
}

/** The newest availability request about `fixtureId` still open (not acknowledged or replaced). */
export function openAvailabilityRequest(
  items: readonly InboxItem[],
  fixtureId: string,
): InboxItem | null {
  return (
    items.find(
      (item) =>
        !item.acknowledgedAt &&
        !item.supersededByNotificationId &&
        availabilityRequestOf(item)?.fixtureId === fixtureId,
    ) ?? null
  );
}

/** Schedule changes and cancellations still ahead, newest first (Schedule's changes list). */
export function upcomingScheduleChanges(items: readonly InboxItem[], now: Date) {
  return items.flatMap((item) => {
    if (item.supersededByNotificationId) return [];
    if (item.kind !== 'schedule_changed' && item.kind !== 'cancellation') return [];
    const change = scheduleChangeOf(item);
    if (!change) return [];
    const end = change.after?.scheduledEnd ?? change.before?.scheduledEnd;
    if (end && new Date(end).getTime() <= now.getTime()) return [];
    return [{ item, change }];
  });
}

/** "Essential notice" or "Promotional message" (SPK-COMMS-007). */
export function categoryLabel(item: Pick<InboxItem, 'category'>): string {
  return item.category === 'promotional' ? 'Promotional message' : 'Essential notice';
}

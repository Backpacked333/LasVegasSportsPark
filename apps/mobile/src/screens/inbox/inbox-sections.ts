/**
 * SCR-C-06 inbox: the pure parts of the list (ADR-008, PA-11). Which notices need the person
 * ("Needs action"), and the day sections the list is grouped in, newest first.
 *
 * "Needs action" is the notices Home would show in its urgent, actions or invitations sections
 * (`noticeSection`, SPK-UX-003): operational, not replaced by a newer one, not acknowledged, and of
 * a kind that asks for something (a schedule change still ahead, a payment, an availability request,
 * an invitation or offer). Promotional messages never need action (SPK-COMMS-007).
 */
import type { Schema } from '@sportspark/api-client';
import { noticeSection } from '../../features/today/notices';
import { addLocalDays, formatDay, localDayKey, startOfLocalDay } from '../../features/today/time';

type InboxItem = Schema<'InboxItem'>;

export type InboxTab = 'all' | 'action';

const ACTION_SECTIONS = new Set(['urgent', 'actions', 'invitations']);

/** The notice asks the person to do something now. */
export function needsAction(item: InboxItem, now: Date): boolean {
  const section = noticeSection(item, now);
  return section !== null && ACTION_SECTIONS.has(section);
}

export interface InboxDay {
  /** "2026-10-24" in the display zone. */
  key: string;
  /** "Today", "Yesterday" or "Sat, Oct 24". */
  title: string;
  data: InboxItem[];
}

/** When the notice arrived: delivered, else created. */
export function noticeTime(item: Pick<InboxItem, 'deliveredAt' | 'createdAt'>): string {
  return item.deliveredAt ?? item.createdAt;
}

/** "Today", "Yesterday", else the day ("Sat, Oct 24"), in `zone`. */
export function dayTitle(iso: string, now: Date, zone: string): string {
  const key = localDayKey(iso, zone);
  if (key === localDayKey(now, zone)) return 'Today';
  const yesterday = addLocalDays(startOfLocalDay(now, zone), -1, zone);
  if (key === localDayKey(yesterday, zone)) return 'Yesterday';
  return formatDay(iso, zone);
}

/**
 * The notices of a tab, grouped by the day they arrived, in the API's order (newest first). A day
 * appears once even when the API's order is not strictly by day.
 */
export function inboxSections(
  items: readonly InboxItem[],
  tab: InboxTab,
  now: Date,
  zone: string,
): InboxDay[] {
  const days = new Map<string, InboxDay>();
  for (const item of items) {
    if (tab === 'action' && !needsAction(item, now)) continue;
    const at = noticeTime(item);
    const key = localDayKey(at, zone);
    const day = days.get(key);
    if (day) day.data.push(item);
    else days.set(key, { key, title: dayTitle(at, now, zone), data: [item] });
  }
  return [...days.values()];
}

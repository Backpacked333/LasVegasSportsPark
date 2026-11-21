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
import {
  addLocalDays,
  formatDay,
  formatTime,
  localDayKey,
  startOfLocalDay,
} from '../../features/today/time';

type InboxItem = Schema<'InboxItem'>;

/** The segments (handoff M 2d): All, To do, Changes, Results. */
export type InboxTab = 'all' | 'todo' | 'changes' | 'results';

const CHANGE_KINDS: ReadonlySet<string> = new Set([
  'schedule_changed',
  'cancellation',
  'schedule_published',
]);
const RESULT_KINDS: ReadonlySet<string> = new Set(['result_published', 'result_reminder']);

/** Whether a notice belongs to a segment: To do asks for something; Changes; Results. */
export function inTab(item: InboxItem, tab: InboxTab, now: Date): boolean {
  switch (tab) {
    case 'todo':
      return needsAction(item, now);
    case 'changes':
      return CHANGE_KINDS.has(item.kind);
    case 'results':
      return RESULT_KINDS.has(item.kind);
    default:
      return true;
  }
}

/** What kind of row a notice is drawn as (its leading mark). */
export type NoticeLook = 'change' | 'result' | 'offer' | 'payment' | 'other';

export function noticeLook(item: InboxItem): NoticeLook {
  if (CHANGE_KINDS.has(item.kind)) return 'change';
  if (RESULT_KINDS.has(item.kind)) return 'result';
  if (item.kind === 'waitlist_offer' || item.kind === 'team_place_offer') return 'offer';
  if (item.kind === 'payment_attention') return 'payment';
  return 'other';
}

const ACTION_SECTIONS = new Set(['urgent', 'actions', 'invitations']);

/** The notice asks the person to do something now. */
export function needsAction(item: InboxItem, now: Date): boolean {
  const section = noticeSection(item, now);
  return section !== null && ACTION_SECTIONS.has(section);
}

export interface InboxDay {
  /** The section's title, also its key. */
  key: string;
  /** "Today", "This week" or "Earlier". */
  title: string;
  data: InboxItem[];
}

/** When the notice arrived: delivered, else created. */
export function noticeTime(item: Pick<InboxItem, 'deliveredAt' | 'createdAt'>): string {
  return item.deliveredAt ?? item.createdAt;
}

/**
 * The section a notice is listed under (handoff M 2d): "Today", "This week" (the six days before),
 * else "Earlier", in `zone`.
 */
export function dayTitle(iso: string, now: Date, zone: string): string {
  const key = localDayKey(iso, zone);
  if (key === localDayKey(now, zone)) return 'Today';
  const weekAgo = addLocalDays(startOfLocalDay(now, zone), -6, zone);
  if (key >= localDayKey(weekAgo, zone)) return 'This week';
  return 'Earlier';
}

/** "7:12 AM" today, the weekday ("Sat") this week, else the date ("Oct 24"), in `zone`. */
export function rowTime(iso: string, now: Date, zone: string): string {
  const title = dayTitle(iso, now, zone);
  if (title === 'Today') return formatTime(iso, zone);
  const day = formatDay(iso, zone);
  return title === 'This week' ? (day.split(',')[0] as string) : (day.split(', ')[1] ?? day);
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
    if (!inTab(item, tab, now)) continue;
    const at = noticeTime(item);
    const title = dayTitle(at, now, zone);
    const key = title;
    const day = days.get(key);
    if (day) day.data.push(item);
    else days.set(key, { key, title, data: [item] });
  }
  return [...days.values()];
}

/**
 * Where a notice row on Home opens (SPK-UX-003, PA-11 **Proposed**: Home rows open the item they
 * are about). A pure function of the notice's subject (`InboxItem.subject`, the `{ type, id }` the
 * API composes the notice with) to the screen of that record:
 *
 * | Subject type           | Customer word   | Route                           |
 * | ---------------------- | --------------- | ------------------------------- |
 * | `fixture`              | game            | `/fixtures/{id}`                |
 * | `enrollment`           | registration    | `/enrollments/{id}`             |
 * | `obligation`           | amount due      | `/payments/{id}`                |
 * | `payment_attempt`      | payment         | `/payments/attempt/{id}`        |
 * | `order`                | order           | `/payments/order/{id}`          |
 * | `waitlist_entry`       | waitlist entry  | `/registration/waitlist/{id}`   |
 * | `team_entry`           | team            | `/team/{id}`                    |
 * | `contribution_request` | your share      | `/team/contribution/{id}`       |
 * | `booking`              | booking         | `/bookings/{id}`                |
 * | `offering`             | activity        | `/registration/offering/{id}`   |
 *
 * An availability request (COM-06) opens its game, from the subject or from its details. Anything
 * else (a schedule change about an event, which the inbox shows with its old and new details; a
 * subject without a screen of its own; an id that is not a record id) opens the notice in the
 * inbox, as before. Routes carry opaque record ids only (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import type { Href } from 'expo-router';
import { availabilityRequestOf } from './notices';

type InboxItem = Schema<'InboxItem'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route of each subject type that has a screen of its own. */
const ROUTES: Readonly<Record<string, (id: string) => string>> = {
  fixture: (id) => `/fixtures/${id}`,
  enrollment: (id) => `/enrollments/${id}`,
  obligation: (id) => `/payments/${id}`,
  payment_attempt: (id) => `/payments/attempt/${id}`,
  order: (id) => `/payments/order/${id}`,
  waitlist_entry: (id) => `/registration/waitlist/${id}`,
  team_entry: (id) => `/team/${id}`,
  contribution_request: (id) => `/team/contribution/${id}`,
  booking: (id) => `/bookings/${id}`,
  offering: (id) => `/registration/offering/${id}`,
};

/** The subject types a notice row opens directly (the rest open the inbox). */
export const NOTICE_TARGET_SUBJECTS = Object.keys(ROUTES);

export type NoticeTarget =
  /** The record the notice is about. */
  | { kind: 'subject'; href: string }
  /** The notice itself, in the inbox (which marks it read on opening). */
  | { kind: 'inbox'; href: Href };

/** What a notice row opens: the record it is about, or the notice in the inbox. */
export function noticeTarget(
  item: Pick<InboxItem, 'attemptId' | 'kind' | 'subject' | 'detailsAfter'>,
): NoticeTarget {
  const request = availabilityRequestOf(item as InboxItem);
  const subject = request
    ? { type: 'fixture', id: request.fixtureId }
    : (item.subject ?? { type: '', id: '' });
  const route = Object.prototype.hasOwnProperty.call(ROUTES, subject.type)
    ? ROUTES[subject.type]
    : undefined;
  if (route && UUID.test(subject.id)) return { kind: 'subject', href: route(subject.id) };
  return { kind: 'inbox', href: { pathname: '/inbox', params: { open: item.attemptId } } as Href };
}

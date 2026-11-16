/**
 * PA-11 SPK-UX-003 (**Proposed**): a Home notice row opens the item it is about. `noticeTarget`
 * maps each subject type the API composes notices with to the record's route; anything else opens
 * the notice in the inbox, as before.
 */
import type { Schema } from '@sportspark/api-client';
import { NOTICE_TARGET_SUBJECTS, noticeTarget } from '../notice-target';
import { notice as noticeFixture } from './fixtures';

const notice = (overrides: Record<string, unknown>) =>
  noticeFixture(overrides) as Schema<'InboxItem'>;

const ID = '0192f1a0-0000-7000-8000-00000000c0de';

describe('noticeTarget (PA-11 SPK-UX-003)', () => {
  it.each([
    ['fixture', 'a game', `/fixtures/${ID}`],
    ['enrollment', 'a registration', `/enrollments/${ID}`],
    ['obligation', 'an amount due', `/payments/${ID}`],
    ['payment_attempt', 'a payment', `/payments/attempt/${ID}`],
    ['order', 'an order', `/payments/order/${ID}`],
    ['waitlist_entry', 'a waitlist entry', `/registration/waitlist/${ID}`],
    ['team_entry', 'a team', `/team/${ID}`],
    ['contribution_request', 'your share', `/team/contribution/${ID}`],
    ['booking', 'a booking', `/bookings/${ID}`],
    ['offering', 'an activity', `/registration/offering/${ID}`],
  ])('a notice about a %s (%s) opens %s', (type, _word, href) => {
    expect(noticeTarget(notice({ subject: { type, id: ID } }))).toEqual({
      kind: 'subject',
      href,
    });
  });

  it('covers exactly the ten subject kinds with a screen of their own', () => {
    expect([...NOTICE_TARGET_SUBJECTS].sort()).toEqual(
      [
        'booking',
        'contribution_request',
        'enrollment',
        'fixture',
        'obligation',
        'offering',
        'order',
        'payment_attempt',
        'team_entry',
        'waitlist_entry',
      ].sort(),
    );
  });

  it('an availability request opens its game, from the subject or from its details', () => {
    expect(
      noticeTarget(
        notice({ kind: 'availability_request', subject: null, detailsAfter: { fixtureId: ID } }),
      ),
    ).toEqual({ kind: 'subject', href: `/fixtures/${ID}` });
  });

  it.each([
    ['no subject', null],
    ['a schedule change about an event', { type: 'event', id: ID }],
    ['a subject without a screen of its own', { type: 'installment', id: ID }],
    [
      'a waitlist offer (its route takes the entry, not the offer)',
      { type: 'waitlist_offer', id: ID },
    ],
    ['an unknown subject type', { type: 'something_new', id: ID }],
    ['an inherited property name', { type: 'constructor', id: ID }],
    ['an id that is not a record id', { type: 'enrollment', id: '../../pass' }],
  ])('%s opens the notice in the inbox, as before', (_case, subject) => {
    const item = notice({ subject });
    expect(noticeTarget(item)).toEqual({
      kind: 'inbox',
      href: { pathname: '/inbox', params: { open: item.attemptId } },
    });
  });
});

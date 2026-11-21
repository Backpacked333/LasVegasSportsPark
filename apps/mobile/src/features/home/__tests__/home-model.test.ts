/**
 * Pure rules behind the redesigned Home (handoff 1b, 3a; INTERACTIONS 1b rows 2, 3, 6 to 8;
 * "Times"; SPK-SCHED-008): the live countdown, the To do list and its summary, the answer counts
 * and words, the Home tab badge, and "Also sign" for a sibling's waiver.
 */
import { todoBadge } from '../../../navigation/TabsNavigator';
import { offersAlsoSign } from '../../waivers/SignSheet';
import { answerCounts, answerSentence } from '../answers';
import { shortMoney, todoItems, todoSummary } from '../todo';
import { countdown, dayWord, inWords } from '../when';

const LA = 'America/Los_Angeles';
// Saturday, November 21, 2026, 6:45 AM in Las Vegas.
const NOW = new Date('2026-11-21T14:45:00.000Z');

describe('countdown (INTERACTIONS 1b row 2)', () => {
  it('counts down today in hours and minutes, minutes under an hour, "Now" from the start', () => {
    expect(countdown('2026-11-21T17:00:00.000Z', '2026-11-21T17:50:00.000Z', NOW, LA).label).toBe(
      'Today · in 2 h 15 min',
    );
    expect(countdown('2026-11-21T14:59:00.000Z', '2026-11-21T15:50:00.000Z', NOW, LA).label).toBe(
      'Today · in 14 min',
    );
    expect(countdown('2026-11-21T14:00:00.000Z', '2026-11-21T15:00:00.000Z', NOW, LA)).toEqual({
      state: 'now',
      label: 'Now',
    });
    expect(inWords(3 * 3_600_000)).toBe('in 3 h');
  });

  it('names another day as Tomorrow, a weekday within 6 days, then the date (facility clock)', () => {
    expect(dayWord('2026-11-22T17:00:00.000Z', NOW, LA)).toBe('Tomorrow');
    expect(dayWord('2026-11-25T17:00:00.000Z', NOW, LA)).toBe('Wed');
    expect(dayWord('2026-12-05T17:00:00.000Z', NOW, LA)).toBe('Sat, Dec 5');
    expect(countdown('2026-11-22T17:00:00.000Z', '2026-11-22T18:00:00.000Z', NOW, LA).label).toBe(
      'Tomorrow · 9:00 AM',
    );
  });
});

const obligation = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'o1',
    debtor: { kind: 'person', personId: 'maya', teamEntryId: null },
    description: 'Spring Rec League',
    dueAt: '2026-11-28T02:00:00.000Z',
    status: 'open',
    totals: { remainingMinor: 12000, currency: 'USD' },
    ...overrides,
  }) as never;

const waiver = (overrides: Record<string, unknown> = {}) =>
  ({
    policyKey: 'liability',
    title: 'Liability waiver',
    status: 'missing',
    currentVersion: {
      policyVersionId: 'v',
      version: 1,
      title: 'Liability waiver',
      effectiveFrom: '',
    },
    validUntil: null,
    ...overrides,
  }) as never;

const invitation = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'i1', teamName: 'FC Neon', effectiveStatus: 'pending', ...overrides }) as never;

describe('To do (INTERACTIONS 1b rows 6 to 8, 3a)', () => {
  it('lists fees, then forms, then invitations; a paid balance, a current waiver and a snoozed invite are not to-dos', () => {
    const items = todoItems({
      obligations: [
        obligation(),
        obligation({ id: 'o2', totals: { remainingMinor: 0, currency: 'USD' } }),
      ],
      waivers: [
        { personId: 'leo', waivers: [waiver()] },
        { personId: 'maya', waivers: [waiver({ status: 'current' })] },
      ],
      invitations: [invitation(), invitation({ id: 'i2', teamName: 'Later FC' })],
      selfId: 'dana',
      now: NOW,
      snoozed: new Map([['i2', NOW.getTime() + 1000]]),
    });
    expect(items.map((i) => `${i.kind}:${i.personId}:${i.title}`)).toEqual([
      'pay:maya:Spring Rec League',
      'sign:leo:Liability waiver',
      'join:dana:FC Neon',
    ]);
    expect(todoSummary(items)).toBe('3 left · about 2 min');
    expect(todoSummary([])).toBe('✓ All done');
    expect(shortMoney(12000, 'USD')).toBe('$120');
    expect(shortMoney(12050, 'USD')).toBe('$120.50');
  });

  it('Shell row 2: the Home badge is hidden at 0 and reads 9+ above 9', () => {
    expect(todoBadge(0)).toBeUndefined();
    expect(todoBadge(3)).toBe('3');
    expect(todoBadge(12)).toBe('9+');
  });
});

describe('answers (INTERACTIONS 1b row 3, 3a "7 → 8")', () => {
  it('moves one person between counts and says it in words', () => {
    const counts = answerCounts(
      { available: 7, tentative: 1, unavailable: 1, noResponse: 3 },
      null,
      'available',
    );
    expect(counts).toEqual({
      going: 8,
      maybe: 1,
      notGoing: 1,
      noAnswer: 2,
      answered: 10,
      total: 12,
    });
    expect(answerSentence('Maya', false, 'available')).toBe('Maya is going');
    expect(answerSentence('Maya', false, 'tentative')).toBe('Maya is a maybe');
    expect(answerSentence('You', true, 'unavailable')).toBe("You're not going");
  });
});

describe('"Also sign for Maya" (handoff 2c row 4)', () => {
  it('offers the same form when the sibling has none, or it ends within 30 days; never a different form', () => {
    const main = waiver();
    expect(offersAlsoSign(main, waiver(), NOW)).toBe(true);
    expect(
      offersAlsoSign(
        main,
        waiver({ status: 'current', validUntil: '2026-12-03T00:00:00.000Z' }),
        NOW,
      ),
    ).toBe(true);
    expect(
      offersAlsoSign(
        main,
        waiver({ status: 'current', validUntil: '2027-06-01T00:00:00.000Z' }),
        NOW,
      ),
    ).toBe(false);
    expect(offersAlsoSign(main, waiver({ policyKey: 'photo' }), NOW)).toBe(false);
  });
});

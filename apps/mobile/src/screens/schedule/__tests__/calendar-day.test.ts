/**
 * Handoff M 1h Calendar, the day model (INTERACTIONS 1h row 2 and "Screen states"; SPK-YOUTH-007).
 */
import { calendarItem, LA } from '../../../features/today/__tests__/fixtures';
import { sessionEntry, type TodayEntry } from '../../../features/today/entries';
import {
  blockKeyOf,
  dayBlocks,
  dayHeading,
  emptyRunLine,
  junctures,
  type Who,
} from '../calendar-day';

type Item = Parameters<typeof sessionEntry>[0];

function entry(id: string, start: string, end: string, place: string | null, personId = 'p1') {
  return sessionEntry(calendarItem({ id, start, end, place, personId }) as Item);
}

const who: Record<string, Who> = {
  p1: { name: 'Maya', self: false },
  p2: { name: 'Leo', self: false },
  me: { name: 'You', self: true },
};
const whoOf = (e: TodayEntry) => who[e.type === 'session' ? e.item.personId : 'p1'] as Who;
const zone = () => LA;

describe('handoff M 1h: days and empty runs', () => {
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
  const one = entry('a', '2026-11-18T17:00:00Z', '2026-11-18T18:00:00Z', null);

  it('collapses each run of empty days into one block keyed by its first day', () => {
    const blocks = dayBlocks(days, new Map([['2026-11-18', [one]]]));
    expect(blocks.map((b) => [b.kind, b.key])).toEqual([
      ['empty', '2026-11-16'],
      ['day', '2026-11-18'],
      ['empty', '2026-11-19'],
    ]);
    expect(blockKeyOf(blocks, '2026-11-17')).toBe('2026-11-16');
    expect(blockKeyOf(blocks, '2026-11-20')).toBe('2026-11-19');
  });

  it('says a run in one line, and names today and tomorrow', () => {
    expect(emptyRunLine(['2026-11-23', '2026-11-24'])).toBe('Mon 23 – Tue 24 · nothing scheduled');
    expect(emptyRunLine(['2026-11-23'])).toBe('Mon 23 · nothing scheduled');
    expect(dayHeading('2026-11-21', '2026-11-21', '2026-11-22')).toBe('Today · Saturday 21');
    expect(dayHeading('2026-11-22', '2026-11-21', '2026-11-22')).toBe('Tomorrow · Sunday 22');
    expect(dayHeading('2026-11-23', '2026-11-21', '2026-11-22')).toBe('Monday 23');
  });
});

describe('handoff M 1h row 2: back to back and clashes (SPK-YOUTH-007)', () => {
  // 9:00 to 10:00 and 10:30 to 11:15 in Los Angeles.
  const game = entry('a', '2026-11-21T17:00:00Z', '2026-11-21T18:00:00Z', 'Field 2', 'p1');
  const skills = entry('b', '2026-11-21T18:30:00Z', '2026-11-21T19:15:00Z', 'Indoor court 1', 'p2');

  it('under 45 minutes between two named, different spaces is back to back, naming both', () => {
    expect(junctures([skills, game], whoOf, zone)).toEqual([
      expect.objectContaining({
        kind: 'back-to-back',
        sentence: 'Maya finishes at 10:00 on Field 2. Leo starts at 10:30 on Indoor court 1.',
      }),
    ]);
  });

  it('the account holder reads in the second person', () => {
    const mine = entry('c', '2026-11-21T18:30:00Z', '2026-11-21T19:00:00Z', 'Court', 'me');
    expect(junctures([game, mine], whoOf, zone)[0]?.sentence).toBe(
      'Maya finishes at 10:00 on Field 2. You start at 10:30 on Court.',
    );
  });

  it('45 minutes apart, the same space, or a space not named is not called out', () => {
    const later = entry('d', '2026-11-21T18:45:00Z', '2026-11-21T19:15:00Z', 'Court', 'p2');
    const same = entry('e', '2026-11-21T18:10:00Z', '2026-11-21T19:00:00Z', 'Field 2', 'p2');
    const unnamed = entry('f', '2026-11-21T18:10:00Z', '2026-11-21T19:00:00Z', null, 'p2');
    expect(junctures([game, later], whoOf, zone)).toEqual([]);
    expect(junctures([game, same], whoOf, zone)).toEqual([]);
    expect(junctures([game, unnamed], whoOf, zone)).toEqual([]);
  });

  it('an overlap is a clash, whatever the spaces', () => {
    const overlap = entry('g', '2026-11-21T17:30:00Z', '2026-11-21T18:30:00Z', 'Court', 'p2');
    expect(junctures([game, overlap], whoOf, zone)).toEqual([
      expect.objectContaining({
        kind: 'clash',
        sentence: 'Maya is on Field 2 until 10:00, but Leo starts at 9:30 on Court.',
      }),
    ]);
  });
});

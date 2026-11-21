/** Pure rules of the coach's tiles and "now" session (S 2d; SPK-ENTRY-005, §4.7 invariant 9). */
import { describe, expect, it } from 'vitest';
import {
  countTiles,
  currentSession,
  nextOnTap,
  phaseText,
  sessionTitle,
  tileName,
  tileOf,
} from '../tile-model';
import { coachAssignment } from './coach-fixtures';

describe('tile rules', () => {
  it('INTERACTIONS 2d row 1: Unmarked → Here → Late → Unmarked; a recorded mark never goes back to Unmarked', () => {
    expect(nextOnTap('unmarked', false)).toBe('present');
    expect(nextOnTap('present', false)).toBe('late');
    expect(nextOnTap('late', false)).toBe('unmarked');
    expect(nextOnTap('late', true)).toBe('present');
    expect(nextOnTap('absent', true)).toBe('present');
  });

  it('counts, names and observed states as the tiles show them', () => {
    expect(countTiles(['present', 'present', 'late', 'unmarked'])).toEqual({
      present: 2,
      late: 1,
      absent: 0,
      unmarked: 1,
    });
    expect(tileName('Ava Kim')).toBe('Ava K.');
    expect(tileName('Cher')).toBe('Cher');
    expect(tileOf('left_early')).toBe('present');
    expect(tileOf(null)).toBe('unmarked');
    expect(sessionTitle('Little Kickers (session 3)')).toBe('Little Kickers');
  });

  it("SPK-UX-007: the coach's session now is running, within the hour, or at pickup; never an offer or a fixture", () => {
    const now = new Date('2026-10-24T12:00:00.000Z');
    expect(currentSession([coachAssignment() as never], now)?.assignment.id).toBeDefined();
    expect(currentSession([coachAssignment({ status: 'offered' }) as never], now)).toBeNull();
    expect(currentSession([coachAssignment({ kind: 'official' }) as never], now)).toBeNull();
    expect(
      currentSession([coachAssignment() as never], new Date('2026-10-24T14:00:00.000Z')),
    ).toBeNull();
    expect(phaseText('2026-10-24T11:48:00.000Z', '2026-10-24T12:33:00.000Z', now)).toEqual({
      live: true,
      text: 'Now · 12 min in',
    });
    expect(phaseText('2026-10-24T12:20:00.000Z', '2026-10-24T13:00:00.000Z', now).text).toBe(
      'Starts in 20 min',
    );
  });
});

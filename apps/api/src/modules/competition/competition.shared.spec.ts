import { z } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { FIXTURE_TITLE_MAX, fixtureTitle } from './competition.shared';

/**
 * The scheduling title bound (`CreateEventSeriesBody.title`, `EventWriter.insertEvent`
 * `EVENT_TITLE_MAX`); no direct event-creation route exists (R3-DOCS-TRUTH-3-09).
 */
const SchedulingTitle = z.string().min(1).max(200);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('fixture titles (R2-TENANCY-INPUT-02, SPK-COMMS-005)', () => {
  it('keeps "home v away" unchanged when it fits', () => {
    expect(fixtureTitle('Lions', 'Tigers')).toBe('Lions v Tigers');
    const exact = fixtureTitle('a'.repeat(98), 'b'.repeat(99));
    expect(exact).toBe(`${'a'.repeat(98)} v ${'b'.repeat(99)}`);
    expect(exact).toHaveLength(FIXTURE_TITLE_MAX);
  });

  it('two 200-character team names give a title within the scheduling title limit, both cut with an ellipsis', () => {
    const title = fixtureTitle('H'.repeat(200), 'A'.repeat(200));
    expect(title.length).toBeLessThanOrEqual(FIXTURE_TITLE_MAX);
    expect(SchedulingTitle.safeParse(title).success).toBe(true);
    const [home, away] = title.split(' v ');
    expect(home).toMatch(/^H+…$/);
    expect(away).toMatch(/^A+…$/);
    // the room is shared: neither side is cut to nothing
    expect(home!.length).toBeGreaterThanOrEqual(90);
    expect(away!.length).toBeGreaterThanOrEqual(90);
  });

  it('a short name stays whole and the long one takes the remaining room', () => {
    const title = fixtureTitle('Comets', 'L'.repeat(200));
    expect(title.length).toBeLessThanOrEqual(FIXTURE_TITLE_MAX);
    expect(title.startsWith('Comets v L')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    const reversed = fixtureTitle('L'.repeat(200), 'Comets');
    expect(reversed.length).toBeLessThanOrEqual(FIXTURE_TITLE_MAX);
    expect(reversed.endsWith('… v Comets')).toBe(true);
  });

  it('counts UTF-16 units as the contract does and never splits a surrogate pair', () => {
    const lion = '\u{1F981}';
    const title = fixtureTitle(lion.repeat(150), lion.repeat(150));
    expect(title.length).toBeLessThanOrEqual(FIXTURE_TITLE_MAX);
    expect(SchedulingTitle.safeParse(title).success).toBe(true);
    expect(LONE_SURROGATE.test(title)).toBe(false);
  });
});

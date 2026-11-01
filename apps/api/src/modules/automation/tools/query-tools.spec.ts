import { describe, expect, it } from 'vitest';
import { todaySourceGaps } from './query-tools';

/**
 * R3-PERFORMANCE-01 / SPK-AUTO-002 (missing evidence is named, never silently dropped): the
 * assistant's Today tool reports a source the feed's per-request bound truncated as partly
 * included (`limit_reached`), as well as sources it could not read.
 */
describe('todaySourceGaps (R3-PERFORMANCE-01, SPK-AUTO-002)', () => {
  it('names truncated, unavailable and withheld sources; a complete source is not missing', () => {
    const gaps = todaySourceGaps([
      {
        source: 'scheduling.schedule',
        facilityId: null,
        status: 'ok',
        truncated: false,
        omitted: 0,
      },
      {
        source: 'kernel.operational_exceptions',
        facilityId: null,
        status: 'ok',
        truncated: true,
        omitted: 7,
      },
      {
        source: 'competition.readiness',
        facilityId: 'f1',
        status: 'ok',
        truncated: true,
        omitted: null,
      },
      {
        source: 'workforce.coverage',
        facilityId: 'f1',
        status: 'unavailable',
        truncated: false,
        omitted: null,
      },
      {
        source: 'finance.payments',
        facilityId: null,
        status: 'not_permitted',
        truncated: false,
        omitted: null,
      },
    ]);
    expect(gaps.map((g) => [g.recordId, g.reason])).toEqual([
      ['kernel.operational_exceptions', 'limit_reached'],
      ['competition.readiness:f1', 'limit_reached'],
      ['workforce.coverage:f1', 'source_unavailable'],
      ['finance.payments', 'not_available'],
    ]);
    expect(gaps[0]?.description).toContain('7 record(s)');
    expect(gaps[1]?.description).toContain('more records than shown');
  });
});

import { describe, expect, it } from 'vitest';
import { allocateSales, perHour, type OfferingEvent, type SaleLine } from './allocation';
import { cohortOutcome } from './cohorts';
import { intersect, length, normalize, subtract, union } from './intervals';
import { computeUtilization, type UtilizationInput } from './utilization.calculator';

const H = 3_600_000;
const M = 60_000;

describe('interval arithmetic', () => {
  it('normalizes, unions, intersects and subtracts half-open intervals without counting an instant twice', () => {
    expect(
      normalize([
        [5, 10],
        [0, 3],
        [3, 4],
        [9, 12],
        [20, 20],
      ]),
    ).toEqual([
      [0, 4],
      [5, 12],
    ]);
    expect(length(union([[0, 10]], [[5, 15]]))).toBe(15);
    expect(
      intersect(
        [
          [0, 10],
          [20, 30],
        ],
        [[5, 25]],
      ),
    ).toEqual([
      [5, 10],
      [20, 25],
    ]);
    expect(
      subtract(
        [[0, 30]],
        [
          [5, 10],
          [20, 25],
        ],
      ),
    ).toEqual([
      [0, 5],
      [10, 20],
      [25, 30],
    ]);
    expect(subtract([[0, 10]], [[0, 10]])).toEqual([]);
  });
});

describe('utilization calculator (SPK-REPORT-003)', () => {
  const day = { date: '2027-02-03', start: 0, end: 24 * H };
  const base = (overrides: Partial<UtilizationInput> = {}): UtilizationInput => ({
    days: [day],
    units: [
      { id: 'north', name: 'north' },
      { id: 'south', name: 'south' },
    ],
    resources: [
      { id: 'pitch', name: 'Pitch', kind: 'pitch', parentId: null, unitIds: ['north', 'south'] },
      {
        id: 'n-half',
        name: 'North half',
        kind: 'subdivision',
        parentId: 'pitch',
        unitIds: ['north'],
      },
      {
        id: 's-half',
        name: 'South half',
        kind: 'subdivision',
        parentId: 'pitch',
        unitIds: ['south'],
      },
    ],
    windowsFor: () => [[8 * H, 22 * H]],
    closures: [],
    reservations: [],
    observedEventIds: new Set(),
    includeBuffers: true,
    weighting: { method: 'conflict_units' },
    ...overrides,
  });
  const whole = (unitId: string) => ({
    unitId,
    eventId: 'game',
    eventKind: 'game',
    occupiedStart: 10 * H,
    occupiedEnd: 11 * H + 10 * M,
    setupMs: 0,
    cleanupMs: 10 * M,
    countedEnd: Number.POSITIVE_INFINITY,
  });

  it('U1/U9: the same physical hour reserved once as a whole pitch counts once per unit and once in the facility total', () => {
    const result = computeUtilization(base({ reservations: [whole('north'), whole('south')] }));
    const byId = new Map(result.resources.map((r) => [r.resourceId, r]));
    expect(byId.get('pitch')!.reservedMs).toBe(140 * M);
    expect(byId.get('n-half')!.reservedMs).toBe(70 * M);
    expect(byId.get('s-half')!.reservedMs).toBe(70 * M);
    expect(result.facility.reservedMs).toBe(140 * M);
    expect(result.facility.bufferMs).toBe(20 * M);
    expect(result.facility.activityMs).toBe(120 * M);
  });

  it('U4/U6: closures reduce available time, are reported separately, and reserved time outside hours is never clipped away', () => {
    const result = computeUtilization(
      base({
        closures: [{ unitIds: ['south'], start: 6 * H, end: 10 * H }],
        reservations: [
          { ...whole('north'), occupiedStart: 7 * H, occupiedEnd: 9 * H, cleanupMs: 0 },
        ],
      }),
    );
    const f = result.facility;
    expect(f.closureMs).toBe(2 * H);
    expect(f.closureOutsideHoursMs).toBe(2 * H);
    expect(f.availableMs).toBe(28 * H - 2 * H);
    expect(f.reservedMs).toBe(1 * H);
    expect(f.reservedOutsideHoursMs).toBe(1 * H);
  });

  it('U4: maintenance and block events are unavailability, not reserved use', () => {
    const result = computeUtilization(
      base({
        reservations: [
          { ...whole('north'), eventKind: 'maintenance', cleanupMs: 0, occupiedEnd: 11 * H },
        ],
      }),
    );
    expect(result.facility.reservedMs).toBe(0);
    expect(result.facility.closureMs).toBe(1 * H);
  });

  it('U8: a released reservation counts only before its release', () => {
    const result = computeUtilization(
      base({ reservations: [{ ...whole('north'), countedEnd: 10 * H + 30 * M }] }),
    );
    expect(result.facility.reservedMs).toBe(30 * M);
  });

  it('U3: resource-equivalent utilization weighs whole spaces only and lists what it excludes', () => {
    const result = computeUtilization(
      base({
        units: [...base().units, { id: 'room', name: 'room' }],
        resources: [
          ...base().resources,
          { id: 'room', name: 'Room', kind: 'room', parentId: null, unitIds: ['room'] },
        ],
        reservations: [whole('north'), whole('south')],
        weighting: { method: 'custom', weights: new Map([['pitch', 1]]) },
      }),
    );
    expect(result.resourceEquivalent.included).toEqual([
      { resourceId: 'pitch', name: 'Pitch', weight: 1 },
    ]);
    expect(result.resourceEquivalent.excluded).toEqual([
      { resourceId: 'room', name: 'Room', reason: 'no weight under the chosen method' },
    ]);
    expect(result.resourceEquivalent.rate).toBeCloseTo(70 / (14 * 60), 6);
  });

  it('G13: no operating hours configured means no available time, flagged per unit-day', () => {
    const result = computeUtilization(base({ windowsFor: () => null }));
    expect(result.facility.availableMs).toBe(0);
    expect(result.facility.unconfiguredDays).toBe(2);
    expect(result.resourceEquivalent.rate).toBeNull();
  });
});

describe('sales allocation (SPK-REPORT-004)', () => {
  const lines: SaleLine[] = [
    {
      lineId: 'term',
      offeringId: 'o-term',
      offeringKind: 'term',
      totalMinor: 10_001,
      currency: 'USD',
      fulfilledOn: '2027-02-01',
    },
    {
      lineId: 'membership',
      offeringId: 'o-member',
      offeringKind: 'membership',
      totalMinor: 3_000,
      currency: 'USD',
      fulfilledOn: '2027-02-01',
    },
  ];
  const events: OfferingEvent[] = [
    {
      offeringId: 'o-term',
      eventId: 'e1',
      eventOn: '2027-02-03',
      activityMinutes: 60,
      spaces: [{ resourceId: 'pitch', activityUnitMs: 2 * H }],
    },
    {
      offeringId: 'o-term',
      eventId: 'e2',
      eventOn: '2027-02-10',
      activityMinutes: 120,
      spaces: [
        { resourceId: 'north', activityUnitMs: H },
        { resourceId: 'south', activityUnitMs: H },
      ],
    },
  ];

  it('E1: pro rata spreads a line by activity minutes with largest remainder; nothing is lost or invented', () => {
    const { allocated, unallocated } = allocateSales(lines, events, 'pro_rata');
    const sum = allocated.reduce((s, p) => s + p.amountMinor, 0);
    expect(sum).toBe(10_001);
    expect(allocated.filter((p) => p.eventId === 'e1').map((p) => p.amountMinor)).toEqual([3_334]);
    expect(
      allocated
        .filter((p) => p.eventId === 'e2')
        .map((p) => p.amountMinor)
        .sort(),
    ).toEqual([3_333, 3_334]);
    expect(unallocated).toEqual([
      expect.objectContaining({
        lineId: 'membership',
        reason: 'sale_type_not_field_time',
        amountMinor: 3_000,
      }),
    ]);
  });

  it('E1: direct allocation needs exactly one scheduled event', () => {
    const { allocated, unallocated } = allocateSales(lines, events, 'direct');
    expect(allocated).toEqual([]);
    expect(unallocated.map((u) => u.reason).sort()).toEqual([
      'direct_needs_single_event',
      'sale_type_not_field_time',
    ]);
    const single = allocateSales([lines[0]!], [events[0]!], 'direct');
    expect(single.allocated).toEqual([
      expect.objectContaining({ eventId: 'e1', amountMinor: 10_001 }),
    ]);
  });

  it('a line without scheduled events or an event without a space stays unallocated', () => {
    expect(allocateSales([lines[0]!], [], 'pro_rata').unallocated[0]!.reason).toBe(
      'no_scheduled_events',
    );
    const spaceless = allocateSales([lines[0]!], [{ ...events[0]!, spaces: [] }], 'pro_rata');
    expect(spaceless.unallocated[0]).toMatchObject({
      reason: 'event_without_space',
      reportedOn: '2027-02-03',
    });
  });

  it('per-hour figures round half away from zero and are unavailable without hours', () => {
    expect(perHour(5_000, 2 * H)).toBe(2_500);
    expect(perHour(1, 2 * H)).toBe(1);
    expect(perHour(-1, 2 * H)).toBe(-1);
    expect(perHour(100, 0)).toBeNull();
  });
});

describe('cohort outcome (SPK-REPORT-005)', () => {
  it('K4: not-offered members are counted separately and excluded from the denominator only when asked', () => {
    const anchor = new Set(['a', 'b', 'c']);
    const comparison = new Set(['a', 'd']);
    expect(cohortOutcome(anchor, comparison)).toEqual({
      cohortSize: 3,
      returned: 1,
      notOffered: 0,
      denominator: 3,
      rate: 1 / 3,
      newInComparison: 1,
    });
    const notOffered = new Set(['b', 'a']);
    expect(cohortOutcome(anchor, comparison, { notOffered })).toMatchObject({
      notOffered: 1,
      denominator: 3,
    });
    expect(
      cohortOutcome(anchor, comparison, { notOffered, excludeNotOffered: true }),
    ).toMatchObject({
      notOffered: 1,
      denominator: 2,
      rate: 0.5,
    });
    expect(cohortOutcome(new Set(), comparison).rate).toBeNull();
  });
});

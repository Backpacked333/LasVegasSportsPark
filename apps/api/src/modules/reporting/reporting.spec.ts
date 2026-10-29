import { REPORT_KEYS, type ReportResponse } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { csvCell, renderCsv, resultDigest } from './output/report-output';
import { CostInputMachine, ExportMachine, MetricDefinitionMachine } from './reporting.machines';
import { definitionHash, METRICS, metricsForReport } from './reporting.metrics';
import { agingBand } from './reports/finance.reports';
import { costInputFor } from './reports/economics.report';
import { closedPeriods, parseWeights } from './reports/utilization.report';

describe('reporting state machines (§4.6)', () => {
  it('Export: ready → downloaded | expired | revoked; every other state is final', () => {
    expect(ExportMachine.next('ready', 'download')).toBe('downloaded');
    expect(ExportMachine.next('ready', 'expire')).toBe('expired');
    expect(ExportMachine.next('ready', 'revoke')).toBe('revoked');
    for (const state of ['downloaded', 'expired', 'revoked'] as const) {
      expect(ExportMachine.isTerminal(state)).toBe(true);
      for (const event of ['download', 'expire', 'revoke'] as const) {
        expect(() => ExportMachine.next(state, event)).toThrowError(/cannot/);
      }
    }
  });

  it('CostInput: active → withdrawn, final', () => {
    expect(CostInputMachine.next('active', 'withdraw')).toBe('withdrawn');
    expect(() => CostInputMachine.next('withdrawn', 'withdraw')).toThrowError(/cannot/);
  });

  it('MetricDefinition: active → superseded, final', () => {
    expect(MetricDefinitionMachine.next('active', 'supersede')).toBe('superseded');
    expect(() => MetricDefinitionMachine.next('superseded', 'supersede')).toThrowError(/cannot/);
  });
});

describe('metric registry (SPK-REPORT-001)', () => {
  it('every metric carries every SPK-REPORT-001 field and a unique key', () => {
    const keys = METRICS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of METRICS) {
      expect(m.key).toMatch(/^MET-\d{3}$/);
      for (const field of [
        m.name,
        m.businessQuestion,
        m.grain,
        m.numerator,
        m.denominator,
        m.timeBasis,
        m.accessScope,
      ]) {
        expect(field.length, m.key).toBeGreaterThan(0);
      }
      expect(Array.isArray(m.exclusions)).toBe(true);
      expect(Array.isArray(m.dimensions)).toBe(true);
      expect(['none', 'minor_units']).toContain(m.currency);
      expect(['F1', 'F2', 'F3']).toContain(m.freshness);
      expect(m.accessScope).toMatch(/^reporting\.view_/);
      expect(m.requirementIds.length).toBeGreaterThan(0);
      expect(m.reports.length).toBeGreaterThan(0);
    }
  });

  it('every report defines at least one metric, and every requirement SPK-REPORT-001..006 is cited', () => {
    for (const key of REPORT_KEYS) expect(metricsForReport(key).length, key).toBeGreaterThan(0);
    const cited = new Set(METRICS.flatMap((m) => m.requirementIds));
    for (const id of [
      'SPK-REPORT-002',
      'SPK-REPORT-003',
      'SPK-REPORT-004',
      'SPK-REPORT-005',
      'SPK-REPORT-006',
    ]) {
      expect(cited.has(id), id).toBe(true);
    }
  });

  it('the definition hash changes with any field (a changed definition is a new version)', () => {
    const m = METRICS[0]!;
    expect(definitionHash({ ...m })).toBe(definitionHash(m));
    expect(definitionHash({ ...m, exclusions: [...m.exclusions, 'x'] })).not.toBe(
      definitionHash(m),
    );
    expect(definitionHash({ ...m, accessScope: 'reporting.view_retention' })).not.toBe(
      definitionHash(m),
    );
  });
});

describe('report output (SPK-REPORT-007)', () => {
  const result = (rows: ReportResponse['rows']): ReportResponse => ({
    report: {
      key: 'daily_schedule',
      title: 'Daily schedule',
      requirementIds: ['SPK-REPORT-002'],
      accessAction: 'a.b',
      exportAction: 'a.c',
    },
    runId: null,
    asOf: '2027-02-01T16:00:00.000Z',
    producedAt: '2027-02-01T16:00:00.000Z',
    scope: { facilityId: null, timezone: null, from: null, to: null },
    parameters: { date: '2027-02-03' },
    freshness: { class: 'F1', pointInTime: 'partial', note: 'note' },
    metrics: [],
    disclosures: ['a disclosure'],
    values: [
      {
        metric: 'MET-001',
        label: 'Scheduled',
        value: 2,
        unit: 'count',
        currency: null,
        dimensions: {},
        unavailableReason: null,
      },
    ],
    columns: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'n', label: 'N', type: 'count' },
    ],
    rows,
  });

  it('CSV cells are quoted per RFC 4180 and spreadsheet formulas are neutralized', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it('a CSV export carries the as-of instant, disclosures, the table and the metric values', () => {
    const csv = renderCsv(result([{ title: 'Game, U10', n: 3 }]));
    expect(csv).toContain('# as of: 2027-02-01T16:00:00.000Z');
    expect(csv).toContain('# disclosure: a disclosure');
    expect(csv).toContain('title,n\r\n"Game, U10",3\r\n');
    expect(csv).toContain('MET-001,Scheduled,2,count,,,');
  });

  it('the digest depends on the figures and the as-of instant, not on when or as which run they were produced', () => {
    const a = result([{ title: 'x', n: 1 }]);
    const b = {
      ...a,
      runId: '018f0000-0000-7000-8000-000000000000',
      producedAt: '2027-02-02T00:00:00.000Z',
    };
    expect(resultDigest(b)).toBe(resultDigest(a));
    expect(resultDigest({ ...a, rows: [{ title: 'x', n: 2 }] })).not.toBe(resultDigest(a));
    expect(resultDigest({ ...a, asOf: '2027-02-01T17:00:00.000Z' })).not.toBe(resultDigest(a));
  });
});

describe('report policy helpers', () => {
  it('aging bands by days past due (DEC-007 placeholder bands)', () => {
    const asOf = new Date('2027-02-01T00:00:00Z');
    const days = (n: number) => new Date(asOf.getTime() - n * 86_400_000);
    const edges = [0, 30, 60, 90];
    expect(agingBand(new Date(asOf.getTime() + 1), asOf, edges)).toBe('not_due');
    expect(agingBand(days(0), asOf, edges)).toBe('0-30');
    expect(agingBand(days(30), asOf, edges)).toBe('0-30');
    expect(agingBand(days(31), asOf, edges)).toBe('31-60');
    expect(agingBand(days(90), asOf, edges)).toBe('61-90');
    expect(agingBand(days(91), asOf, edges)).toBe('over_90');
  });

  it('custom weights parse as resourceId:weight and refuse malformed or repeated entries', () => {
    const id = '018f0000-0000-7000-8000-000000000001';
    expect(parseWeights(`${id}:2.5`).get(id)).toBe(2.5);
    expect(() => parseWeights(`${id}:0`)).toThrowError();
    expect(() => parseWeights('not-a-uuid:1')).toThrowError();
    expect(() => parseWeights(`${id}:1,${id}:2`)).toThrowError();
    expect(parseWeights(undefined).size).toBe(0);
  });

  it('a space’s own agreed cost input takes precedence over the facility’s; dates are half-open', () => {
    const inputs = [
      {
        resource_id: null,
        amount_minor: 100,
        currency: 'USD',
        effective_from: '2027-01-01',
        effective_to: '2027-03-01',
      },
      {
        resource_id: 'pitch',
        amount_minor: 200,
        currency: 'USD',
        effective_from: '2027-02-01',
        effective_to: null,
      },
    ];
    expect(costInputFor(inputs, 'pitch', '2027-02-15', 'USD')?.amount_minor).toBe(200);
    expect(costInputFor(inputs, 'pitch', '2027-01-15', 'USD')?.amount_minor).toBe(100);
    expect(costInputFor(inputs, 'room', '2027-03-01', 'USD')).toBeNull();
    expect(costInputFor(inputs, 'room', '2027-02-01', 'EUR')).toBeNull();
  });
});

describe('space status history (SPK-REPORT-003, MET-064)', () => {
  it('a space is closed from a change to closed until the next change to another status', () => {
    const periods = closedPeriods([
      { resourceId: 'a', status: 'closed', at: 10 },
      { resourceId: 'b', status: 'restricted', at: 12 },
      { resourceId: 'a', status: 'closed', at: 15 },
      { resourceId: 'a', status: 'active', at: 20 },
      { resourceId: 'a', status: 'closed', at: 30 },
      { resourceId: 'b', status: 'active', at: 40 },
    ]);
    expect(periods.get('a')).toEqual([
      [10, 20],
      [30, Number.POSITIVE_INFINITY],
    ]);
    expect(periods.has('b')).toBe(false);
  });
});

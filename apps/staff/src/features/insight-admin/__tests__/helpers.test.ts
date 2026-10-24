/**
 * Pure helpers of SCR-S-43 to SCR-S-48: money in integer minor units with its currency
 * (SPK-PAY-001, never mixed across currencies), IANA time zones (SPK-SCHED-008), report parameter
 * building (no allocation method preset, SPK-REPORT-004), staging documents (§5.4) and safe export
 * file names.
 */
import { describe, expect, it } from 'vitest';
import { filenameFrom } from '../download';
import { formatMinor, isValidTimeZone, minorDigits, parseMajorToMinor } from '../format';
import { buildBaseParams } from '../ReportParameters';
import { MAX_ROWS_PER_REQUEST, parseStagingDocument } from '../staging';
import { buildInsightParams } from '../../../screens/reports/InsightReportsScreen';

describe('money in minor units (SPK-PAY-001)', () => {
  it('parses major-unit input by the currency’s minor unit and refuses extra precision', () => {
    expect(parseMajorToMinor('12.5', 'USD')).toBe(1250);
    expect(parseMajorToMinor('12.50', 'USD')).toBe(1250);
    expect(parseMajorToMinor('12.505', 'USD')).toBeNull();
    expect(parseMajorToMinor('-1', 'USD')).toBeNull();
    expect(minorDigits('JPY')).toBe(0);
    expect(parseMajorToMinor('1200', 'JPY')).toBe(1200);
    expect(parseMajorToMinor('12.5', 'JPY')).toBeNull();
    expect(parseMajorToMinor('1', 'NOTACODE')).toBeNull();
  });

  it('formats signed minor units with their currency, and says so when the currency is missing', () => {
    expect(formatMinor(-100, 'USD')).toBe('-$1.00');
    expect(formatMinor(2500, 'EUR')).toBe('€25.00');
    expect(formatMinor(2500, null)).toBe('2,500 (minor units, currency not stated)');
  });
});

describe('time zones (SPK-SCHED-008)', () => {
  it('accepts IANA names only', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Pacific Standard')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('report parameters', () => {
  it('needs a facility and a valid range for facility reports', () => {
    expect(
      buildBaseParams('facility_range', {
        facilityId: '',
        date: '',
        from: '2026-10-02',
        to: '2026-10-01',
      }).errors,
    ).toEqual({
      facilityId: 'Choose a facility.',
      to: 'The last date must not be before the first date.',
    });
  });

  it('sends an organization-wide period as instants from device midnight to the next midnight', () => {
    const built = buildBaseParams('organization_period', {
      facilityId: '',
      date: '',
      from: '2026-10-01',
      to: '2026-10-01',
    });
    const { periodStart, periodEnd } = built.params as { periodStart: string; periodEnd: string };
    expect(new Date(periodEnd).getTime() - new Date(periodStart).getTime()).toBeGreaterThanOrEqual(
      23 * 3_600_000,
    );
    expect(built.params).not.toHaveProperty('facilityId');
  });

  it('SPK-REPORT-004: withholds economics without an explicit allocation method', () => {
    const extras = {
      includeBuffers: '',
      weighting: '',
      weights: '',
      allocationMethod: '',
      includeMargin: true,
      forecastMethod: '',
      forecastPeriods: '',
      cohort: '',
      anchorSeasonId: '',
      comparisonSeasonId: '',
      anchorFrom: '',
      anchorTo: '',
      comparisonFrom: '',
      comparisonTo: '',
      programId: '',
      excludeNotOffered: false,
    } as const;
    const withheld = buildInsightParams('economics', { facilityId: 'f' }, { ...extras });
    expect(withheld.params).toBeNull();
    expect(withheld.withheld).toBe('allocation');
    const chosen = buildInsightParams(
      'economics',
      { facilityId: 'f' },
      { ...extras, allocationMethod: 'pro_rata' },
    );
    expect(chosen.params).toEqual({
      facilityId: 'f',
      allocationMethod: 'pro_rata',
      includeMargin: 'true',
    });
  });
});

describe('staging documents (§5.4)', () => {
  it('requires rows and control totals, and caps one upload at the API’s request limit', () => {
    expect(parseStagingDocument('nope')).toMatch(/not JSON/);
    expect(parseStagingDocument('[]')).toMatch(/JSON object/);
    expect(parseStagingDocument(JSON.stringify({ rows: [{}] }))).toMatch(/controlTotals/);
    expect(parseStagingDocument(JSON.stringify({ rows: [], controlTotals: {} }))).toMatch(
      /no rows/,
    );
    const tooMany = {
      rows: Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, () => ({})),
      controlTotals: {},
    };
    expect(parseStagingDocument(JSON.stringify(tooMany))).toMatch(/chunks/);
    const chunk = parseStagingDocument(JSON.stringify({ rows: [{ entityType: 'person' }] }), {
      requireControlTotals: false,
    });
    expect(typeof chunk).toBe('object');
  });
});

describe('export file names', () => {
  it('keeps only safe characters from Content-Disposition', () => {
    expect(filenameFrom('attachment; filename="daily_schedule-2026.csv"', 'x.csv')).toBe(
      'daily_schedule-2026.csv',
    );
    expect(filenameFrom('attachment; filename="../../etc/passwd"', 'x.csv')).toBe(
      '.._.._etc_passwd',
    );
    expect(filenameFrom(null, 'fallback.json')).toBe('fallback.json');
  });
});

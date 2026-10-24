/**
 * Policy values the specification leaves to operators. Each is the specification's proposal or an
 * engineering placeholder, injected under REPORTING_POLICY so an approved decision replaces it
 * without code changes, and every report discloses the value it used:
 *   - export lifetime: §4.14 requires expiring exports but the period is a retention decision
 *     (DEC-060, Operator/privacy owner; POL-021, POL-047 — "must not be invented by engineering").
 *     The placeholder is deliberately short.
 *   - operating day boundary: local midnight until Operations answers (metric dictionary G4,
 *     DEC-001).
 *   - aging bands of outstanding balances: an engineering proposal; Finance decides (DEC-007
 *     closest row).
 *   - unknown-delivery threshold (MET-062 "configured threshold"): an engineering proposal; the
 *     §5.9 service objectives are DEC-015.
 *   - largest period a report evaluates in one request (bounds the work of one request).
 */
export const REPORTING_POLICY = Symbol('REPORTING_POLICY');

export interface ReportingPolicy {
  /** Hours an export stays downloadable (DEC-060 pending). */
  exportTtlHours: number;
  /** Facility-local operating day boundary, as `HH:MM` (G4: midnight until DEC-001 answers). */
  operatingDayStartsAt: '00:00';
  /** Upper bounds (days past due) of the aging bands; the last band is open-ended. */
  agingBandDays: readonly number[];
  /** A delivery attempt still `unknown` after this many minutes is reported (MET-062). */
  unknownDeliveryThresholdMinutes: number;
  /** Most local days one report request may span. */
  maxPeriodDays: number;
  /** Start-time band width in minutes for demand and schedule dimensions. */
  timeBandMinutes: number;
}

export const DEFAULT_REPORTING_POLICY: ReportingPolicy = {
  exportTtlHours: 24,
  operatingDayStartsAt: '00:00',
  agingBandDays: [0, 30, 60, 90],
  unknownDeliveryThresholdMinutes: 60,
  maxPeriodDays: 366,
  timeBandMinutes: 60,
};

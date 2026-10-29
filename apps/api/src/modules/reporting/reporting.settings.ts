import { z } from '@sportspark/contracts';
import { defineModuleSettings, policySetting, type ModuleSettingsOf } from '../../kernel';

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Upper bounds (days past due) of the aging bands: strictly increasing positive integers separated
 * by commas, for example `30,60,90` → bands 0-30, 31-60, 61-90 and over_90.
 */
const AgingBands = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const parts = value.split(',').map((p) => p.trim());
    const edges = parts.map(Number);
    const valid =
      parts.length > 0 &&
      parts.length <= 12 &&
      edges.every((e, i) => /^\d+$/.test(parts[i]!) && e >= 1 && e <= 3650) &&
      edges.every((e, i) => i === 0 || e > edges[i - 1]!);
    if (!valid) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be 1 to 12 strictly increasing whole numbers of days past due (1 to 3650), separated by commas, for example 30,60,90',
      });
      return z.NEVER;
    }
    return edges;
  });

/**
 * Reporting policy settings (REP-03; K-15, IF-43; rule K-00 (i)). Each is read from
 * `REPORTING_<KEY>` and validated at boot (a malformed value refuses boot). None has a default:
 * each value belongs to an operator decision, and an absent value means the conservative
 * behaviour named on the key. Every report response names the settings it used (`settings`).
 */
export const ReportingSettings = defineModuleSettings('reporting', {
  /**
   * Minutes an export stays downloadable after it is created (§4.14 "expiring exports"; the period
   * is a retention decision, DEC-060, which engineering must not invent). Absent: no export can be
   * created — POST /v1/reports/exports answers VALIDATION_FAILED `EXPORT_LIFETIME_UNCONFIGURED`.
   */
  EXPORT_LIFETIME_MINUTES: policySetting(z.coerce.number().int().min(1).max(527_040)),
  /**
   * Aging bands of outstanding balances (MET-039; Finance decides, DEC-007). Absent: balances are
   * reported as unbanded totals per currency and obligation mode (aging band `unbanded`).
   */
  AGING_BANDS_DAYS: policySetting(AgingBands),
  /**
   * Minutes a delivery attempt may stay `unknown` before the communication-failures report counts
   * it (MET-062 "configured threshold"; service objectives are DEC-015). Absent: every unknown
   * delivery counts as unresolved at once.
   */
  UNKNOWN_DELIVERY_MINUTES: policySetting(z.coerce.number().int().min(0).max(10_080)),
  /**
   * Facility-local wall-clock time (`HH:MM`) at which an operating day starts (metric dictionary
   * G4; DEC-001). Absent: a reported day is the facility-local calendar day, midnight to midnight,
   * and responses say so.
   */
  OPERATING_DAY_START: policySetting(z.string().trim().regex(HH_MM, 'must be HH:MM (00:00-23:59)')),
});
export type ReportingSettingsValue = ModuleSettingsOf<typeof ReportingSettings>;

/** The environment variable of each setting (what responses and errors name). */
export const REPORTING_SETTING_NAMES = {
  exportLifetime: 'REPORTING_EXPORT_LIFETIME_MINUTES',
  agingBands: 'REPORTING_AGING_BANDS_DAYS',
  unknownDelivery: 'REPORTING_UNKNOWN_DELIVERY_MINUTES',
  operatingDayStart: 'REPORTING_OPERATING_DAY_START',
} as const;
export type ReportingSettingName =
  (typeof REPORTING_SETTING_NAMES)[keyof typeof REPORTING_SETTING_NAMES];

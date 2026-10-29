import type { ReportSettingUse } from '@sportspark/contracts';
import {
  REPORTING_SETTING_NAMES,
  type ReportingSettingName,
  type ReportingSettingsValue,
} from './reporting.settings';

/**
 * The values reports and exports run with (REP-03, rule K-00 (i)). Policy values come from the
 * module settings (`reporting.settings.ts`) and have no default: `null` means not configured, and
 * each consumer applies the conservative behaviour named below. Only the two technical bounds are
 * engineering constants.
 *   - export lifetime (§4.14; DEC-060, Operator/privacy owner; POL-021, POL-047 — "must not be
 *     invented by engineering"): null refuses every export (`EXPORT_LIFETIME_UNCONFIGURED`);
 *   - operating day boundary (metric dictionary G4, DEC-001): null is the facility-local calendar
 *     day;
 *   - aging bands of outstanding balances (DEC-007): null reports unbanded totals;
 *   - unknown-delivery threshold (MET-062 "configured threshold"; DEC-015): null counts every
 *     unknown delivery as unresolved at once.
 * Every report response names the settings it used and whether each was configured.
 */
export const REPORTING_POLICY = Symbol('REPORTING_POLICY');

export interface ReportingPolicy {
  /** Minutes an export stays downloadable; null: not configured (DEC-060), exports are refused. */
  exportLifetimeMinutes: number | null;
  /** `HH:MM` local start of an operating day; null: the calendar day (DEC-001). */
  operatingDayStart: string | null;
  /** Upper bounds (days past due) of the aging bands; null: unbanded (DEC-007). */
  agingBandDays: readonly number[] | null;
  /** Minutes before an unknown delivery is reported; null: at once (DEC-015). */
  unknownDeliveryMinutes: number | null;
  /** Technical bound: most local days one report request may span. */
  maxPeriodDays: number;
  /** Technical bound: start-time band width in minutes for demand and schedule dimensions. */
  timeBandMinutes: number;
}

/** Technical bounds (not policy): the work of one request and the width of a time band. */
export const REPORTING_LIMITS = { maxPeriodDays: 366, timeBandMinutes: 60 } as const;

export function reportingPolicyFrom(settings: ReportingSettingsValue): ReportingPolicy {
  return {
    exportLifetimeMinutes: settings.EXPORT_LIFETIME_MINUTES ?? null,
    operatingDayStart: settings.OPERATING_DAY_START ?? null,
    agingBandDays: settings.AGING_BANDS_DAYS ?? null,
    unknownDeliveryMinutes: settings.UNKNOWN_DELIVERY_MINUTES ?? null,
    ...REPORTING_LIMITS,
  };
}

/** The operating day boundary to compute with (`00:00` when not configured). */
export function dayStartOf(policy: ReportingPolicy): string {
  return policy.operatingDayStart ?? '00:00';
}

/** What a report response says about one setting it used (`ReportResponse.settings`). */
export function settingUse(
  policy: ReportingPolicy,
  setting: ReportingSettingName,
): ReportSettingUse {
  switch (setting) {
    case REPORTING_SETTING_NAMES.operatingDayStart:
      return policy.operatingDayStart === null
        ? {
            setting,
            configured: false,
            value: null,
            pendingDecision: 'DEC-001',
            effect:
              'Not configured: a reported day is the facility-local calendar day, from local midnight to midnight.',
          }
        : {
            setting,
            configured: true,
            value: policy.operatingDayStart,
            pendingDecision: 'DEC-001',
            effect: `A reported day runs from ${policy.operatingDayStart} local time to ${policy.operatingDayStart} the next day.`,
          };
    case REPORTING_SETTING_NAMES.agingBands:
      return policy.agingBandDays === null
        ? {
            setting,
            configured: false,
            value: null,
            pendingDecision: 'DEC-007',
            effect:
              'Not configured: outstanding balances are unbanded totals per currency and obligation mode.',
          }
        : {
            setting,
            configured: true,
            value: policy.agingBandDays.join(','),
            pendingDecision: 'DEC-007',
            effect: `Balances are banded at ${policy.agingBandDays.join(', ')} days past due; the last band is open-ended.`,
          };
    case REPORTING_SETTING_NAMES.unknownDelivery:
      return policy.unknownDeliveryMinutes === null
        ? {
            setting,
            configured: false,
            value: null,
            pendingDecision: 'DEC-015',
            effect: 'Not configured: every unknown delivery counts as unresolved at once.',
          }
        : {
            setting,
            configured: true,
            value: String(policy.unknownDeliveryMinutes),
            pendingDecision: 'DEC-015',
            effect: `An unknown delivery counts as unresolved after ${policy.unknownDeliveryMinutes} minutes.`,
          };
    case REPORTING_SETTING_NAMES.exportLifetime:
      return policy.exportLifetimeMinutes === null
        ? {
            setting,
            configured: false,
            value: null,
            pendingDecision: 'DEC-060',
            effect: 'Not configured: no export can be created.',
          }
        : {
            setting,
            configured: true,
            value: String(policy.exportLifetimeMinutes),
            pendingDecision: 'DEC-060',
            effect: `An export stays downloadable for ${policy.exportLifetimeMinutes} minutes.`,
          };
  }
}

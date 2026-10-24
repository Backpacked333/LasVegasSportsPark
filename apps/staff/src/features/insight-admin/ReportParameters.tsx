/**
 * Report parameters shared by SCR-S-43 and SCR-S-44 (SPK-REPORT-001 time basis and scope): the
 * facility (from the principal's scope, §4.3), the operating date or date range in the facility's
 * local dates (SPK-SCHED-008), or an organization-wide period entered in the device's time zone and
 * sent as instants. Client checks give early feedback (SPK-UX-008 validation failure); the API's
 * own validation is the guarantee and its field messages are shown with the result.
 */
import { useApp, useNow } from '../../providers/AppProviders';
import { deviceMidnight, deviceTimeZone, localDateOf } from './format';
import type { FacilityChoice } from './facilities';
import { SelectField, TextField } from './fields';
import type { ReportParameterShape } from './labels';
import type { ReportParams } from './ReportPanel';

export interface BaseParamsState {
  facilityId: string;
  date: string;
  from: string;
  to: string;
}

export type FieldErrors = Record<string, string>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Initial values: the selected facility (or the first in scope) and its local date today. */
export function useInitialBaseParams(choices: readonly FacilityChoice[]): BaseParamsState {
  const { facilityId } = useApp();
  const now = useNow();
  const facility = choices.find((c) => c.id === facilityId) ?? choices[0];
  const date = facility?.localDate ?? localDateOf(now, facility?.timezone);
  return { facilityId: facility?.id ?? '', date, from: date, to: date };
}

export function needsFacility(shape: ReportParameterShape): boolean {
  return shape === 'facility_date' || shape === 'facility_range' || shape === 'facility_only';
}

/** Validates the base fields of a shape and builds the query; errors are keyed by field name. */
export function buildBaseParams(
  shape: ReportParameterShape,
  state: BaseParamsState,
): { params: ReportParams | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const params: ReportParams = {};
  if (needsFacility(shape)) {
    if (!state.facilityId) errors.facilityId = 'Choose a facility.';
    else params.facilityId = state.facilityId;
  }
  if (shape === 'facility_date') {
    if (!DATE.test(state.date)) errors.date = 'Enter a date.';
    else params.date = state.date;
  }
  if (shape === 'facility_range' || shape === 'organization_period') {
    if (!DATE.test(state.from)) errors.from = 'Enter the first date.';
    if (!DATE.test(state.to)) errors.to = 'Enter the last date.';
    if (DATE.test(state.from) && DATE.test(state.to) && state.to < state.from) {
      errors.to = 'The last date must not be before the first date.';
    }
  }
  if (shape === 'facility_range' && !errors.from && !errors.to) {
    params.from = state.from;
    params.to = state.to;
  }
  if (shape === 'organization_period' && !errors.from && !errors.to) {
    const start = deviceMidnight(state.from);
    const end = deviceMidnight(state.to, 1);
    if (start && end) {
      params.periodStart = start;
      params.periodEnd = end;
    }
  }
  return { params: Object.keys(errors).length > 0 ? null : params, errors };
}

export function BaseParameterFields({
  shape,
  state,
  onChange,
  errors,
  choices,
  facilitiesLoading,
}: {
  shape: ReportParameterShape;
  state: BaseParamsState;
  onChange: (next: BaseParamsState) => void;
  errors: FieldErrors;
  choices: readonly FacilityChoice[];
  facilitiesLoading?: boolean;
}) {
  const set = (patch: Partial<BaseParamsState>) => onChange({ ...state, ...patch });
  const facility = choices.find((c) => c.id === state.facilityId);
  const zoneHint = facility?.timezone
    ? `Local dates of the facility (time zone ${facility.timezone}).`
    : 'Local dates of the facility.';
  return (
    <>
      {needsFacility(shape) ? (
        <SelectField
          label="Facility"
          required
          value={state.facilityId}
          onChange={(facilityId) => set({ facilityId })}
          options={choices.map((c) => ({ value: c.id, label: c.label }))}
          placeholder={facilitiesLoading ? 'Loading facilities…' : 'Choose a facility'}
          error={errors.facilityId}
        />
      ) : (
        <p className="caption">
          Organization-wide report: it needs organization-wide access, and the API refuses it to
          staff scoped to particular facilities.
        </p>
      )}
      {shape === 'facility_date' ? (
        <TextField
          label="Date"
          type="date"
          required
          value={state.date}
          onChange={(date) => set({ date })}
          hint={zoneHint}
          error={errors.date}
        />
      ) : null}
      {shape === 'facility_range' || shape === 'organization_period' ? (
        <>
          <TextField
            label="First date"
            type="date"
            required
            value={state.from}
            onChange={(from) => set({ from })}
            hint={
              shape === 'organization_period'
                ? `From midnight in your time zone (${deviceTimeZone()}).`
                : zoneHint
            }
            error={errors.from}
          />
          <TextField
            label="Last date"
            type="date"
            required
            value={state.to}
            onChange={(to) => set({ to })}
            hint={
              shape === 'organization_period'
                ? `Up to the end of this day in your time zone (${deviceTimeZone()}).`
                : 'Included in the period.'
            }
            error={errors.to}
          />
        </>
      ) : null}
    </>
  );
}

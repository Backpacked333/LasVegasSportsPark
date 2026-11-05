/**
 * SCR-S-44 Utilization, economics, demand and retention (SPK-REPORT-003, SPK-REPORT-004,
 * SPK-REPORT-005, SPK-REPORT-006, DEC-045; SPK-UX-008, SPK-UX-009).
 *
 * - Utilization: reserved, available, observed and closed hours apart, counted per conflict unit so
 *   a whole field and its subdivisions are never added twice; the resource-equivalent weighting is
 *   disclosed in the result. No weighting or buffer rule is preset here: "report default" leaves
 *   the API's documented default in force and the disclosures name it.
 * - Economics: no per-field-hour figure until an allocation method is chosen explicitly (none is
 *   preselected; which method Finance agrees is DEC-085); margin only with agreed cost inputs.
 * - Demand: observed demand and any forecast are separate series; the forecast method is named.
 * - Retention: one of the five SPK-REPORT-005 cohorts per request; households and returning
 *   participants are different metrics. Rental customers (REP-02) are the bookers of confirmed or
 *   completed rentals and parties, read whether or not those capabilities are turned on; "not
 *   offered" is not computed for them (DEC-076, DEC-077 pending), so that option is not offered.
 *   A program applies to youth participants only.
 * No improvement target is shown or invented (DEC-045).
 */
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { ReportsNav } from '../../features/insight-admin/nav';
import { useFacilityChoices } from '../../features/insight-admin/facilities';
import { PendingNote } from '../../features/insight-admin/feedback';
import {
  CheckboxField,
  RadioGroup,
  SelectField,
  TextField,
} from '../../features/insight-admin/fields';
import { UUID_PATTERN } from '../../features/insight-admin/format';
import {
  DECISIONS,
  INSIGHT_REPORTS,
  type ReportCatalogEntry,
} from '../../features/insight-admin/labels';
import { ReportPanel, type ReportParams } from '../../features/insight-admin/ReportPanel';
import {
  BaseParameterFields,
  buildBaseParams,
  useInitialBaseParams,
  type BaseParamsState,
  type FieldErrors,
} from '../../features/insight-admin/ReportParameters';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { CostInputsPanel } from './CostInputsPanel';

interface Extras {
  includeBuffers: '' | 'true' | 'false';
  weighting: '' | 'conflict_units' | 'custom';
  weights: string;
  allocationMethod: '' | 'direct' | 'pro_rata';
  includeMargin: boolean;
  forecastMethod: '' | 'none' | 'trailing_mean';
  forecastPeriods: string;
  cohort: string;
  anchorSeasonId: string;
  comparisonSeasonId: string;
  anchorFrom: string;
  anchorTo: string;
  comparisonFrom: string;
  comparisonTo: string;
  programId: string;
  excludeNotOffered: boolean;
}

const EMPTY_EXTRAS: Extras = {
  includeBuffers: '',
  weighting: '',
  weights: '',
  allocationMethod: '',
  includeMargin: false,
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
};

const COHORTS = [
  { value: 'adult_teams', label: 'Adult teams' },
  { value: 'individual_players', label: 'Individual players' },
  { value: 'youth_participants', label: 'Youth participants' },
  { value: 'households', label: 'Households (purchases)' },
  { value: 'rental_customers', label: 'Rental customers' },
] as const;

const SEASON_COHORTS = new Set(['adult_teams', 'individual_players']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Adds the report-specific parameters; every choice is explicit or left to the API's default. */
export function buildInsightParams(
  key: string,
  base: ReportParams,
  extras: Extras,
): { params: ReportParams | null; errors: FieldErrors; withheld?: string } {
  const errors: FieldErrors = {};
  const params: ReportParams = { ...base };
  if (key === 'utilization') {
    if (extras.includeBuffers) params.includeBuffers = extras.includeBuffers;
    if (extras.weighting) params.weighting = extras.weighting;
    if (extras.weighting === 'custom') {
      if (!/^[^:,\s]+:\d+(\.\d+)?(,[^:,\s]+:\d+(\.\d+)?)*$/.test(extras.weights.trim())) {
        errors.weights = 'Enter space id and weight pairs, for example id1:1,id2:0.5.';
      } else params.weights = extras.weights.trim();
    }
  }
  if (key === 'economics') {
    if (!extras.allocationMethod) {
      return {
        params: null,
        errors: { allocationMethod: 'Choose an allocation method to show per-hour figures.' },
        withheld: 'allocation',
      };
    }
    params.allocationMethod = extras.allocationMethod;
    if (extras.includeMargin) params.includeMargin = 'true';
  }
  if (key === 'demand') {
    if (extras.forecastMethod) params.forecastMethod = extras.forecastMethod;
    if (extras.forecastMethod === 'trailing_mean' && extras.forecastPeriods) {
      const n = Number(extras.forecastPeriods);
      if (!Number.isInteger(n) || n < 1 || n > 12) {
        errors.forecastPeriods = 'Enter a whole number from 1 to 12.';
      } else params.forecastPeriods = n;
    }
  }
  if (key === 'retention') {
    if (!extras.cohort) errors.cohort = 'Choose a cohort.';
    else params.cohort = extras.cohort;
    if (SEASON_COHORTS.has(extras.cohort)) {
      if (!UUID_PATTERN.test(extras.anchorSeasonId.trim())) {
        errors.anchorSeasonId = 'Enter the anchor season id.';
      } else params.anchorSeasonId = extras.anchorSeasonId.trim();
      if (!UUID_PATTERN.test(extras.comparisonSeasonId.trim())) {
        errors.comparisonSeasonId = 'Enter the comparison season id.';
      } else params.comparisonSeasonId = extras.comparisonSeasonId.trim();
    } else if (extras.cohort) {
      for (const field of ['anchorFrom', 'anchorTo', 'comparisonFrom', 'comparisonTo'] as const) {
        if (!DATE.test(extras[field])) errors[field] = 'Enter a date.';
        else params[field] = extras[field];
      }
      if (extras.cohort === 'youth_participants' && extras.programId) {
        if (!UUID_PATTERN.test(extras.programId.trim())) errors.programId = 'Enter a program id.';
        else params.programId = extras.programId.trim();
      }
    }
    if (extras.excludeNotOffered && extras.cohort !== 'rental_customers') {
      params.excludeNotOffered = 'true';
    }
  }
  return { params: Object.keys(errors).length > 0 ? null : params, errors };
}

function ExtraFields({
  entry,
  extras,
  set,
  errors,
}: {
  entry: ReportCatalogEntry;
  extras: Extras;
  set: (patch: Partial<Extras>) => void;
  errors: FieldErrors;
}) {
  switch (entry.key) {
    case 'utilization':
      return (
        <>
          <SelectField
            label="Setup and cleanup buffers"
            value={extras.includeBuffers}
            onChange={(v) => set({ includeBuffers: v as Extras['includeBuffers'] })}
            placeholder="Report default (named in the disclosures)"
            options={[
              { value: 'true', label: 'Count buffers as reserved time' },
              { value: 'false', label: 'Leave buffers out of reserved time' },
            ]}
          />
          <SelectField
            label="Resource-equivalent weighting"
            value={extras.weighting}
            onChange={(v) => set({ weighting: v as Extras['weighting'] })}
            placeholder="Report default (named in the disclosures)"
            options={[
              { value: 'conflict_units', label: 'By conflict units' },
              { value: 'custom', label: 'Custom weights per space' },
            ]}
            hint="The weighting used is always disclosed with the result (SPK-REPORT-003)."
          />
          {extras.weighting === 'custom' ? (
            <TextField
              label="Weights"
              required
              value={extras.weights}
              onChange={(weights) => set({ weights })}
              hint="Space id and weight pairs separated by commas; whole spaces only."
              error={errors.weights}
            />
          ) : null}
        </>
      );
    case 'economics':
      return (
        <>
          <RadioGroup
            legend="Allocation method"
            name="allocation"
            required
            value={extras.allocationMethod}
            onChange={(v) => set({ allocationMethod: v as Extras['allocationMethod'] })}
            options={[
              {
                value: 'direct',
                label: 'Direct',
                description: 'a sale for one event or rental goes wholly to that event’s hours',
              },
              {
                value: 'pro_rata',
                label: 'Pro rata',
                description:
                  'a season or term fee is spread over its scheduled events by activity minutes',
              },
            ]}
            error={errors.allocationMethod}
            hint="No method is preselected: per-hour figures appear only under the method you name (SPK-REPORT-004)."
          />
          <PendingNote
            decisions={DECISIONS.allocationMethod.ids}
            owner={DECISIONS.allocationMethod.owner}
          >
            Which allocation method is agreed for reporting, and the cost inputs behind any margin,
            are not decided yet; the method names come from the proposed metric dictionary (E1).
          </PendingNote>
          <CheckboxField
            label="Include contribution margin"
            checked={extras.includeMargin}
            onChange={(includeMargin) => set({ includeMargin })}
            hint="Shown only when agreed cost inputs cover every space and event day."
          />
        </>
      );
    case 'demand':
      return (
        <>
          <SelectField
            label="Forecast"
            value={extras.forecastMethod}
            onChange={(v) => set({ forecastMethod: v as Extras['forecastMethod'] })}
            placeholder="No forecast (observed demand only)"
            options={[
              { value: 'none', label: 'No forecast' },
              {
                value: 'trailing_mean',
                label: 'Trailing mean (an engineering baseline, not an approved forecast)',
              },
            ]}
            hint="A forecast is a separate series and is never combined with observed demand (SPK-REPORT-006)."
          />
          {extras.forecastMethod === 'trailing_mean' ? (
            <TextField
              label="Preceding periods for the forecast"
              type="number"
              inputMode="numeric"
              value={extras.forecastPeriods}
              onChange={(forecastPeriods) => set({ forecastPeriods })}
              hint="From 1 to 12; leave empty for the report default, named in the disclosures."
              error={errors.forecastPeriods}
            />
          ) : null}
        </>
      );
    case 'retention':
      return (
        <>
          <SelectField
            label="Cohort"
            required
            value={extras.cohort}
            onChange={(cohort) => set({ cohort })}
            placeholder="Choose a cohort"
            options={COHORTS}
            hint="A household purchase and a returning individual participant are different metrics (SPK-REPORT-005)."
            error={errors.cohort}
          />
          {SEASON_COHORTS.has(extras.cohort) ? (
            <>
              <TextField
                label="Anchor season id"
                required
                value={extras.anchorSeasonId}
                onChange={(anchorSeasonId) => set({ anchorSeasonId })}
                error={errors.anchorSeasonId}
              />
              <TextField
                label="Comparison season id"
                required
                value={extras.comparisonSeasonId}
                onChange={(comparisonSeasonId) => set({ comparisonSeasonId })}
                hint="The comparable next season."
                error={errors.comparisonSeasonId}
              />
            </>
          ) : extras.cohort ? (
            <>
              <TextField
                label="Anchor period first date"
                type="date"
                required
                value={extras.anchorFrom}
                onChange={(anchorFrom) => set({ anchorFrom })}
                error={errors.anchorFrom}
              />
              <TextField
                label="Anchor period last date"
                type="date"
                required
                value={extras.anchorTo}
                onChange={(anchorTo) => set({ anchorTo })}
                error={errors.anchorTo}
              />
              <TextField
                label="Comparison period first date"
                type="date"
                required
                value={extras.comparisonFrom}
                onChange={(comparisonFrom) => set({ comparisonFrom })}
                error={errors.comparisonFrom}
              />
              <TextField
                label="Comparison period last date"
                type="date"
                required
                value={extras.comparisonTo}
                onChange={(comparisonTo) => set({ comparisonTo })}
                error={errors.comparisonTo}
              />
              {extras.cohort === 'youth_participants' ? (
                <TextField
                  label="Program id"
                  value={extras.programId}
                  onChange={(programId) => set({ programId })}
                  hint="Optional: one program only."
                  error={errors.programId}
                />
              ) : null}
            </>
          ) : null}
          {extras.cohort === 'rental_customers' ? (
            <PendingNote
              decisions={DECISIONS.rentalApplicability.ids}
              owner={DECISIONS.rentalApplicability.owner}
            >
              Rental customers are the bookers of confirmed or completed rentals and parties in each
              period, counted whether or not rentals and parties are turned on. Whether a customer
              could not return (not offered) is not computed for them.
            </PendingNote>
          ) : (
            <CheckboxField
              label="Leave out members who could not return"
              checked={extras.excludeNotOffered}
              onChange={(excludeNotOffered) => set({ excludeNotOffered })}
              hint="They are always counted separately; this only removes them from the denominator."
            />
          )}
        </>
      );
    default:
      return null;
  }
}

export function InsightReportsScreen() {
  const [search, setSearch] = useSearchParams();
  const requested = search.get('report');
  const entry: ReportCatalogEntry =
    INSIGHT_REPORTS.find((e) => e.key === requested) ?? (INSIGHT_REPORTS[0] as ReportCatalogEntry);
  const { choices, loading, error: facilitiesError, refetch } = useFacilityChoices();
  const initial = useInitialBaseParams(choices);
  const [edited, setEdited] = useState<BaseParamsState | null>(null);
  const base = edited ?? initial;
  const [extras, setExtras] = useState<Extras>(EMPTY_EXTRAS);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [withheld, setWithheld] = useState(false);
  const [submitted, setSubmitted] = useState<{ key: string; params: ReportParams } | null>(null);

  const chooseReport = (key: string) => {
    setSubmitted(null);
    setErrors({});
    setWithheld(false);
    setSearch({ report: key }, { replace: true });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const builtBase = buildBaseParams(entry.shape, base);
    const builtExtras = buildInsightParams(entry.key, builtBase.params ?? {}, extras);
    const allErrors = { ...builtBase.errors, ...builtExtras.errors };
    setErrors(allErrors);
    setWithheld(builtExtras.withheld === 'allocation');
    setSubmitted(
      builtBase.params && builtExtras.params && Object.keys(allErrors).length === 0
        ? { key: entry.key, params: builtExtras.params }
        : null,
    );
  };

  const params = submitted && submitted.key === entry.key ? submitted.params : null;
  const facilityName =
    typeof params?.facilityId === 'string'
      ? (choices.find((c) => c.id === params.facilityId)?.label ?? null)
      : null;

  return (
    <section aria-labelledby="insight-reports-title" className="ia-screen">
      <h2 id="insight-reports-title">Utilization, economics, demand and retention</h2>
      <ReportsNav />
      <PendingNote
        decisions={DECISIONS.benchmarkTargets.ids}
        owner={DECISIONS.benchmarkTargets.owner}
      >
        No improvement target or benchmark is shown beside these figures.
      </PendingNote>
      <form className="ia-form" onSubmit={onSubmit} aria-label="Report parameters" noValidate>
        <SelectField
          label="Report"
          required
          value={entry.key}
          onChange={chooseReport}
          options={INSIGHT_REPORTS.map((e) => ({
            value: e.key,
            label: `${e.title} (${e.requirement})`,
          }))}
        />
        <BaseParameterFields
          shape={entry.shape}
          state={base}
          onChange={setEdited}
          errors={errors}
          choices={choices}
          facilitiesLoading={loading}
          facilitiesError={facilitiesError}
          onRetryFacilities={refetch}
        />
        <ExtraFields
          entry={entry}
          extras={extras}
          set={(patch) => setExtras((e) => ({ ...e, ...patch }))}
          errors={errors}
        />
        <div>
          <Button type="submit">Show report</Button>
        </div>
      </form>
      {withheld && entry.key === 'economics' ? (
        <p className="ia-withheld" role="status" data-testid="allocation-withheld">
          <StatusBadge tone="warning" label="Per-hour figures withheld" /> Revenue per field hour is
          shown only under an explicit allocation method (SPK-REPORT-004). Choose one above.
        </p>
      ) : null}
      <ReportPanel
        key={`${entry.key}:${JSON.stringify(params)}`}
        entry={entry}
        params={params}
        facilityName={facilityName}
      />
      {entry.key === 'economics' && base.facilityId ? (
        <CostInputsPanel facilityId={base.facilityId} />
      ) : null}
    </section>
  );
}

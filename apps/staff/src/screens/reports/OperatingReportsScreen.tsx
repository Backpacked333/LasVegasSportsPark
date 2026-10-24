/**
 * SCR-S-43 Operating reports (SPK-REPORT-001, SPK-REPORT-002; SPK-UX-005, SPK-UX-008, SPK-UX-009).
 * The SPK-REPORT-002 set: daily schedule, expected arrivals, attendance, match readiness, uncovered
 * assignments, waitlist demand, registration funnel, enrollment and roster completeness,
 * outstanding obligations, payment and refund reconciliation, maintenance restrictions and
 * communication failures, each metric with its SPK-REPORT-001 definition visible before and after
 * the report runs. The API evaluates the report and decides who may see it (an organization-wide
 * report is refused to facility-scoped staff); this screen renders what it answers.
 */
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { ReportsNav } from '../../features/insight-admin/nav';
import { useFacilityChoices } from '../../features/insight-admin/facilities';
import { SelectField } from '../../features/insight-admin/fields';
import { OPERATING_REPORTS, type ReportCatalogEntry } from '../../features/insight-admin/labels';
import { ReportPanel, type ReportParams } from '../../features/insight-admin/ReportPanel';
import {
  BaseParameterFields,
  buildBaseParams,
  useInitialBaseParams,
  type BaseParamsState,
  type FieldErrors,
} from '../../features/insight-admin/ReportParameters';
import { Button } from '../../ui/Button';

export function OperatingReportsScreen() {
  const [search, setSearch] = useSearchParams();
  const requested = search.get('report');
  const entry: ReportCatalogEntry =
    OPERATING_REPORTS.find((e) => e.key === requested) ??
    (OPERATING_REPORTS[0] as ReportCatalogEntry);
  const { choices, loading, error: facilitiesError, refetch } = useFacilityChoices();
  const initial = useInitialBaseParams(choices);
  const [edited, setEdited] = useState<BaseParamsState | null>(null);
  const state = edited ?? initial;
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState<{ key: string; params: ReportParams } | null>(null);

  const chooseReport = (key: string) => {
    setSubmitted(null);
    setErrors({});
    setSearch({ report: key }, { replace: true });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const built = buildBaseParams(entry.shape, state);
    setErrors(built.errors);
    setSubmitted(built.params ? { key: entry.key, params: built.params } : null);
  };

  const params = submitted && submitted.key === entry.key ? submitted.params : null;
  const facilityName =
    typeof params?.facilityId === 'string'
      ? (choices.find((c) => c.id === params.facilityId)?.label ?? null)
      : null;

  return (
    <section aria-labelledby="operating-reports-title" className="ia-screen">
      <h2 id="operating-reports-title">Operating reports</h2>
      <ReportsNav />
      <form className="ia-form" onSubmit={onSubmit} aria-label="Report parameters" noValidate>
        <SelectField
          label="Report"
          required
          value={entry.key}
          onChange={chooseReport}
          options={OPERATING_REPORTS.map((e) => ({ value: e.key, label: e.title }))}
          hint="The SPK-REPORT-002 operating reports. Each lists its metric definitions below."
        />
        <BaseParameterFields
          shape={entry.shape}
          state={state}
          onChange={setEdited}
          errors={errors}
          choices={choices}
          facilitiesLoading={loading}
          facilitiesError={facilitiesError}
          onRetryFacilities={refetch}
        />
        <div>
          <Button type="submit">Show report</Button>
        </div>
      </form>
      <ReportPanel
        key={`${entry.key}:${JSON.stringify(params)}`}
        entry={entry}
        params={params}
        facilityName={facilityName}
      />
    </section>
  );
}

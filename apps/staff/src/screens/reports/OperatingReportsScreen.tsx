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
import { Link, useSearchParams } from 'react-router';
import { ReportsNav } from '../../features/insight-admin/nav';
import { useFacilityChoices } from '../../features/insight-admin/facilities';
import { SelectField } from '../../features/insight-admin/fields';
import {
  OPERATING_REPORTS,
  reportTitle,
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
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant } from '../../features/insight-admin/format';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';

import { PageHeader } from '../../ui/Page';
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
      <PageHeader
        eyebrow="Business · Reports"
        title="Operating reports"
        titleId="operating-reports-title"
      />
      <ReportsNav />
      <div className="ia-reports-layout">
        <div className="ia-reports-main">
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
        </div>
        <div className="ia-reports-side">
          <section className="card ia-catalog" aria-labelledby="report-catalog-title">
            <h3 id="report-catalog-title">Report catalog</h3>
            <ul>
              {OPERATING_REPORTS.map((e) => (
                <li key={e.key}>
                  <button
                    type="button"
                    aria-current={e.key === entry.key ? 'true' : undefined}
                    onClick={() => chooseReport(e.key)}
                  >
                    <Icon name={REPORT_ICON[e.key] ?? 'bar_chart'} size={18} />
                    {e.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <SavedRuns />
        </div>
      </div>
    </section>
  );
}

/** Report icons in the catalog (decorative; the title is always written). */
const REPORT_ICON: Record<string, IconName> = {
  daily_schedule: 'calendar_month',
  expected_arrivals: 'how_to_reg',
  attendance: 'checklist',
  match_readiness: 'sports_soccer',
  uncovered_assignments: 'person_off',
  waitlist_demand: 'hourglass_empty',
  registration_funnel: 'filter_list',
  enrollment_completeness: 'task_alt',
  outstanding_obligations: 'receipt_long',
  payment_reconciliation: 'balance',
  maintenance_restrictions: 'construction',
  communication_failures: 'sms',
};

/** The latest stored runs (`GET /v1/reports/runs`): saved reports, only when runs exist. */
function SavedRuns() {
  const runs = useApiQuery({ path: '/reports/runs', request: { query: { limit: 5 } } });
  return (
    <section className="card ia-saved" aria-labelledby="saved-runs-title">
      <div className="card-head">
        <h3 id="saved-runs-title">Saved reports</h3>
        <Link to="/reports/exports">All stored runs</Link>
      </div>
      <div className="ia-saved-body">
        <QueryBoundary
          query={runs}
          label="stored report runs"
          isEmpty={(data) => data.items.length === 0}
          empty={{
            title: 'No stored runs yet',
            description: 'A report you store is kept with its parameters and can be reproduced.',
          }}
        >
          {(data) => (
            <ul className="ia-saved-list" aria-label="Latest stored runs">
              {data.items.map((run) => (
                <li key={run.id}>
                  <Icon name={REPORT_ICON[run.reportKey] ?? 'bar_chart'} size={19} />
                  <span className="row-text">
                    <Link to={`/reports/runs/${run.id}`} className="row-title">
                      {reportTitle(run.reportKey)}
                    </Link>
                    <span className="caption">
                      As of {formatInstant(run.asOf)} · {run.rowCount} row
                      {run.rowCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <Icon name="chevron_right" size={19} />
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

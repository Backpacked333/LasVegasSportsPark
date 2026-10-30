/**
 * SCR-S-01 expected arrivals for one facility's day (SPK-UX-006, SPK-REPORT-002, SPK-ENTRY-004,
 * SPK-ENTRY-007) from the reporting module's `GET /v1/reports/expected-arrivals?facilityId&date`
 * (the facility-local date of the Today feed). Counts only: the report never names a participant
 * (§4.14, metric dictionary rule G9), and neither does this panel.
 *
 * - Totals are the report's metric values; a value the API reports as unavailable shows its
 *   reason, never zero (rule G13).
 * - Each activity shows the API's facility-local start (SPK-SCHED-008), the expected count, adults
 *   and children, the basis (enrollment, session booking, roster) and supervised releases expected,
 *   and whether it has started (text, never colour alone).
 * - "As of" is the report's own evaluation instant; the report's disclosures are listed.
 * - Viewers whose roles do not hold `reporting.view_operations_reports` here see "not available to
 *   you" without a request (GET /v1/me/permissions); an ACCESS_DENIED answer reads the same.
 */
import type { Schema } from '@sportspark/api-client';
import { usePermissions } from '../../api/permissions';
import { useApiQuery } from '../../api/useApiQuery';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';

type ReportResponse = Schema<'ReportResponse'>;
type ReportRow = ReportResponse['rows'][number];
type MetricValue = ReportResponse['values'][number];

export const EXPECTED_ARRIVALS_ACTION = 'reporting.view_operations_reports';

type Cell = ReportRow[string] | undefined;

function num(value: Cell): number {
  return typeof value === 'number' ? value : 0;
}

function text(value: Cell): string | null {
  return typeof value === 'string' ? value : null;
}

function MetricLine({ value }: { value: MetricValue }) {
  if (value.value === null) {
    return (
      <li>
        {value.label}: not available
        {value.unavailableReason ? ` (${value.unavailableReason})` : ''}
      </li>
    );
  }
  return (
    <li>
      {value.label}: {value.value}
    </li>
  );
}

function ArrivalRow({ row, now }: { row: ReportRow; now: Date }) {
  const start = text(row['start']);
  const started = start !== null && new Date(start).getTime() <= now.getTime();
  const supervised = num(row['supervisedReleasesExpected']);
  const title = text(row['title']) ?? text(row['activityType']) ?? 'Activity';
  return (
    <li>
      <div className="row-text">
        <span className="row-title">{title}</span>
        <span className="caption">
          {text(row['localStart']) ?? 'Start not stated'} · {text(row['activityType']) ?? ''}
        </span>
        <span className="caption">
          Expected {num(row['expected'])}: {num(row['adults'])} adults, {num(row['children'])}{' '}
          children · by enrollment {num(row['byEnrollment'])}, by session booking{' '}
          {num(row['byBooking'])}, by roster {num(row['byRoster'])}
          {supervised > 0 ? ` · supervised releases expected ${supervised}` : ''}
        </span>
      </div>
      <StatusBadge tone={started ? 'info' : 'neutral'} label={started ? 'Started' : 'Upcoming'} />
    </li>
  );
}

function ArrivalsReport({
  facilityId,
  facilityName,
  timezone,
  localDate,
  now,
}: {
  facilityId: string;
  facilityName: string;
  timezone: string;
  localDate: string;
  now: Date;
}) {
  const report = useApiQuery({
    path: '/reports/expected-arrivals',
    request: { query: { facilityId, date: localDate } },
  });
  return (
    <QueryBoundary
      query={report}
      label="expected arrivals"
      empty={{ title: '', description: '' }}
      unavailableOffline={[]}
    >
      {(data) => {
        const rows = [...data.rows].sort((a, b) =>
          (text(a['start']) ?? '').localeCompare(text(b['start']) ?? ''),
        );
        return (
          <>
            <p className="caption">Counted as of {formatDateTime(data.asOf, timezone)}.</p>
            <ul className="caption" aria-label={`Expected arrivals totals, ${facilityName}`}>
              {data.values.map((v, i) => (
                <MetricLine key={`${v.metric}-${i}`} value={v} />
              ))}
            </ul>
            {rows.length === 0 ? (
              <p>No expected arrivals are listed for today at this facility.</p>
            ) : (
              <ul className="list" aria-label={`Expected arrivals by activity, ${facilityName}`}>
                {rows.map((row, i) => (
                  <ArrivalRow key={text(row['activityId']) ?? String(i)} row={row} now={now} />
                ))}
              </ul>
            )}
            {data.disclosures.length > 0 ? (
              <details>
                <summary>How these are counted</summary>
                <ul className="caption">
                  {data.disclosures.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        );
      }}
    </QueryBoundary>
  );
}

export function ExpectedArrivals({
  facilityId,
  facilityName,
  timezone,
  localDate,
  now,
}: {
  facilityId: string;
  facilityName: string;
  timezone: string;
  localDate: string;
  now: Date;
}) {
  const permissions = usePermissions();
  const permitted = permissions.isPermitted(EXPECTED_ARRIVALS_ACTION, facilityId);
  // While the permissions read is on its way, wait for it; if it cannot answer (failed, offline)
  // the report is asked for and the API decides.
  const waiting =
    permitted === undefined &&
    permissions.query.error === null &&
    permissions.query.fetchStatus === 'fetching';
  const headingId = `arrivals-${facilityId}`;
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId}>Expected arrivals</h4>
      {permitted === false ? (
        <StateView
          variant="unavailable"
          title="Not available to you"
          description="Expected arrivals at this facility are not available to your role."
        />
      ) : waiting ? (
        <StateView variant="loading" label="expected arrivals" />
      ) : (
        <ArrivalsReport
          facilityId={facilityId}
          facilityName={facilityName}
          timezone={timezone}
          localDate={localDate}
          now={now}
        />
      )}
    </section>
  );
}

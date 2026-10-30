/**
 * Renders one report envelope (`ReportResponse`) for SCR-S-43, SCR-S-44 and the stored runs of
 * SCR-S-45: SPK-REPORT-001 (every metric's definition visible: business question, grain, numerator
 * and denominator, time basis, exclusions, dimensions, currency, freshness, access scope),
 * SPK-REPORT-002 to SPK-REPORT-006 (the figures with their disclosures), SPK-UX-008 partial
 * completion (a figure the API could not compute is marked "Not available" with its reason, never
 * zero, rule G13) and stale version (freshness and the as-of instant per metric). REP-03: how the
 * figures were read (`freshness.consistency`) and every module setting the report used, configured
 * or not, with the pending decision that sets it (`settings`; a value left to operators is never a
 * client default).
 * Rows are aggregates only; the API sends no person-level rows (rule G9, §4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatInstant, formatQuantity, formatScalar, shortId } from './format';
import { FRESHNESS_LABELS, POINT_IN_TIME_LABELS } from './labels';

type ReportResponse = Schema<'ReportResponse'>;
type MetricDefinition = Schema<'MetricDefinition'>;
type MetricValue = Schema<'ReportMetricValue'>;
type ReportColumn = Schema<'ReportColumn'>;
type ReportRow = Schema<'ReportRow'>;
type ReportSettingUse = Schema<'ReportSettingUse'>;

const CONSISTENCY_LABELS: Record<Schema<'ReportingConsistency'>, string> = {
  snapshot: 'Every figure was read in one consistent snapshot.',
  owner_reads:
    'Some figures were read by their owning module at the request instant, outside the snapshot.',
};

export function consistencyText(consistency: Schema<'ReportingConsistency'> | undefined): string {
  return consistency
    ? CONSISTENCY_LABELS[consistency]
    : 'Stored before reports were read in one snapshot.';
}

/** The module settings a report used (REP-03): configuration, never a client default. */
export function ReportSettings({ settings }: { settings: readonly ReportSettingUse[] }) {
  if (settings.length === 0) return null;
  return (
    <section className="ia-section" aria-label="Settings this report used">
      <h4>Settings this report used</h4>
      <ul>
        {settings.map((setting) => (
          <li key={setting.setting}>
            <StatusBadge
              tone={setting.configured ? 'info' : 'pending'}
              label={setting.configured ? 'configured' : 'not configured'}
            />{' '}
            {setting.setting}
            {setting.configured && setting.value !== null ? ` = ${setting.value}` : ''}.{' '}
            {setting.effect}{' '}
            <span className="caption">
              {setting.configured
                ? `Configured by the operator; ${setting.pendingDecision} is still pending.`
                : `Pending ${setting.pendingDecision}.`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function metricAnchor(metricKey: string, prefix = 'def'): string {
  return `${prefix}-${metricKey}`;
}

/** Every SPK-REPORT-001 field of one metric definition, in a disclosure widget. */
export function MetricDefinitionDetails({
  definition,
  anchorPrefix = 'def',
}: {
  definition: MetricDefinition;
  anchorPrefix?: string;
}) {
  const list = (items: readonly string[]) => (items.length > 0 ? items.join('; ') : 'none');
  return (
    <details className="ia-definition" id={metricAnchor(definition.metricKey, anchorPrefix)}>
      <summary>
        {definition.metricKey} {definition.name}{' '}
        <span className="caption">(version {definition.version})</span>
      </summary>
      <dl className="ia-dl">
        <dt>Business question</dt>
        <dd>{definition.businessQuestion}</dd>
        <dt>Grain</dt>
        <dd>{definition.grain}</dd>
        <dt>Numerator</dt>
        <dd>{definition.numerator}</dd>
        <dt>Denominator</dt>
        <dd>{definition.denominator}</dd>
        <dt>Time basis</dt>
        <dd>{definition.timeBasis}</dd>
        <dt>Exclusions</dt>
        <dd>{list(definition.exclusions)}</dd>
        <dt>Dimensions</dt>
        <dd>{list(definition.dimensions)}</dd>
        <dt>Currency</dt>
        <dd>
          {definition.currency === 'minor_units'
            ? 'Integer minor units with the currency named; never summed across currencies'
            : 'none'}
        </dd>
        <dt>Freshness</dt>
        <dd>{FRESHNESS_LABELS[definition.freshness]}</dd>
        <dt>Access scope</dt>
        <dd>{definition.accessScope}</dd>
        <dt>Unit</dt>
        <dd>{definition.unit}</dd>
        <dt>Requirements</dt>
        <dd>{list(definition.requirementIds)}</dd>
        <dt>Pending decisions</dt>
        <dd>{list(definition.pendingDecisions)}</dd>
      </dl>
    </details>
  );
}

export function MetricDefinitionList({
  definitions,
  title = 'Metric definitions',
  anchorPrefix,
}: {
  definitions: readonly MetricDefinition[];
  title?: string;
  anchorPrefix?: string;
}) {
  return (
    <section aria-label={title} className="ia-section">
      <h3>{title}</h3>
      {definitions.length === 0 ? (
        <p className="caption">The API listed no definitions for this report.</p>
      ) : (
        definitions.map((definition) => (
          <MetricDefinitionDetails
            key={`${definition.metricKey}-${definition.version}`}
            definition={definition}
            anchorPrefix={anchorPrefix}
          />
        ))
      )}
    </section>
  );
}

function ValueCard({
  value,
  definition,
  report,
}: {
  value: MetricValue;
  definition: MetricDefinition | undefined;
  report: ReportResponse;
}) {
  const dims = Object.entries(value.dimensions).filter(([key]) => key !== 'series');
  const available = value.value !== null;
  return (
    <li className="ia-value" data-testid={`metric-${value.metric}`}>
      <span className="row-title">{value.label}</span>
      {available ? (
        <span className="ia-figure">
          {formatQuantity(value.value as number, value.unit, value.currency)}
        </span>
      ) : (
        <span>
          <StatusBadge tone="warning" label="Not available" />{' '}
          <span className="caption">{value.unavailableReason ?? 'No reason was given.'}</span>
        </span>
      )}
      {dims.length > 0 ? (
        <span className="caption">{dims.map(([k, v]) => `${k}: ${v}`).join(' · ')}</span>
      ) : null}
      <span className="caption">
        {value.metric}
        {definition
          ? ` · freshness ${FRESHNESS_LABELS[definition.freshness]} as of ${formatInstant(report.asOf, report.scope.timezone)}`
          : ''}
        {definition ? (
          <>
            {' · '}
            <a href={`#${metricAnchor(value.metric, 'report-def')}`}>Definition</a>
          </>
        ) : null}
      </span>
    </li>
  );
}

function groupBySeries(values: readonly MetricValue[]): [string | null, MetricValue[]][] {
  const groups = new Map<string | null, MetricValue[]>();
  for (const value of values) {
    const series = value.dimensions.series ?? null;
    const list = groups.get(series) ?? [];
    list.push(value);
    groups.set(series, list);
  }
  return [...groups.entries()];
}

const SERIES_TITLES: Record<string, string> = {
  observed: 'Observed',
  forecast: 'Forecast (a separate series, never combined with observed demand)',
};

function cellText(column: ReportColumn, row: ReportRow, timezone: string | null): string {
  const value = row[column.key];
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'number') {
    if (column.type === 'minor_units') {
      const currency = typeof row.currency === 'string' ? row.currency : null;
      return formatQuantity(value, 'minor_units', currency);
    }
    if (['count', 'hours', 'ratio', 'minutes'].includes(column.type)) {
      return formatQuantity(value, column.type, null);
    }
  }
  if (column.type === 'instant' && typeof value === 'string') return formatInstant(value, timezone);
  if (column.type === 'id' && typeof value === 'string') return shortId(value);
  return formatScalar(value);
}

export function ReportTable({ report, title }: { report: ReportResponse; title: string }) {
  if (report.rows.length === 0) {
    return (
      <section className="state" aria-label={`${title}: no rows`}>
        <h3>No rows for this period</h3>
        <p>The report found no activity in this scope and period. The figures above still apply.</p>
      </section>
    );
  }
  return (
    <div className="ia-table-wrap" role="region" aria-label={`${title} table`} tabIndex={0}>
      <table className="ia-table">
        <caption>
          {title}: {report.rows.length} row{report.rows.length === 1 ? '' : 's'}
        </caption>
        <thead>
          <tr>
            {report.columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, index) => (
            <tr key={index}>
              {report.columns.map((column) => {
                const raw = row[column.key];
                return (
                  <td key={column.key} title={column.type === 'id' ? String(raw ?? '') : undefined}>
                    {cellText(column, row, report.scope.timezone)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportView({
  report,
  facilityName,
}: {
  report: ReportResponse;
  facilityName?: string | null;
}) {
  const definitions = new Map(report.metrics.map((m) => [m.metricKey, m]));
  const unavailable = report.values.filter((v) => v.value === null).length;
  const tz = report.scope.timezone;
  const period =
    report.scope.from && report.scope.to
      ? report.scope.from === report.scope.to
        ? report.scope.from
        : `${report.scope.from} to ${report.scope.to}`
      : null;
  return (
    <article className="ia-report" aria-labelledby="ia-report-title">
      <header>
        <h3 id="ia-report-title">{report.report.title}</h3>
        <dl className="ia-dl ia-dl-inline">
          <dt>Scope</dt>
          <dd>
            {report.scope.facilityId
              ? (facilityName ?? `Facility ${shortId(report.scope.facilityId)}`)
              : 'Whole organization'}
            {period ? `, ${period}` : ''}
            {tz ? ` (facility time zone ${tz})` : ''}
          </dd>
          <dt>As of</dt>
          <dd>{formatInstant(report.asOf, tz)}</dd>
          <dt>Produced</dt>
          <dd>{formatInstant(report.producedAt, tz)}</dd>
          <dt>Freshness</dt>
          <dd>
            {FRESHNESS_LABELS[report.freshness.class]}.{' '}
            {POINT_IN_TIME_LABELS[report.freshness.pointInTime]}. {report.freshness.note}
          </dd>
          <dt>Read</dt>
          <dd>{consistencyText(report.freshness.consistency)}</dd>
          {report.runId ? (
            <>
              <dt>Stored run</dt>
              <dd title={report.runId}>{shortId(report.runId)}</dd>
            </>
          ) : null}
          <dt>Requirements</dt>
          <dd>{report.report.requirementIds.join(', ')}</dd>
        </dl>
      </header>

      {unavailable > 0 ? (
        <p className="ia-partial" data-testid="partial-figures">
          <StatusBadge tone="warning" label="Partly available" /> {unavailable} of{' '}
          {report.values.length} figures are not available; each is marked with its reason.
        </p>
      ) : null}

      {groupBySeries(report.values).map(([series, values]) => (
        <section
          key={series ?? 'all'}
          className="ia-section"
          aria-label={series ? (SERIES_TITLES[series] ?? series) : 'Figures'}
        >
          <h4>{series ? (SERIES_TITLES[series] ?? series) : 'Figures'}</h4>
          <ul className="ia-values">
            {values.map((value, index) => (
              <ValueCard
                key={`${value.metric}-${index}`}
                value={value}
                definition={definitions.get(value.metric)}
                report={report}
              />
            ))}
          </ul>
        </section>
      ))}

      <ReportSettings settings={report.settings ?? []} />

      {report.disclosures.length > 0 ? (
        <section className="ia-section" aria-label="Disclosures">
          <h4>Disclosures</h4>
          <ul>
            {report.disclosures.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <ReportTable report={report} title={report.report.title} />

      <MetricDefinitionList
        definitions={report.metrics}
        title="Definitions of the metrics in this report"
        anchorPrefix="report-def"
      />
    </article>
  );
}

import { createHash } from 'node:crypto';
import type { ReportResponse, ReportRow } from '@sportspark/contracts';
import { canonicalHash } from '../../../kernel';

/**
 * Report digests and export rendering (SPK-REPORT-007).
 *
 * The result digest covers everything a reader relies on — report, parameters, as-of instant,
 * metric definition versions, values, columns, rows and disclosures — and nothing incidental (the
 * run id, the production instant, freshness), so the same evaluation always yields the same
 * digest and a reproduction can be compared to the original byte for byte.
 */
export function resultDigest(result: ReportResponse): string {
  return canonicalHash({
    report: result.report.key,
    parameters: result.parameters,
    asOf: result.asOf,
    scope: result.scope,
    metrics: result.metrics.map((m) => ({ id: m.id, hash: m.definitionHash })),
    values: result.values,
    columns: result.columns,
    rows: result.rows,
    disclosures: result.disclosures,
    // REP-03: the settings used change the figures; runs stored before REP-03 name none, and
    // their digests stay comparable.
    ...(result.settings.length > 0 ? { settings: result.settings } : {}),
  });
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** RFC 4180 cell, with spreadsheet formula injection neutralized for text cells. */
export function csvCell(value: ReportRow[string] | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

/**
 * One `#` preamble line as exactly one CSV cell (R3-REPORTING-09, §4.14). Preamble values carry
 * staff-entered text (space names in disclosures, parameters as JSON): a comma would otherwise end
 * the cell and let the rest start a new one a spreadsheet evaluates (`=...`). The whole line goes
 * through `csvCell`, so it is quoted whenever it holds a comma, quote or line break, and it always
 * starts with `#`, never with a formula prefix. Line breaks are folded into spaces first.
 */
export function csvPreambleLine(key: string, value: string): string {
  return csvCell(`# ${key}: ${value}`.replaceAll(/\r\n|\r|\n/g, ' '));
}

/**
 * CSV export: a `#` preamble carrying the report, as-of instant, freshness, every metric
 * definition field (SPK-REPORT-001) and the disclosures, each line one CSV cell, then the
 * aggregate table, then the metric values. Rows are aggregates; no person-level data is ever
 * exported (§4.14, rule G9).
 */
export function renderCsv(result: ReportResponse): string {
  const lines: string[] = [];
  const meta = (key: string, value: string) => lines.push(csvPreambleLine(key, value));
  meta('report', `${result.report.key} (${result.report.title})`);
  meta('as of', result.asOf);
  meta('produced at', result.producedAt);
  if (result.runId) meta('report run', result.runId);
  meta('scope', JSON.stringify(result.scope));
  meta('parameters', JSON.stringify(result.parameters));
  meta(
    'freshness',
    `${result.freshness.class}; point in time ${result.freshness.pointInTime}; ${result.freshness.note}`,
  );
  for (const m of result.metrics) {
    meta(
      `metric ${m.metricKey} v${m.version}`,
      [
        `name=${m.name}`,
        `question=${m.businessQuestion}`,
        `grain=${m.grain}`,
        `numerator=${m.numerator}`,
        `denominator=${m.denominator}`,
        `time basis=${m.timeBasis}`,
        `exclusions=${m.exclusions.join('; ') || 'none'}`,
        `dimensions=${m.dimensions.join('; ') || 'none'}`,
        `currency=${m.currency}`,
        `freshness=${m.freshness}`,
        `access=${m.accessScope}`,
      ].join(' | '),
    );
  }
  for (const u of result.settings) {
    meta(
      `setting ${u.setting}`,
      `${u.configured ? `configured ${u.value}` : 'not configured'} (${u.pendingDecision}); ${u.effect}`,
    );
  }
  for (const d of result.disclosures) meta('disclosure', d);
  lines.push(result.columns.map((c) => csvCell(c.key)).join(','));
  for (const row of result.rows) {
    lines.push(result.columns.map((c) => csvCell(row[c.key])).join(','));
  }
  lines.push('');
  lines.push(
    ['metric', 'label', 'value', 'unit', 'currency', 'dimensions', 'unavailable_reason'].join(','),
  );
  for (const v of result.values) {
    lines.push(
      [
        csvCell(v.metric),
        csvCell(v.label),
        csvCell(v.value),
        csvCell(v.unit),
        csvCell(v.currency),
        csvCell(Object.keys(v.dimensions).length ? JSON.stringify(v.dimensions) : null),
        csvCell(v.unavailableReason),
      ].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function renderJson(result: ReportResponse): string {
  // A run stored before REP-03 names no settings: render it exactly as it was authorized.
  const { settings, ...rest } = result;
  return `${JSON.stringify(settings.length > 0 ? result : rest, null, 2)}\n`;
}

export function renderExport(result: ReportResponse, format: 'csv' | 'json'): string {
  return format === 'csv' ? renderCsv(result) : renderJson(result);
}

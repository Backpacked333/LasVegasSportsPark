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
 * CSV export: a `#` preamble carrying the report, as-of instant, freshness, every metric
 * definition field (SPK-REPORT-001) and the disclosures, then the aggregate table, then the metric
 * values. Rows are aggregates; no person-level data is ever exported (§4.14, rule G9).
 */
export function renderCsv(result: ReportResponse): string {
  const lines: string[] = [];
  const meta = (key: string, value: string) =>
    lines.push(`# ${key}: ${value.replaceAll(/\r?\n/g, ' ')}`);
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
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function renderExport(result: ReportResponse, format: 'csv' | 'json'): string {
  return format === 'csv' ? renderCsv(result) : renderJson(result);
}

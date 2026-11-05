/**
 * The extraction's staging document for SCR-S-48 (§5.3, §5.4; the proposed neutral `staging-v1`
 * contract of packages/contracts/src/api/migration.ts). The document holds personal data: it is
 * parsed only to be sent, never rendered, logged or stored (§4.14). The API validates every row;
 * these checks only catch a file that is not a staging document before anything is sent.
 */
import type { Schema } from '@sportspark/api-client';

/** Rows per request the API accepts (`MAX_ROWS_PER_REQUEST` in the migration contract). */
export const MAX_ROWS_PER_REQUEST = 2000;

export interface StagingDocument {
  rows: Schema<'StagedRow'>[];
  csv: Schema<'CsvDocument'>[];
  controlTotals: Schema<'ControlTotals'>;
  extraction?: Schema<'ExtractionProvenance'>;
}

/**
 * Reads a staging-v1 document; returns a message when it is not one. A chunk appended to a
 * received batch carries rows only (`requireControlTotals: false`).
 */
export function parseStagingDocument(
  text: string,
  options: { requireControlTotals?: boolean } = {},
): StagingDocument | string {
  const requireControlTotals = options.requireControlTotals ?? true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'The file is not JSON. Choose the staging document the extraction produced.';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'The staging document must be a JSON object with rows or csv and controlTotals.';
  }
  const doc = parsed as Record<string, unknown>;
  const rows = doc.rows ?? [];
  const csv = doc.csv ?? [];
  if (!Array.isArray(rows) || !Array.isArray(csv)) return 'rows and csv must be lists.';
  const totals = doc.controlTotals;
  if (requireControlTotals && (!totals || typeof totals !== 'object')) {
    return 'The staging document needs controlTotals as the source reports them (§5.5).';
  }
  if (rows.length === 0 && csv.length === 0) return 'The staging document has no rows.';
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return `At most ${MAX_ROWS_PER_REQUEST} rows can be staged in one upload; stage the rest as chunks on the batch.`;
  }
  return {
    rows: rows as Schema<'StagedRow'>[],
    csv: csv as Schema<'CsvDocument'>[],
    controlTotals: (totals ?? {}) as Schema<'ControlTotals'>,
    ...(doc.extraction && typeof doc.extraction === 'object'
      ? { extraction: doc.extraction as Schema<'ExtractionProvenance'> }
      : {}),
  };
}

export async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

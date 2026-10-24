import { errors, type ImportEntityTypeValue, type StagedRow } from '@sportspark/contracts';

/**
 * CSV half of the neutral staging contract (staging-v1): RFC 4180 fields (quoted fields may hold
 * commas, line breaks and doubled quotes), LF or CRLF line ends, a header row of payload field
 * names plus an `external_id` column. Empty cells are absent fields; values stay strings and the
 * per-type payload schemas accept their CSV spelling (lists separated by `;`, integer minor units,
 * `true`/`false`). Refuses malformed input with VALIDATION_FAILED instead of guessing.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let i = 0;
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        const next = text[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          throw errors.validation('CSV: a closing quote must end the field.', { offset: i });
        }
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (fieldStarted || field.length > 0) {
        throw errors.validation('CSV: a quote may only open a field.', { offset: i });
      }
      quoted = true;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i += 1;
  }
  if (quoted) throw errors.validation('CSV: unterminated quoted field.');
  if (field.length > 0 || fieldStarted || row.length > 0) endRow();
  // Blank lines carry no record.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const HEADER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const EXTERNAL_ID_COLUMN = 'external_id';

/** Converts one CSV document into staged rows of the given entity type. */
export function csvToStagedRows(entityType: ImportEntityTypeValue, content: string): StagedRow[] {
  const table = parseCsv(content);
  const header = table[0];
  if (!header) throw errors.validation('CSV: a header row is required.', { entityType });
  const names = header.map((h) => h.trim());
  const seen = new Set<string>();
  for (const name of names) {
    if (!HEADER.test(name)) {
      throw errors.validation(`CSV: invalid column name "${name}".`, { entityType });
    }
    if (seen.has(name)) throw errors.validation(`CSV: duplicate column "${name}".`, { entityType });
    seen.add(name);
  }
  const idIndex = names.indexOf(EXTERNAL_ID_COLUMN);
  if (idIndex < 0) {
    throw errors.validation(`CSV: the "${EXTERNAL_ID_COLUMN}" column is required.`, {
      entityType,
    });
  }
  const out: StagedRow[] = [];
  for (let r = 1; r < table.length; r += 1) {
    const cells = table[r] as string[];
    if (cells.length !== names.length) {
      throw errors.validation('CSV: every record needs one value per column.', {
        entityType,
        record: r,
        expected: names.length,
        actual: cells.length,
      });
    }
    const externalId = (cells[idIndex] ?? '').trim();
    if (externalId.length === 0 || externalId.length > 200) {
      throw errors.validation('CSV: every record needs an external_id (1-200 characters).', {
        entityType,
        record: r,
      });
    }
    const payload: Record<string, unknown> = {};
    names.forEach((name, index) => {
      if (index === idIndex) return;
      const value = (cells[index] ?? '').trim();
      if (value.length > 0) payload[name] = value;
    });
    out.push({ entityType, externalId, payload });
  }
  return out;
}

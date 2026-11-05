import { createHash } from 'node:crypto';

/**
 * Checksums of the neutral staging contract (§5.4 "each batch must retain checksum").
 *
 *   payload hash  = SHA-256 of the canonical JSON of the payload (object keys sorted, no spaces);
 *   batch checksum = SHA-256 of the lines `<entityType>\t<externalId>\t<payload hash>\n`, sorted
 *                    in byte order — independent of row order and of how rows were chunked.
 *
 * The extraction step can compute the same value on its side and declare it when staging; the
 * batch is sealed only when the declared and computed checksums agree.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function payloadHash(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(payload));
}

export interface ChecksumRow {
  entityType: string;
  externalId: string;
  payloadHash: string;
}

export function batchChecksum(rows: readonly ChecksumRow[]): string {
  const lines = rows
    .map((row) => `${row.entityType}\t${row.externalId}\t${row.payloadHash}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(lines.join(''));
}

/** SCR-S-57 page paths below `/finance/accounting-exports` (record ids only, §4.14). */
import { ACCOUNTING_EXPORTS } from './meta';

const BASE = ACCOUNTING_EXPORTS.path;

export const ACCOUNTING_PATHS = {
  base: BASE,
  mappings: `${BASE}/mappings`,
  batch: (id: string) => `${BASE}/batches/${id}`,
} as const;

export const BATCHES_PREFIX = ['api', '/accounting-export-batches'] as const;
export const BATCH_PREFIX = ['api', '/accounting-export-batches/{id}'] as const;
export const MAPPINGS_PREFIX = ['api', '/accounting-mappings'] as const;

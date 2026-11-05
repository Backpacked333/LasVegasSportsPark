/** SCR-S-55 page paths below `/finance/point-of-sale` (record ids only, never names, §4.14). */
import { POINT_OF_SALE } from './meta';

const BASE = POINT_OF_SALE.path;

export const POS_PATHS = {
  base: BASE,
  products: `${BASE}/products`,
  session: (id: string) => `${BASE}/sessions/${id}`,
  sale: (id: string) => `${BASE}/sales/${id}`,
  receipt: (id: string) => `${BASE}/sales/${id}/receipt`,
} as const;

/** Query key prefix of one sale's read: every sale command refreshes it (useApiCommand invalidate). */
export const SALE_QUERY_PREFIX = ['api', '/pos-sales/{id}'] as const;

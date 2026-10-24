import type { CoreTables } from './core';
import type { CatalogTables } from './catalog';
import type { FacilitiesTables } from './facilities';
import type { IdentityTables } from './identity';
import type { SchedulingTables } from './scheduling';

export * from './core';
export * from './catalog';
export * from './facilities';
export * from './identity';
export * from './scheduling';

/**
 * The complete database type. Each module contributes its own table interfaces from
 * `./<module>.ts`; run `node scripts/regenerate-registrations.mjs` after adding one.
 */
export interface Database
  extends CoreTables, CatalogTables, FacilitiesTables, IdentityTables, SchedulingTables {}

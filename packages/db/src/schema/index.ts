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
 * `./<module>.ts` and adds exactly one `extends` entry here (keeps merges conflict-free).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extension point for module tables
export interface Database extends CoreTables, CatalogTables, FacilitiesTables, IdentityTables, SchedulingTables {}

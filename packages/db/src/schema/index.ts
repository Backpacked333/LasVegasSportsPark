import type { CoreTables } from './core';
import type { IdentityTables } from './identity';

export * from './core';
export * from './identity';

/**
 * The complete database type. Each module contributes its own table interfaces from
 * `./<module>.ts` and adds exactly one `extends` entry here (keeps merges conflict-free).
 */
export interface Database extends CoreTables, IdentityTables {}

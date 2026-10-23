import type { CoreTables } from './core';

export * from './core';

/**
 * The complete database type. Each module contributes its own table interfaces from
 * `./<module>.ts` and adds exactly one `extends` entry here (keeps merges conflict-free).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extension point for module tables
export interface Database extends CoreTables {}

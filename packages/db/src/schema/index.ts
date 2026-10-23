import type { CoreTables } from './core';
import type { SchedulingTables } from './scheduling';

export * from './core';
export * from './scheduling';

/**
 * The complete database type. Each module contributes its own table interfaces from
 * `./<module>.ts` and adds exactly one `extends` entry here (keeps merges conflict-free).
 */
export interface Database extends CoreTables, SchedulingTables {}

import type { CoreTables } from './core';
import type { CatalogTables } from './catalog';
import type { CommunicationsTables } from './communications';
import type { CompetitionTables } from './competition';
import type { EnrollmentTables } from './enrollment';
import type { FacilitiesTables } from './facilities';
import type { IdentityTables } from './identity';
import type { SchedulingTables } from './scheduling';

export * from './core';
export * from './catalog';
export * from './communications';
export * from './competition';
export * from './enrollment';
export * from './facilities';
export * from './identity';
export * from './scheduling';

/**
 * The complete database type. Each module contributes its own table interfaces from
 * `./<module>.ts`; run `node scripts/regenerate-registrations.mjs` after adding one.
 */
export interface Database
  extends
    CoreTables,
    CatalogTables,
    CommunicationsTables,
    CompetitionTables,
    EnrollmentTables,
    FacilitiesTables,
    IdentityTables,
    SchedulingTables {}

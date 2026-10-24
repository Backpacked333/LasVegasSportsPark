import type { CoreTables } from './core';
import type { CatalogTables } from './catalog';
import type { CommunicationsTables } from './communications';
import type { CompetitionMatchesTables } from './competition-matches';
import type { CompetitionTables } from './competition';
import type { EnrollmentTables } from './enrollment';
import type { EntryTables } from './entry';
import type { FacilitiesTables } from './facilities';
import type { FinanceTables } from './finance';
import type { IdentityTables } from './identity';
import type { MigrationTables } from './migration';
import type { ReportingTables } from './reporting';
import type { SchedulingTables } from './scheduling';
import type { WorkforceTables } from './workforce';

export * from './core';
export * from './catalog';
export * from './communications';
export * from './competition-matches';
export * from './competition';
export * from './enrollment';
export * from './entry';
export * from './facilities';
export * from './finance';
export * from './identity';
export * from './migration';
export * from './reporting';
export * from './scheduling';
export * from './workforce';

/**
 * The complete database type. Each module contributes its own table interfaces from
 * `./<module>.ts`; run `node scripts/regenerate-registrations.mjs` after adding one.
 */
export interface Database
  extends
    CoreTables,
    CatalogTables,
    CommunicationsTables,
    CompetitionMatchesTables,
    CompetitionTables,
    EnrollmentTables,
    EntryTables,
    FacilitiesTables,
    FinanceTables,
    IdentityTables,
    MigrationTables,
    ReportingTables,
    SchedulingTables,
    WorkforceTables {}

import type { CoreTables } from './core';
import type { AutomationTables } from './automation';
import type { CatalogWaiversTables } from './catalog-waivers';
import type { CatalogTables } from './catalog';
import type { CommunicationsSequencesTables } from './communications-sequences';
import type { CommunicationsTables } from './communications';
import type { CompetitionFieldTables } from './competition-field';
import type { CompetitionMatchesTables } from './competition-matches';
import type { CompetitionTables } from './competition';
import type { EnrollmentPackageGTables } from './enrollment-package-g';
import type { EnrollmentRostersTables } from './enrollment-rosters';
import type { EnrollmentTables } from './enrollment';
import type { EntryTables } from './entry';
import type { FacilitiesTables } from './facilities';
import type { FinanceAccountingTables } from './finance-accounting';
import type { FinancePosTables } from './finance-pos';
import type { FinanceTables } from './finance';
import type { IdentityTables } from './identity';
import type { MigrationTables } from './migration';
import type { ReportingTables } from './reporting';
import type { SchedulingTables } from './scheduling';
import type { SupportTables } from './support';
import type { WorkforceTables } from './workforce';

export * from './core';
export * from './automation';
export * from './catalog-waivers';
export * from './catalog';
export * from './communications-sequences';
export * from './communications';
export * from './competition-field';
export * from './competition-matches';
export * from './competition';
export * from './enrollment-package-g';
export * from './enrollment-rosters';
export * from './enrollment';
export * from './entry';
export * from './facilities';
export * from './finance-accounting';
export * from './finance-pos';
export * from './finance';
export * from './identity';
export * from './migration';
export * from './reporting';
export * from './scheduling';
export * from './support';
export * from './workforce';

/**
 * The complete database type. Each module contributes its own table interfaces from
 * `./<module>.ts`; run `node scripts/regenerate-registrations.mjs` after adding one.
 */
export interface Database
  extends
    CoreTables,
    AutomationTables,
    CatalogWaiversTables,
    CatalogTables,
    CommunicationsSequencesTables,
    CommunicationsTables,
    CompetitionFieldTables,
    CompetitionMatchesTables,
    CompetitionTables,
    EnrollmentPackageGTables,
    EnrollmentRostersTables,
    EnrollmentTables,
    EntryTables,
    FacilitiesTables,
    FinanceAccountingTables,
    FinancePosTables,
    FinanceTables,
    IdentityTables,
    MigrationTables,
    ReportingTables,
    SchedulingTables,
    SupportTables,
    WorkforceTables {}

import { AutomationModule } from './automation';
import { CatalogModule } from './catalog';
import { CommunicationsModule } from './communications';
import { CompetitionModule } from './competition';
import { EnrollmentModule } from './enrollment';
import { EntryModule } from './entry';
import { FacilitiesModule } from './facilities';
import { FinanceModule } from './finance';
import { IdentityModule } from './identity';
import { MigrationModule } from './migration';
import { ReportingModule } from './reporting';
import { SchedulingModule } from './scheduling';
import { SupportModule } from './support';
import { WorkforceModule } from './workforce';

/** Domain modules in dependency order (§4.2). */
export const DOMAIN_MODULES = [
  IdentityModule,
  CatalogModule,
  SchedulingModule,
  CompetitionModule,
  WorkforceModule,
  FacilitiesModule,
  CommunicationsModule,
  EnrollmentModule,
  FinanceModule,
  EntryModule,
  SupportModule,
  MigrationModule,
  ReportingModule,
  AutomationModule,
];

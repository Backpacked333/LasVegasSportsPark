import { Module } from '@nestjs/common';
import { PRINCIPAL_RESOLVER_IMPL, RELATIONSHIP_AUTHORITY_IMPL } from '../../kernel';
import { AccessReviewsController } from './controllers/access-reviews.controller';
import { AccountsController } from './controllers/accounts.controller';
import { ClaimsController } from './controllers/claims.controller';
import { DuplicatesController } from './controllers/duplicates.controller';
import { HouseholdsController } from './controllers/households.controller';
import { InvitationsController } from './controllers/invitations.controller';
import { MeController } from './controllers/me.controller';
import { PeopleController } from './controllers/people.controller';
import { RelationshipsController } from './controllers/relationships.controller';
import {
  StaffDirectoryController,
  StaffMembershipsController,
} from './controllers/staff-memberships.controller';
import {
  AUTHORITY_LOOKUP_PORT,
  PERSON_DIRECTORY_PORT,
  STAFF_DIRECTORY_PORT,
} from './identity.ports';
import { AccessReviewsService } from './services/access-reviews.service';
import { AccountsService } from './services/accounts.service';
import { AuthorityReadsService } from './services/authority-reads.service';
import { ClaimsService } from './services/claims.service';
import { DuplicatesService } from './services/duplicates.service';
import { HouseholdsService } from './services/households.service';
import { IdentityJobs } from './services/identity-jobs';
import { InvitationsService } from './services/invitations.service';
import { PeopleService } from './services/people.service';
import { PrincipalResolver } from './services/principal-resolver.service';
import { RelationshipAuthority } from './services/relationship-authority.service';
import { RelationshipsService } from './services/relationships.service';
import { StaffMembershipsService } from './services/staff-memberships.service';

/**
 * IdentityModule (specification §3.1 SPK-IAM-001..007, §4.4 Identity, §4.5, §4.14).
 * Registers the kernel's principal resolver and relationship authority (both IMPL tokens through
 * useExisting), exposes ports other modules consume (person directory IF-09, authority lookup
 * IF-20/IF-46, staff directory) and its periodic jobs (ID-07, ID-08). See README.md.
 */
@Module({
  controllers: [
    PeopleController,
    AccountsController,
    HouseholdsController,
    RelationshipsController,
    InvitationsController,
    ClaimsController,
    StaffMembershipsController,
    StaffDirectoryController,
    AccessReviewsController,
    DuplicatesController,
    MeController,
  ],
  providers: [
    PeopleService,
    AccountsService,
    HouseholdsService,
    RelationshipsService,
    InvitationsService,
    ClaimsService,
    StaffMembershipsService,
    AccessReviewsService,
    DuplicatesService,
    AuthorityReadsService,
    IdentityJobs,
    PrincipalResolver,
    RelationshipAuthority,
    { provide: PRINCIPAL_RESOLVER_IMPL, useExisting: PrincipalResolver },
    { provide: RELATIONSHIP_AUTHORITY_IMPL, useExisting: RelationshipAuthority },
    { provide: PERSON_DIRECTORY_PORT, useExisting: PeopleService },
    { provide: AUTHORITY_LOOKUP_PORT, useExisting: RelationshipAuthority },
    { provide: STAFF_DIRECTORY_PORT, useExisting: StaffMembershipsService },
  ],
  exports: [
    PeopleService,
    AccountsService,
    HouseholdsService,
    RelationshipsService,
    InvitationsService,
    ClaimsService,
    StaffMembershipsService,
    AccessReviewsService,
    DuplicatesService,
    AuthorityReadsService,
    PrincipalResolver,
    RelationshipAuthority,
    PRINCIPAL_RESOLVER_IMPL,
    RELATIONSHIP_AUTHORITY_IMPL,
    PERSON_DIRECTORY_PORT,
    AUTHORITY_LOOKUP_PORT,
    STAFF_DIRECTORY_PORT,
  ],
})
export class IdentityModule {}

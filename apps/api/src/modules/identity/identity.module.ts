import { Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { GrantPermissionValue } from '@sportspark/db';
import {
  PRINCIPAL_RESOLVER_IMPL,
  RELATIONSHIP_AUTHORITY_IMPL,
  type PrincipalResolverPort,
  type RelationshipAuthorityPort,
  type VerifiedIdentity,
} from '../../kernel';
import { AccessReviewsController } from './controllers/access-reviews.controller';
import { AccountsController } from './controllers/accounts.controller';
import { ClaimsController } from './controllers/claims.controller';
import { DuplicatesController } from './controllers/duplicates.controller';
import { HouseholdsController } from './controllers/households.controller';
import { InvitationsController } from './controllers/invitations.controller';
import { PeopleController } from './controllers/people.controller';
import { RelationshipsController } from './controllers/relationships.controller';
import { StaffMembershipsController } from './controllers/staff-memberships.controller';
import {
  AUTHORITY_LOOKUP_PORT,
  PERSON_DIRECTORY_PORT,
  STAFF_DIRECTORY_PORT,
} from './identity.ports';
import { AccessReviewsService } from './services/access-reviews.service';
import { AccountsService } from './services/accounts.service';
import { ClaimsService } from './services/claims.service';
import { DuplicatesService } from './services/duplicates.service';
import { HouseholdsService } from './services/households.service';
import { InvitationsService } from './services/invitations.service';
import { PeopleService } from './services/people.service';
import { PrincipalResolver } from './services/principal-resolver.service';
import { RelationshipAuthority } from './services/relationship-authority.service';
import { RelationshipsService } from './services/relationships.service';
import { StaffMembershipsService } from './services/staff-memberships.service';

/**
 * Kernel workaround: the kernel resolves `*_IMPL` tokens through a lazy Proxy that Nest probes
 * for `then` while providers are still being instantiated. A class/factory/useExisting provider
 * is `null` at that moment and the probe crashes, so only `useValue` providers can back the
 * tokens. These handles are plain values that delegate to the real services once the module has
 * initialized (most recently initialized application wins; applications are closed in order).
 */
class LateBound<T extends object> {
  private readonly bound: T[] = [];

  bind(impl: T): void {
    this.bound.push(impl);
  }

  unbind(impl: T): void {
    const index = this.bound.lastIndexOf(impl);
    if (index >= 0) this.bound.splice(index, 1);
  }

  current(): T {
    const impl = this.bound[this.bound.length - 1];
    if (!impl) throw new Error('IdentityModule has not been initialized');
    return impl;
  }
}

const principalResolverHandle = new LateBound<PrincipalResolver>();
const relationshipAuthorityHandle = new LateBound<RelationshipAuthority>();

const PRINCIPAL_RESOLVER_VALUE: PrincipalResolverPort = {
  resolve: (identity: VerifiedIdentity) => principalResolverHandle.current().resolve(identity),
};
const RELATIONSHIP_AUTHORITY_VALUE: RelationshipAuthorityPort = {
  hasPermission: (
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    permission: GrantPermissionValue,
  ) =>
    relationshipAuthorityHandle
      .current()
      .hasPermission(organizationId, actorPersonId, subjectPersonId, permission),
};

/**
 * IdentityModule (specification §3.1 SPK-IAM-001..007, §4.4 Identity, §4.5, §4.14).
 * Registers the kernel's principal resolver and relationship authority, and exposes ports other
 * modules consume (person directory, authority lookup, staff directory). See README.md.
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
    AccessReviewsController,
    DuplicatesController,
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
    PrincipalResolver,
    RelationshipAuthority,
    { provide: PRINCIPAL_RESOLVER_IMPL, useValue: PRINCIPAL_RESOLVER_VALUE },
    { provide: RELATIONSHIP_AUTHORITY_IMPL, useValue: RELATIONSHIP_AUTHORITY_VALUE },
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
    PrincipalResolver,
    RelationshipAuthority,
    PRINCIPAL_RESOLVER_IMPL,
    RELATIONSHIP_AUTHORITY_IMPL,
    PERSON_DIRECTORY_PORT,
    AUTHORITY_LOOKUP_PORT,
    STAFF_DIRECTORY_PORT,
  ],
})
export class IdentityModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly resolver: PrincipalResolver,
    private readonly authority: RelationshipAuthority,
  ) {}

  onModuleInit(): void {
    principalResolverHandle.bind(this.resolver);
    relationshipAuthorityHandle.bind(this.authority);
  }

  onModuleDestroy(): void {
    principalResolverHandle.unbind(this.resolver);
    relationshipAuthorityHandle.unbind(this.authority);
  }
}

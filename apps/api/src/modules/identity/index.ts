export * from './identity.module';
export * from './identity.actions';
export * from './identity.events';
export * from './identity.ports';
export * from './identity.machines';
export {
  isGrantEffective,
  isWithinEffectiveDates,
  ageInYears,
  ADULT_AGE_YEARS,
} from './identity.shared';
export { PeopleService } from './services/people.service';
export { AccountsService } from './services/accounts.service';
export { HouseholdsService } from './services/households.service';
export { RelationshipsService } from './services/relationships.service';
export { InvitationsService } from './services/invitations.service';
export { ClaimsService } from './services/claims.service';
export { StaffMembershipsService } from './services/staff-memberships.service';
export { AccessReviewsService } from './services/access-reviews.service';
export { DuplicatesService, type MergeSummary } from './services/duplicates.service';
export { PrincipalResolver, buildPrincipal } from './services/principal-resolver.service';
export {
  RelationshipAuthority,
  CHILD_SELF_EXCLUDED,
} from './services/relationship-authority.service';
export * from './testing/identity-fixtures';

import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  AddContactPointBody,
  CreatePersonBody,
  IssueClaimBody,
  MakePrimaryContactPointBody,
  PersonNamesQuery,
  RemoveContactPointBody,
  SearchPeopleQuery,
  UpdatePersonBody,
  z,
  type Claim,
  type ContactPoint,
  type ContactPointRemoved,
  type Me,
  type Page,
  type PersonAuthority,
  type PersonDetail,
  type PersonName,
  type PersonSearchResult,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  RecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { AuthorityReadsService } from '../services/authority-reads.service';
import { ClaimsService } from '../services/claims.service';
import { PeopleService } from '../services/people.service';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import { StaffMembershipsService } from '../services/staff-memberships.service';

const IdParams = z.object({ id: z.uuid() });
const ContactPointParams = z.object({ id: z.uuid(), contactPointId: z.uuid() });

@Controller()
export class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly claims: ClaimsService,
    private readonly staff: StaffMembershipsService,
    private readonly authority: RelationshipAuthority,
    private readonly reads: AuthorityReadsService,
  ) {}

  /** GET /v1/me — who am I and what may I currently do (SPK-IAM-001/003). */
  @Get('me')
  async me(@CurrentPrincipal() principal: Principal): Promise<Me> {
    const organizationId = principal.organizationId;
    const personId = principal.personId;
    const [person, staffMemberships, authorities] =
      organizationId && personId
        ? await Promise.all([
            this.people.getPerson(principal, personId).then((p) => ({
              id: p.id,
              kind: p.kind,
              givenName: p.givenName,
              familyName: p.familyName,
              dateOfBirth: p.dateOfBirth,
              status: p.status,
              mergedIntoPersonId: p.mergedIntoPersonId,
              revision: p.revision,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
            })),
            this.staff.listForPerson(organizationId, personId),
            this.authority.authoritiesOf(organizationId, personId),
          ])
        : [null, [], []];
    return {
      principal: {
        kind: principal.kind,
        organizationId: principal.organizationId,
        accountId: principal.accountId,
        personId: principal.personId,
        staffRoles: principal.staffRoles,
        facilityIds: principal.facilityIds,
      },
      person,
      staffMemberships,
      authorities,
    };
  }

  @Post('people')
  @Idempotent()
  createPerson(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreatePersonBody) body: z.infer<typeof CreatePersonBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PersonDetail> {
    return this.people.createPerson(principal, body, correlationId);
  }

  /** GET /v1/person-names (ID-02): names only; people the caller may not view are omitted. */
  @Get('person-names')
  async personNames(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(PersonNamesQuery) query: z.infer<typeof PersonNamesQuery>,
  ): Promise<{ items: PersonName[] }> {
    return { items: await this.people.personNames(principal, query.ids) };
  }

  /** GET /v1/people (ID-02): staff search by name prefix or exact contact. */
  @Get('people')
  searchPeople(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(SearchPeopleQuery) query: z.infer<typeof SearchPeopleQuery>,
  ): Promise<Page<PersonSearchResult>> {
    return this.people.searchPeople(principal, query);
  }

  /** GET /v1/people/{id}/authority (ID-04): relationships, grants, households, claims (staff). */
  @Get('people/:id/authority')
  authorityOf(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PersonAuthority> {
    return this.reads.personAuthority(principal, params.id);
  }

  @Get('people/:id')
  getPerson(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PersonDetail> {
    return this.people.getPerson(principal, params.id);
  }

  @Patch('people/:id')
  @Idempotent()
  updatePerson(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdatePersonBody) body: z.infer<typeof UpdatePersonBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PersonDetail> {
    return this.people.updatePerson(principal, params.id, body, correlationId);
  }

  @Post('people/:id/contact-points')
  @Idempotent()
  addContactPoint(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AddContactPointBody) body: z.infer<typeof AddContactPointBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ContactPoint> {
    return this.people.addContactPoint(principal, params.id, body, correlationId);
  }

  /** ID-06: classified for §5.6 like POST /people/{id}/contact-points (person, unproven). */
  @Post('people/:id/contact-points/:contactPointId/make-primary')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('person')
  makePrimaryContactPoint(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(ContactPointParams) params: z.infer<typeof ContactPointParams>,
    @ZodBody(MakePrimaryContactPointBody) body: z.infer<typeof MakePrimaryContactPointBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ContactPoint> {
    return this.people.makePrimaryContactPoint(
      principal,
      params.id,
      params.contactPointId,
      body,
      correlationId,
    );
  }

  @Post('people/:id/contact-points/:contactPointId/remove')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('person')
  removeContactPoint(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(ContactPointParams) params: z.infer<typeof ContactPointParams>,
    @ZodBody(RemoveContactPointBody) body: z.infer<typeof RemoveContactPointBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ContactPointRemoved> {
    return this.people.removeContactPoint(
      principal,
      params.id,
      params.contactPointId,
      body,
      correlationId,
    );
  }

  @Post('people/:id/claims')
  // §4.14: the claim token is stored only as a hash; never keep it with the idempotency key.
  @Idempotent({ withhold: ['token'] })
  issueClaim(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(IssueClaimBody) body: z.infer<typeof IssueClaimBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Claim & { token: string }> {
    return this.claims.issue(principal, params.id, body, correlationId);
  }
}

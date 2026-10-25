import { Controller, Get, Patch, Post } from '@nestjs/common';
import {
  AddContactPointBody,
  CreatePersonBody,
  IssueClaimBody,
  UpdatePersonBody,
  z,
  type Claim,
  type ContactPoint,
  type Me,
  type PersonDetail,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { ClaimsService } from '../services/claims.service';
import { PeopleService } from '../services/people.service';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import { StaffMembershipsService } from '../services/staff-memberships.service';

const IdParams = z.object({ id: z.uuid() });

@Controller()
export class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly claims: ClaimsService,
    private readonly staff: StaffMembershipsService,
    private readonly authority: RelationshipAuthority,
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

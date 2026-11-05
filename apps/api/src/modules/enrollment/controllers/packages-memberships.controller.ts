import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateMembershipSuspensionBody,
  EndMembershipSuspensionBody,
  ListMembershipSuspensionsQuery,
  ListMyMembershipsQuery,
  ListMyPackageEntitlementsQuery,
  ListPackageEntitlementsQuery,
  RenewMembershipBody,
  ReversePackageRedemptionBody,
  z,
  type Basket,
  type Membership,
  type MembershipSuspension,
  type PackageEntitlement,
  type Page,
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
import { CorrelationId } from '../enrollment.shared';
import { MembershipsService } from '../services/memberships.service';
import { PackageEntitlementsService } from '../services/package-entitlements.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Session packages (ENR-11, capability session_packages: DEC-016, DEC-074) and memberships
 * (ENR-12, capability memberships: DEC-016, DEC-072). Booking with a package credit or a
 * membership is POST /v1/session-bookings with `packageEntitlementId` or `membershipEnrollmentId`.
 */
@Controller()
export class PackagesMembershipsController {
  constructor(
    private readonly packages: PackageEntitlementsService,
    private readonly memberships: MembershipsService,
  ) {}

  @Get('me/package-entitlements')
  myPackages(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyPackageEntitlementsQuery) query: ListMyPackageEntitlementsQuery,
  ): Promise<Page<PackageEntitlement>> {
    return this.packages.listMine(principal, query);
  }

  @Get('package-entitlements')
  packageList(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListPackageEntitlementsQuery) query: ListPackageEntitlementsQuery,
  ): Promise<Page<PackageEntitlement>> {
    return this.packages.list(principal, query);
  }

  /** Makeup and package entitlements are credits for record-authority purposes (§5.3). */
  @Post('package-redemptions/:id/reverse')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('credit')
  reverse(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ReversePackageRedemptionBody) body: z.infer<typeof ReversePackageRedemptionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PackageEntitlement> {
    return this.packages.reverse(principal, params.id, body, correlationId);
  }

  @Get('me/memberships')
  myMemberships(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyMembershipsQuery) query: ListMyMembershipsQuery,
  ): Promise<Page<Membership>> {
    return this.memberships.listMine(principal, query);
  }

  /** GAPS-TRIAGE-02: staff who may suspend the membership read its suspensions (ids, revisions). */
  @Get('enrollments/:id/membership-suspensions')
  suspensions(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(ListMembershipSuspensionsQuery) query: ListMembershipSuspensionsQuery,
  ): Promise<Page<MembershipSuspension>> {
    return this.memberships.listSuspensions(principal, params.id, query);
  }

  @Post('enrollments/:id/membership-suspensions')
  @Idempotent()
  @RecordAuthority('program')
  suspend(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateMembershipSuspensionBody) body: z.infer<typeof CreateMembershipSuspensionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MembershipSuspension> {
    return this.memberships.suspend(principal, params.id, body, correlationId);
  }

  @Post('membership-suspensions/:id/end')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('program')
  endSuspension(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(EndMembershipSuspensionBody) body: z.infer<typeof EndMembershipSuspensionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<MembershipSuspension> {
    return this.memberships.endSuspension(principal, params.id, body, correlationId);
  }

  @Post('enrollments/:id/renew')
  @Idempotent()
  @RecordAuthority('program')
  renew(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RenewMembershipBody) body: z.infer<typeof RenewMembershipBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Basket> {
    return this.memberships.renew(principal, params.id, body, correlationId);
  }
}

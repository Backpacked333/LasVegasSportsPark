import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CancelOfferingSessionBody,
  CopyOfferingBody,
  CreateOfferingBody,
  CreateOfferingSessionBody,
  CreatePriceRuleBody,
  ListFacilitySessionsQuery,
  ListPublicOfferingsQuery,
  OfferingTransitionBody,
  UpdateOfferingBody,
  z,
  type FacilitySession,
  type Offering,
  type OfferingListItem,
  type OfferingSession,
  type Page,
  type PriceRule,
  type Principal,
  type PublicationCheck,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  Public,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../catalog.shared';
import { OfferingsService } from '../services/offerings.service';
import { PriceRulesService } from '../services/price-rules.service';
import { SessionsService } from '../services/sessions.service';

const IdParams = z.object({ id: z.uuid() });
type Transition = z.infer<typeof OfferingTransitionBody>;

/** Offerings, their sessions and price rules (SPK-CAT-001..004, SPK-PAY-001). */
@Controller()
export class OfferingsController {
  constructor(
    private readonly offerings: OfferingsService,
    private readonly sessions: SessionsService,
    private readonly priceRules: PriceRulesService,
  ) {}

  @Post('offerings')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateOfferingBody) body: z.infer<typeof CreateOfferingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Offering> {
    return this.offerings.create(principal, body, correlationId);
  }

  /**
   * Discovery: published offerings, child-safe fields only (§4.14); `view=staff` lists every
   * state with staff details for holders of catalog.manage_offerings in their facilities (CAT-01).
   */
  @Get('offerings')
  @Public()
  listPublic(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListPublicOfferingsQuery) query: ListPublicOfferingsQuery,
  ): Promise<Page<OfferingListItem>> {
    return this.offerings.listPublic(principal, query);
  }

  /** CAT-01 (SPK-CAT-004): what publish would report, with nothing written. */
  @Get('offerings/:id/publication-check')
  publicationCheck(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PublicationCheck> {
    return this.offerings.publicationCheck(principal, params.id);
  }

  /** CAT-01 (SPK-SCHED-008): a facility's sessions in a window of at most 31 days (staff). */
  @Get('sessions')
  listFacilitySessions(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListFacilitySessionsQuery) query: ListFacilitySessionsQuery,
  ): Promise<Page<FacilitySession>> {
    return this.sessions.listAtFacility(principal, query);
  }

  @Get('offerings/:id')
  @Public()
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Offering> {
    return this.offerings.get(principal, params.id);
  }

  @Patch('offerings/:id')
  @HttpCode(200)
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateOfferingBody) body: z.infer<typeof UpdateOfferingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Offering> {
    return this.offerings.update(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/publish')
  @HttpCode(200)
  @Idempotent()
  publish(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OfferingTransitionBody) body: Transition,
    @CorrelationId() correlationId: string | null,
  ): Promise<Offering> {
    return this.offerings.publish(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/registration/open')
  @HttpCode(200)
  @Idempotent()
  openRegistration(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OfferingTransitionBody) body: Transition,
    @CorrelationId() correlationId: string | null,
  ): Promise<Offering> {
    return this.offerings.openRegistration(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/registration/pause')
  @HttpCode(200)
  @Idempotent()
  pauseRegistration(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OfferingTransitionBody) body: Transition,
    @CorrelationId() correlationId: string | null,
  ): Promise<Offering> {
    return this.offerings.pauseRegistration(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/registration/resume')
  @HttpCode(200)
  @Idempotent()
  resumeRegistration(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OfferingTransitionBody) body: Transition,
    @CorrelationId() correlationId: string | null,
  ): Promise<Offering> {
    return this.offerings.resumeRegistration(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/close')
  @HttpCode(200)
  @Idempotent()
  close(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OfferingTransitionBody) body: Transition,
    @CorrelationId() correlationId: string | null,
  ): Promise<Offering> {
    return this.offerings.close(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/archive')
  @HttpCode(200)
  @Idempotent()
  archive(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OfferingTransitionBody) body: Transition,
    @CorrelationId() correlationId: string | null,
  ): Promise<Offering> {
    return this.offerings.archive(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/copy')
  @Idempotent()
  copy(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CopyOfferingBody) body: z.infer<typeof CopyOfferingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Offering> {
    return this.offerings.copy(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/sessions')
  @Idempotent()
  addSession(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateOfferingSessionBody) body: z.infer<typeof CreateOfferingSessionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<OfferingSession> {
    return this.sessions.create(principal, params.id, body, correlationId);
  }

  @Get('offerings/:id/sessions')
  @Public()
  listSessions(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<OfferingSession[]> {
    return this.sessions.list(principal, params.id);
  }

  @Post('sessions/:id/cancel')
  @HttpCode(200)
  @Idempotent()
  cancelSession(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CancelOfferingSessionBody) body: z.infer<typeof CancelOfferingSessionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<OfferingSession> {
    return this.sessions.cancel(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/price-rules')
  @Idempotent()
  createPriceRule(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreatePriceRuleBody) body: z.infer<typeof CreatePriceRuleBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PriceRule> {
    return this.priceRules.create(principal, params.id, body, correlationId);
  }

  @Get('offerings/:id/price-rules')
  listPriceRules(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PriceRule[]> {
    return this.priceRules.list(principal, params.id);
  }
}

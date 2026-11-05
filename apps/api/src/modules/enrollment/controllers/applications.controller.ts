import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateApplicationBody,
  DecideApplicationBody,
  DeclineApplicationBody,
  ListApplicationsQuery,
  OverrideEligibilityBody,
  WithdrawApplicationBody,
  z,
  type Application,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { ApplicationsService } from '../services/applications.service';

const IdParams = z.object({ id: z.uuid() });

/** Applications (§4.4 Application, SPK-REG-001/002/003/007/009). */
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateApplicationBody) body: z.infer<typeof CreateApplicationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Application> {
    return this.applications.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListApplicationsQuery) query: ListApplicationsQuery,
  ): Promise<Page<Application>> {
    return this.applications.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Application> {
    return this.applications.get(principal, params.id);
  }

  @Post(':id/override-eligibility')
  @HttpCode(200)
  @Idempotent()
  override(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OverrideEligibilityBody) body: z.infer<typeof OverrideEligibilityBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Application> {
    return this.applications.overrideEligibility(principal, params.id, body, correlationId);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @Idempotent()
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DecideApplicationBody) body: z.infer<typeof DecideApplicationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Application> {
    return this.applications.accept(principal, params.id, body, correlationId);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @Idempotent()
  decline(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DeclineApplicationBody) body: z.infer<typeof DeclineApplicationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Application> {
    return this.applications.decline(principal, params.id, body, correlationId);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Idempotent()
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawApplicationBody) body: z.infer<typeof WithdrawApplicationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Application> {
    return this.applications.withdraw(principal, params.id, body, correlationId);
  }
}

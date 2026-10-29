import { Controller, Get, Post } from '@nestjs/common';
import {
  ApproveCreditBody,
  CollectInstallmentBody,
  CreateContributionRequestBody,
  CreateObligationBody,
  CreateSettlementReconciliationBody,
  CurrencyCode,
  ExtendInstallmentBody,
  IssueCreditBody,
  ListCreditsQuery,
  ListObligationsQuery,
  PayContributionBody,
  PayObligationBody,
  RecordCashTenderBody,
  ReconciliationReportQuery,
  RedeemCreditBody,
  z,
  type CashTender,
  type ContributionRequest,
  type Credit,
  type InstallmentPlan,
  type LedgerBalance,
  type Obligation,
  type Page,
  type PaymentOutcome,
  type Principal,
  type ReconciliationReport,
  type SettlementReconciliation,
} from '@sportspark/contracts';
import {
  AllowedDuringRecovery,
  CurrentPrincipal,
  Idempotent,
  RefusedDuringRecovery,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../finance.shared';
import { CashTendersService } from '../services/cash-tenders.service';
import { CreditsService } from '../services/credits.service';
import { InstallmentsService } from '../services/installments.service';
import { ObligationsService } from '../services/obligations.service';
import { ReconciliationService } from '../services/reconciliation.service';

const IdParams = z.object({ id: z.uuid() });
const BalancesQuery = z.object({ currency: CurrencyCode.default('USD') });

/** Obligations, team contributions and payments toward them (SPK-PAY-004/005, SPK-AT-022). */
@RefusedDuringRecovery()
@Controller()
export class ObligationsController {
  constructor(private readonly obligations: ObligationsService) {}

  @Post('obligations')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateObligationBody) body: z.infer<typeof CreateObligationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Obligation> {
    return this.obligations.create(principal, body, correlationId);
  }

  @Get('obligations')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListObligationsQuery) query: z.infer<typeof ListObligationsQuery>,
  ): Promise<Page<Obligation>> {
    return this.obligations.list(principal, query);
  }

  @Get('obligations/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Obligation> {
    return this.obligations.get(principal, params.id);
  }

  @Post('obligations/:id/payments')
  @Idempotent()
  pay(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(PayObligationBody) body: z.infer<typeof PayObligationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PaymentOutcome> {
    return this.obligations.pay(principal, params.id, body, correlationId);
  }

  @Post('obligations/:id/contribution-requests')
  @Idempotent()
  requestContribution(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateContributionRequestBody) body: z.infer<typeof CreateContributionRequestBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ContributionRequest> {
    return this.obligations.requestContribution(principal, params.id, body, correlationId);
  }

  @Get('contribution-requests/:id')
  getContribution(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<ContributionRequest> {
    return this.obligations.getContribution(principal, params.id);
  }

  @Post('contribution-requests/:id/pay')
  @Idempotent()
  payContribution(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(PayContributionBody) body: z.infer<typeof PayContributionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PaymentOutcome> {
    return this.obligations.payContribution(principal, params.id, body, correlationId);
  }
}

/** Credits (SPK-PAY-009). */
@RefusedDuringRecovery()
@Controller('credits')
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Post()
  @Idempotent()
  issue(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(IssueCreditBody) body: z.infer<typeof IssueCreditBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Credit> {
    return this.credits.issue(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListCreditsQuery) query: z.infer<typeof ListCreditsQuery>,
  ): Promise<Page<Credit>> {
    return this.credits.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Credit> {
    return this.credits.get(principal, params.id);
  }

  @Post(':id/redeem')
  @Idempotent()
  redeem(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RedeemCreditBody) body: z.infer<typeof RedeemCreditBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Credit> {
    return this.credits.redeem(principal, params.id, body, correlationId);
  }

  @Post(':id/approve')
  @Idempotent()
  approve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ApproveCreditBody) body: z.infer<typeof ApproveCreditBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Credit> {
    return this.credits.approve(principal, params.id, body, correlationId);
  }
}

/** Installment plans (SPK-PAY-006). */
@RefusedDuringRecovery()
@Controller()
export class InstallmentsController {
  constructor(private readonly installments: InstallmentsService) {}

  @Get('installment-plans/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<InstallmentPlan> {
    return this.installments.get(principal, params.id);
  }

  @Post('installments/:id/collect')
  @Idempotent()
  collect(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CollectInstallmentBody) body: z.infer<typeof CollectInstallmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<InstallmentPlan> {
    return this.installments.collect(principal, params.id, body, correlationId);
  }

  @Post('installments/:id/extend')
  @Idempotent()
  extend(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ExtendInstallmentBody) body: z.infer<typeof ExtendInstallmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<InstallmentPlan> {
    return this.installments.extend(principal, params.id, body, correlationId);
  }
}

/** Cash tenders (SPK-PAY-012), settlement reconciliation and reports (SPK-PAY-010/011). */
@RefusedDuringRecovery()
@Controller()
export class ReconciliationController {
  constructor(
    private readonly tenders: CashTendersService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Post('cash-tenders')
  @Idempotent()
  recordTender(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordCashTenderBody) body: z.infer<typeof RecordCashTenderBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CashTender> {
    return this.tenders.record(principal, body, correlationId);
  }

  // §5.8, SPK-AT-028: reconciling provider facts is how recovery ends.
  @AllowedDuringRecovery()
  @Post('settlement-reconciliations')
  @Idempotent()
  reconcile(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateSettlementReconciliationBody)
    body: z.infer<typeof CreateSettlementReconciliationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<SettlementReconciliation> {
    return this.reconciliation.create(principal, body, correlationId);
  }

  @Get('finance/reconciliation-report')
  report(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ReconciliationReportQuery) query: z.infer<typeof ReconciliationReportQuery>,
  ): Promise<ReconciliationReport> {
    return this.reconciliation.report(principal, query);
  }

  @Get('finance/ledger-balances')
  balances(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(BalancesQuery) query: z.infer<typeof BalancesQuery>,
  ): Promise<LedgerBalance[]> {
    return this.reconciliation.ledgerBalances(principal, query.currency);
  }
}

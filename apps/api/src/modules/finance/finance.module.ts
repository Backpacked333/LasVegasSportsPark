import {
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EventPayload } from '@sportspark/contracts';
import {
  APP_CONFIG,
  BackgroundWorkers,
  INTEGRATION_REGISTRY,
  PeriodicJobRegistry,
  RecoveryChecks,
  EventHandlerRegistry,
  Inbox,
  moduleSettings,
  runWithTransaction,
  type AppConfig,
  type IntegrationRegistryPort,
} from '../../kernel';
import { CatalogModule } from '../catalog';
import { CommunicationsModule } from '../communications';
import { CompetitionModule, FINANCIAL_CONDITIONS_IMPL } from '../competition';
import { EnrollmentModule, FINANCE_POLICY_IMPL } from '../enrollment';
// IF-39: entry declares the port finance provides; its declaration file is imported directly
// because entry's module imports finance (an import of entry's index would be a cycle).
import { FINANCIAL_STANDING_IMPL } from '../entry/entry.ports';
import { IdentityModule } from '../identity';
import { AccountingController } from './controllers/accounting.controller';
import {
  CheckoutsController,
  MeMoneyController,
  OrdersController,
  QuotesController,
} from './controllers/checkouts.controller';
import { PosSalesController, PosSetupController } from './controllers/pos.controller';
import {
  CreditsController,
  InstallmentsController,
  ObligationsController,
  ReconciliationController,
} from './controllers/accounts.controller';
import { PaymentWebhooksController, PaymentsController } from './controllers/payments.controller';
import {
  CheckoutExpiryDue,
  CheckoutPaymentReceived,
  ContributionRequested,
  InstallmentFailed,
  InstallmentNotice,
  InstallmentNoticeDue,
  PaymentFailed,
  RefundSettled,
} from './finance.events';
import { FinanceSettings } from './finance.settings';
import { DEFAULT_FINANCE_POLICY, FINANCE_POLICY_CONFIG } from './finance.policy';
import {
  ACCOUNTING_EXPORT_PORT,
  PAYMENT_PROVIDER_PORT,
  RECORD_AUTHORITY_IMPL,
  RECORD_AUTHORITY_PORT,
  type AccountingExportPort,
  type PaymentProviderPort,
  type RecordAuthorityPort,
} from './finance.ports';
import { LedgerService } from './ledger/ledger.service';
import {
  FAKE_ACCOUNTING_PROVIDER,
  FakeAccountingProvider,
} from './providers/fake-accounting.provider';
import { FAKE_PAYMENTS_PROVIDER, FakePaymentProvider } from './providers/fake-payment.provider';
import {
  AccountingExportService,
  RECONCILE_ACCOUNTING_JOB,
} from './services/accounting/accounting-export.service';
import { CashTendersService } from './services/cash-tenders.service';
import { CheckoutFinalizer } from './services/checkout-finalizer.service';
import { CheckoutService } from './services/checkout.service';
import { CreditsService } from './services/credits.service';
import { FinanceCustomerScope } from './services/customer-scope';
import { FinanceNotices } from './services/finance-notices.service';
import { FinancialStandingService } from './services/financial-standing.service';
import { MoneyReadsService } from './services/money-reads.service';
import { PosSaleFinalizer } from './services/pos/pos-sale-finalizer.service';
import { PosSalesService } from './services/pos/pos-sales.service';
import { PosSetupService } from './services/pos/pos-setup.service';
import { FinancePolicyAdapter } from './services/finance-policy.adapter';
import { ParticipationStandingService } from './services/participation-standing.service';
import { FinancePolicyResolver } from './services/finance-policy.resolver';
import { FinanceWorker } from './services/finance-worker';
import { InstallmentsService } from './services/installments.service';
import { MoneyFacts } from './services/money-facts.service';
import { ObligationsService } from './services/obligations.service';
import { PaymentWebhooksService } from './services/payment-webhooks.service';
import { PaymentsService } from './services/payments.service';
import { QuotesService } from './services/quotes.service';
import { ReconciliationService } from './services/reconciliation.service';
import { RefundsService } from './services/refunds.service';
import { financeRecoveryBlockers } from './services/finance-recovery.check';

/**
 * RECORD_AUTHORITY_PORT (§5.6, §4.7 invariant 11): the migration module's authority guard, found
 * at call time (no import cycle). Only "no implementation registered" (the migration module is
 * not loaded, so no assignment exists) means SportsPark is authoritative; any other failure is
 * rethrown. A found implementation is cached.
 */
function lazyRecordAuthority(moduleRef: ModuleRef): RecordAuthorityPort {
  const logger = new Logger('Finance');
  let impl: RecordAuthorityPort | null = null;
  let warned = false;
  return {
    assertNoLegacyAuthorityInEffect: async (organizationId, category, trx) => {
      if (!impl) {
        try {
          impl = moduleRef.get<RecordAuthorityPort>(RECORD_AUTHORITY_IMPL, { strict: false });
        } catch (error) {
          if (error instanceof Error && /Nest could not find/.test(error.message)) {
            if (!warned) {
              warned = true;
              logger.warn('no RECORD_AUTHORITY_IMPL registered: SportsPark is authoritative');
            }
            return;
          }
          throw error;
        }
      }
      await impl.assertNoLegacyAuthorityInEffect(organizationId, category, trx);
    },
  };
}

const providers: Provider[] = [
  {
    provide: RECORD_AUTHORITY_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): RecordAuthorityPort => lazyRecordAuthority(moduleRef),
  },
  // Policy values the specification leaves to operators (DEC-007/008/009): proposed defaults,
  // overridden by approved catalog policy versions (FinancePolicyResolver).
  { provide: FINANCE_POLICY_CONFIG, useValue: DEFAULT_FINANCE_POLICY },
  // Provider-selection gate (§5.2, DEC-019): only the deterministic fake exists; it is refused in
  // production so no real money is ever "taken" by a fake.
  FakePaymentProvider,
  // IF-37 (declared by stage 3; FIN-07 uses it): the accounting connection is not selected
  // (DEC-022); only the deterministic fake exists, refused in production like the payment fake.
  FakeAccountingProvider,
  {
    provide: ACCOUNTING_EXPORT_PORT,
    inject: [APP_CONFIG, FakeAccountingProvider],
    useFactory: (config: AppConfig, fake: FakeAccountingProvider): AccountingExportPort => {
      if (config.NODE_ENV === 'production') {
        throw new Error(
          'No accounting connection is selected (specification §5.2, DEC-022): implement the adapter behind AccountingExportPort before production.',
        );
      }
      return fake;
    },
  },
  {
    provide: PAYMENT_PROVIDER_PORT,
    inject: [APP_CONFIG, FakePaymentProvider],
    useFactory: (config: AppConfig, fake: FakePaymentProvider): PaymentProviderPort => {
      if (config.NODE_ENV === 'production') {
        throw new Error(
          'No payment processor is selected (specification §5.2, DEC-019): implement the adapter behind PaymentProviderPort before production.',
        );
      }
      return fake;
    },
  },
  LedgerService,
  FinancePolicyResolver,
  MoneyFacts,
  PaymentsService,
  RefundsService,
  CreditsService,
  ObligationsService,
  InstallmentsService,
  QuotesService,
  CheckoutFinalizer,
  CheckoutService,
  CashTendersService,
  ReconciliationService,
  PaymentWebhooksService,
  FinanceWorker,
  // Enrollment's FinancePolicyPort (transfer/cancellation consequences), resolved lazily there.
  FinancePolicyAdapter,
  { provide: FINANCE_POLICY_IMPL, useExisting: FinancePolicyAdapter },
  // Fixture readiness "Applicable financial conditions" (SPK-READY-001).
  ParticipationStandingService,
  { provide: FINANCIAL_CONDITIONS_IMPL, useExisting: ParticipationStandingService },
  // FIN-03, IF-39: entry's arrival checks read real balances (SPK-ENTRY-004); entry's approved
  // policy decides whether one blocks (POL-017, DEC-056).
  FinancialStandingService,
  { provide: FINANCIAL_STANDING_IMPL, useExisting: FinancialStandingService },
  // FIN-01/02: customer and staff money lists.
  FinanceCustomerScope,
  MoneyReadsService,
  // FIN-05: finance-owned customer notices (IF-22).
  FinanceNotices,
  // FIN-06: point of sale (capability point_of_sale, DEC-016, DEC-079).
  PosSaleFinalizer,
  PosSetupService,
  PosSalesService,
  // FIN-07: accounting export (capability accounting, DEC-016, DEC-081; connection DEC-022).
  moduleSettings(FinanceSettings.module),
  AccountingExportService,
];

/**
 * FinanceModule (specification §3.15 SPK-PAY-001..012, §4.4 Finance + Accounting support, §4.6
 * PaymentAttempt / Refund / Checkout machines, §4.7 invariants 5, 6, 7, §4.11, §4.12). Owns
 * quotes, orders, obligations, contribution requests, payment attempts, receipts, refunds and
 * refundable funds, credits and redemptions, the journal subledger, allocations, installment
 * plans, cash tenders, settlement reconciliations and checkouts. Reads baskets, enrollments and
 * capacity only through enrollment's ports (and holds a basket through its exported command),
 * prices and policies through catalog's ports, people through identity's directory and team
 * entries through competition's query port. Never writes another module's tables. See README.md.
 */
@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    CompetitionModule,
    CommunicationsModule,
    EnrollmentModule,
  ],
  providers,
  controllers: [
    QuotesController,
    CheckoutsController,
    OrdersController,
    MeMoneyController,
    PosSetupController,
    PosSalesController,
    AccountingController,
    PaymentsController,
    PaymentWebhooksController,
    ObligationsController,
    CreditsController,
    InstallmentsController,
    ReconciliationController,
  ],
  exports: [
    PAYMENT_PROVIDER_PORT,
    FakePaymentProvider,
    ACCOUNTING_EXPORT_PORT,
    FakeAccountingProvider,
    FINANCE_POLICY_CONFIG,
    LedgerService,
    FinancePolicyResolver,
    MoneyFacts,
    PaymentsService,
    RefundsService,
    CreditsService,
    ObligationsService,
    InstallmentsService,
    QuotesService,
    CheckoutFinalizer,
    CheckoutService,
    CashTendersService,
    ReconciliationService,
    FinanceWorker,
    ParticipationStandingService,
    FinancialStandingService,
    MoneyReadsService,
    PosSalesService,
    PosSetupService,
    AccountingExportService,
  ],
})
export class FinanceModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly backgroundWorkers: BackgroundWorkers,
    private readonly registry: EventHandlerRegistry,
    private readonly inbox: Inbox,
    private readonly finalizer: CheckoutFinalizer,
    private readonly installments: InstallmentsService,
    private readonly webhooks: PaymentWebhooksService,
    private readonly worker: FinanceWorker,
    private readonly recoveryChecks: RecoveryChecks,
    private readonly notices: FinanceNotices,
    private readonly posSales: PosSaleFinalizer,
    private readonly accounting: AccountingExportService,
    private readonly periodicJobs: PeriodicJobRegistry,
    @Inject(INTEGRATION_REGISTRY) private readonly integrations: IntegrationRegistryPort,
  ) {}

  onModuleInit(): void {
    // §5.1, §5.2 (FIN-02, FIN-07; K-09): the adapters finance runs, all deterministic fakes refused
    // in production; their outcomes are reconciled by the finance operator.
    this.integrations.register({
      id: 'finance.payment_provider',
      gate: 'payments',
      port: 'PAYMENT_PROVIDER_PORT',
      adapter: { name: FAKE_PAYMENTS_PROVIDER, kind: 'fake' },
      productionAllowed: false,
      scenarios: ['success', 'failure', 'timeout_unknown', 'duplicate'],
      reconciliationOwner: 'finance_operator',
    });
    this.integrations.register({
      id: 'finance.accounting_export',
      gate: 'accounting',
      port: 'ACCOUNTING_EXPORT_PORT',
      adapter: { name: FAKE_ACCOUNTING_PROVIDER, kind: 'fake' },
      productionAllowed: false,
      scenarios: ['success', 'failure', 'timeout_unknown', 'duplicate'],
      reconciliationOwner: 'finance_operator',
    });
    // FIN-07 (§4.12, IF-24): an unknown or stale submitted batch is asked about, never stranded.
    this.periodicJobs.register({
      name: RECONCILE_ACCOUNTING_JOB,
      intervalSeconds: 60,
      failureOwner: 'finance_operator',
      run: (context) => this.accounting.reconcile(context),
    });
    // §5.8, SPK-AT-028: after a restore, normal operation resumes only once payment and refund
    // facts are reconciled with the provider.
    this.recoveryChecks.register('finance.provider_facts', financeRecoveryBlockers);
    // §4.1, §4.12: the provider-facing poll loop belongs to the worker process (worker.ts starts
    // every registered background worker); request-serving API processes never run it. Tests
    // drive `runOnce()` directly.
    this.backgroundWorkers.register({
      name: 'finance.provider_worker',
      start: () => this.worker.start(),
      stop: () => this.worker.stop(),
    });
    // Handlers run in the dispatcher's transaction; binding it as the active transaction makes
    // every port read (enrollment, catalog, identity) go through it, never a second connection.

    // §4.11 step 8 as durable follow-up (SPK-AT-023): a stopped worker or a failed handler is
    // retried; finalization is idempotent (a completed checkout is left alone).
    this.registry.on<EventPayload<typeof CheckoutPaymentReceived>>(
      CheckoutPaymentReceived.type,
      'finance.finalize_checkout',
      (event, ctx) =>
        runWithTransaction(ctx.trx, async () => {
          await this.finalizer.finalizeInTrx(
            ctx.trx,
            event.organizationId,
            event.payload.checkoutId,
            event.correlationId,
          );
        }),
      { failureOwner: 'finance_operator' },
    );
    // An awaiting checkout whose hold expired and that holds no live payment is aborted.
    this.registry.on<EventPayload<typeof CheckoutExpiryDue>>(
      CheckoutExpiryDue.type,
      'finance.abort_expired_checkout',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () =>
          this.finalizer.onExpiryDue(
            ctx.trx,
            event.organizationId,
            event.payload.checkoutId,
            event.correlationId,
          ),
        ),
      { failureOwner: 'finance_operator' },
    );
    // A compensation refund that settled completes (or re-opens) its checkout's recovery.
    this.registry.on<EventPayload<typeof RefundSettled>>(
      RefundSettled.type,
      'finance.complete_compensation',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () =>
          this.finalizer.onRefundSettled(
            ctx.trx,
            event.organizationId,
            event.payload,
            event.correlationId,
          ),
        ),
      { failureOwner: 'finance_operator' },
    );
    // SPK-PAY-006 notices before an installment falls due.
    this.registry.on<EventPayload<typeof InstallmentNoticeDue>>(
      InstallmentNoticeDue.type,
      'finance.record_installment_notice',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () =>
          this.installments.onNoticeDue(
            ctx.trx,
            event.organizationId,
            event.payload.installmentId,
            event.correlationId,
          ),
        ),
      { failureOwner: 'finance_operator' },
    );
    // FIN-05 (SPK-COMMS-002, SPK-PAY-004, SPK-PAY-006): finance composes its own notices in the
    // handler's transaction, one per event (IF-22).
    this.registry.on<EventPayload<typeof ContributionRequested>>(
      ContributionRequested.type,
      'finance.notify_contribution_requested',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () => this.notices.contributionRequested(ctx.trx, event)),
      { failureOwner: 'finance_operator' },
    );
    this.registry.on<EventPayload<typeof PaymentFailed>>(
      PaymentFailed.type,
      'finance.notify_payment_failed',
      (event, ctx) => runWithTransaction(ctx.trx, () => this.notices.paymentFailed(ctx.trx, event)),
      { failureOwner: 'finance_operator' },
    );
    this.registry.on<EventPayload<typeof InstallmentFailed>>(
      InstallmentFailed.type,
      'finance.notify_installment_failed',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () => this.notices.installmentFailed(ctx.trx, event)),
      { failureOwner: 'finance_operator' },
    );
    this.registry.on<EventPayload<typeof InstallmentNotice>>(
      InstallmentNotice.type,
      'finance.notify_installment_due',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () => this.notices.installmentNotice(ctx.trx, event)),
      { failureOwner: 'finance_operator' },
    );
    // FIN-06: a failed card refund of a point-of-sale return is owned by the finance operator.
    this.registry.on<EventPayload<typeof RefundSettled>>(
      RefundSettled.type,
      'finance.pos_return_refund_outcome',
      (event, ctx) =>
        runWithTransaction(ctx.trx, () =>
          this.posSales.onRefundSettled(ctx.trx, event.organizationId, event.payload),
        ),
      { failureOwner: 'finance_operator' },
    );
    // Provider evidence through the kernel inbox: duplicates consumed once, reordering tolerated.
    this.inbox.on(FAKE_PAYMENTS_PROVIDER, 'finance.apply_payment_event', (event, ctx) =>
      runWithTransaction(ctx.trx, async () => {
        await this.webhooks.apply(ctx.trx, event);
      }),
    );
  }

  onModuleDestroy(): void {
    this.worker.stop();
  }
}

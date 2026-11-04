import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../kernel';
import { InstallmentsService } from './installments.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

export interface FinanceWorkerSummary {
  refundsExecuted: number;
  refundsReconciled: number;
  /** Abandoned payment challenges canceled at the provider (SPK-PAY-007, DEC-019 pending). */
  paymentsCanceled: number;
  paymentsReconciled: number;
  installmentsCollected: number;
}

/**
 * The provider-facing half of finance's durable work (§4.11 step 10, §4.12). Outbox handlers run
 * inside a transaction and therefore never call the provider; this worker does, OUTSIDE any
 * transaction: it executes requested refunds (customer and compensation), cancels abandoned payment
 * challenges, reconciles payment and refund attempts whose outcome is still unknown or stale, and
 * collects due installments. Every step is idempotent (provider idempotency keys, state-machine
 * guards), so several workers and restarts never double-charge or double-refund. Tests drive
 * `runOnce()`.
 */
@Injectable()
export class FinanceWorker {
  private readonly logger = new Logger(FinanceWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** The pass in flight, so `stop` can wait for it (R3-OPERATIONS-10). */
  private inFlight: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly refunds: RefundsService,
    private readonly payments: PaymentsService,
    private readonly installments: InstallmentsService,
  ) {}

  async runOnce(): Promise<FinanceWorkerSummary> {
    const refunds = await this.refunds.runPending();
    const paymentsCanceled = await this.payments.cancelAbandoned();
    const paymentsReconciled = await this.payments.reconcileStale();
    const installmentsCollected = await this.installments.collectDue();
    return {
      refundsExecuted: refunds.executed,
      refundsReconciled: refunds.reconciled,
      paymentsCanceled,
      paymentsReconciled,
      installmentsCollected,
    };
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.inFlight = (async () => {
        try {
          await this.runOnce();
        } catch (error) {
          this.logger.error(`finance worker pass failed: ${String(error)}`);
        } finally {
          this.running = false;
          this.inFlight = null;
        }
      })();
    };
    this.timer = setInterval(tick, Math.max(this.config.OUTBOX_POLL_INTERVAL_MS, 1000) * 5);
  }

  /**
   * R3-OPERATIONS-10 (§4.12, §5.8): starts no further pass and resolves once the pass in flight
   * has recorded its outcomes, so a provider call is not cut off by the process exit. The kernel
   * awaits it, bounded by WORKER_SHUTDOWN_TIMEOUT_MS.
   */
  stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.inFlight ?? Promise.resolve();
  }
}

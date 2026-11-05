import { Injectable } from '@nestjs/common';
import type {
  AccountingBatchStatusResult,
  AccountingBatchSubmission,
  AccountingExportPort,
  AccountingSubmitResult,
} from '../finance.ports';

export const FAKE_ACCOUNTING_PROVIDER = 'fake-accounting';

/**
 * Scripted behaviour of the next NEW submissions (default `accept`):
 * - `accept` / `reject`: the provider records and answers the outcome;
 * - `timeout_accepted`: the provider records the batch as accepted but the answer is lost
 *   (`unknown`; `batchStatus` later reports it accepted);
 * - `timeout_lost`: the request never arrives (`unknown`; `batchStatus` reports `not_found`).
 */
export type FakeAccountingOutcome = 'accept' | 'reject' | 'timeout_accepted' | 'timeout_lost';

interface FakeBatch {
  idempotencyKey: string;
  organizationId: string;
  batchId: string;
  checksum: string;
  result: AccountingSubmitResult;
}

/**
 * Deterministic fake accounting connection (§5.2: no accounting system is selected, DEC-022;
 * IF-37). A repeated submission with the same idempotency key returns the first recorded outcome
 * and never records a second batch, the property a real connection must also provide.
 */
@Injectable()
export class FakeAccountingProvider implements AccountingExportPort {
  readonly name = FAKE_ACCOUNTING_PROVIDER;
  private readonly batches = new Map<string, FakeBatch>();
  private readonly script: FakeAccountingOutcome[] = [];
  /** Every submitBatch call, including repeats (tests assert on it). */
  readonly submissions: AccountingBatchSubmission[] = [];

  reset(): void {
    this.batches.clear();
    this.script.length = 0;
    this.submissions.length = 0;
  }

  /** The next new submissions, in order, behave like this. */
  scriptSubmissions(...outcomes: FakeAccountingOutcome[]): void {
    this.script.push(...outcomes);
  }

  /** Distinct batches the provider recorded. */
  recordedBatches(): number {
    return this.batches.size;
  }

  static referenceFor(idempotencyKey: string): string {
    return `fa_${idempotencyKey}`;
  }

  async submitBatch(submission: AccountingBatchSubmission): Promise<AccountingSubmitResult> {
    this.submissions.push(submission);
    const existing = this.batches.get(submission.idempotencyKey);
    // Duplicate: the first recorded outcome, never a second batch.
    if (existing) return existing.result;
    const outcome = this.script.shift() ?? 'accept';
    const accepted: AccountingSubmitResult = {
      outcome: 'accepted',
      providerReference: FakeAccountingProvider.referenceFor(submission.idempotencyKey),
    };
    switch (outcome) {
      case 'accept':
        this.record(submission, accepted);
        return accepted;
      case 'reject': {
        const rejected: AccountingSubmitResult = {
          outcome: 'rejected',
          error: 'fake accounting: the batch was rejected',
        };
        this.record(submission, rejected);
        return rejected;
      }
      case 'timeout_accepted':
        this.record(submission, accepted);
        return { outcome: 'unknown', error: 'fake accounting: no answer within the timeout' };
      case 'timeout_lost':
        return { outcome: 'unknown', error: 'fake accounting: the request did not arrive' };
    }
  }

  async batchStatus(query: {
    organizationId: string;
    batchId: string;
    idempotencyKey: string;
  }): Promise<AccountingBatchStatusResult> {
    const batch = this.batches.get(query.idempotencyKey);
    if (!batch || batch.organizationId !== query.organizationId) return { outcome: 'not_found' };
    return batch.result;
  }

  private record(submission: AccountingBatchSubmission, result: AccountingSubmitResult): void {
    this.batches.set(submission.idempotencyKey, {
      idempotencyKey: submission.idempotencyKey,
      organizationId: submission.organizationId,
      batchId: submission.batchId,
      checksum: submission.checksum,
      result,
    });
  }
}
